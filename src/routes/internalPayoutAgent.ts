/**
 * internalPayoutAgent router
 *
 * GET  /internal/payout-agent/status    fleet + intent counters
 * POST /internal/payout-agent/poll      claim pending intents
 * POST /internal/payout-agent/result    report an outcome
 *
 * The Android USSD device agent is this surface's only client. It authenticates
 * with `Authorization: Bearer <PAYOUT_AGENT_KEY>` — timing-safe, throttled, and
 * failing closed while the secret is unset, exactly like the partner surface.
 * The agent dials the provider's USSD menu on the SIM it holds, feeds any PIN,
 * screens the transfer, and reports:
 *
 *   POST /result { id, status: "succeeded" | "failed" | "retry",
 *                  providerRef?, rawText?, error? }
 *
 * `status: "retry"` (or a poll timeout) returns the intent to PENDING while
 * attempts remain; the last error is kept either way. Reconciliation runs on a
 * 60s timer: claims older than PAYOUT_AGENT_CLAIM_TIMEOUT_MS (default 10 min)
 * are re-queued or finally failed, so an abandoned phone never wedges a payout.
 */

import { Prisma } from '@prisma/client';
import { Request, Response, Router } from 'express';
import { prisma } from '../utils/prisma';
import logger from '../utils/logger';
import { safeSecretEquals } from '../utils/secretCompare';
import { MemoryWindowCounter } from '../utils/expiringStore';
import { getRequestIp } from '../utils/requestIp';
import { canonicalProvider } from '../utils/payoutInput';
import { dialSpec, getUssdPayoutProvider, listUssdPayoutProviders } from '../config/payoutUssd';
import { agentPayload } from './payoutTransfers';
import { emitWorkspaceEvent } from '../utils/workspaceEvents';

const router = Router();

const AGENT_WINDOW_MS = 15 * 60 * 1000;
const AGENT_MAX_PER_IP = 2_000;
const agentAuthThrottle = new MemoryWindowCounter({ maxEntries: 20_000 });

const CLAIM_TIMEOUT_MS = Math.max(60_000, Number(process.env.PAYOUT_AGENT_CLAIM_TIMEOUT_MS ?? 10 * 60 * 1000));
const CONFIRM_TIMEOUT_MS = Math.max(60_000, Number(process.env.PAYOUT_AGENT_CONFIRM_TIMEOUT_MS ?? 5 * 60 * 1000));
const PENDING_GRACE_MS = Math.max(60_000, Number(process.env.PAYOUT_PENDING_GRACE_MS ?? 5 * 60 * 1000));
const MAX_NOTE_BYTES = 4_000;
const MAX_RESULT_EVENTS = 20;

// ─── Secret guard ─────────────────────────────────────────────────────────────

function agentSecretConfigured(): boolean {
    return Boolean(process.env.PAYOUT_AGENT_KEY && process.env.PAYOUT_AGENT_KEY.length >= 16);
}

function hasAgentSecret(req: Request): boolean {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) return false;
    return safeSecretEquals(header.slice(7), process.env.PAYOUT_AGENT_KEY);
}

router.use((req: Request, res: Response, next): void => {
    const ip = getRequestIp(req);
    if (agentAuthThrottle.increment(`ip:${ip}`, AGENT_WINDOW_MS).count > AGENT_MAX_PER_IP) {
        res.status(429).json({ error: 'rate_limited', message: 'Too many agent requests from this address. Try again later.' });
        return;
    }
    if (!agentSecretConfigured() || !hasAgentSecret(req)) {
        res.status(401).json({ error: 'unauthorized' });
        return;
    }
    next();
});

// ─── Shared helpers ───────────────────────────────────────────────────────────

async function appendEvent(id: string, entry: Record<string, unknown>): Promise<void> {
    try {
        const row = await prisma.payoutIntent.findUnique({ where: { id }, select: { events: true } });
        if (!row) return;
        const events = Array.isArray(row.events) ? (row.events as unknown[]) : [];
        events.push({ at: new Date().toISOString(), ...entry });
        await prisma.payoutIntent.update({
            where: { id },
            data: { events: events.slice(-MAX_RESULT_EVENTS) as Prisma.InputJsonValue },
        });
    } catch (error) {
        logger.error(`Failed to append payout intent event note for ${id}:`, error);
    }
}

function truncate(text: unknown, limit: number): string | null {
    if (typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (!trimmed) return null;
    return Buffer.byteLength(trimmed, 'utf8') > limit
        ? `${trimmed.slice(0, limit)}…`
        : trimmed;
}

async function settleSucceeded(id: string, providerRef: string | null, rawText: string | null): Promise<void> {
    const row = await prisma.payoutIntent.update({
        where: { id },
        data: {
            status: 'SUCCEEDED',
            providerRef: providerRef ?? undefined,
            settledAt: new Date(),
            lastError: null,
        },
    });
    await appendEvent(id, { kind: 'agent_result', status: 'succeeded', providerRef, rawText });
    void emitWorkspaceEvent(row.workspaceId, 'payout.succeeded', transferEventPayload(row));
}

async function settleFailed(id: string, errorText: string, rawText: string | null): Promise<void> {
    const row = await prisma.payoutIntent.update({
        where: { id },
        data: { status: 'FAILED', settledAt: new Date(), lastError: errorText },
    });
    await appendEvent(id, { kind: 'agent_result', status: 'failed', error: errorText, rawText });
    void emitWorkspaceEvent(row.workspaceId, 'payout.failed', transferEventPayload(row));
}

// ─── Routes ───────────────────────────────────────────────────────────────────

router.post('/poll', async (req: Request, res: Response): Promise<void> => {
    const device = typeof req.body?.device === 'string' ? req.body.device.trim().slice(0, 64) : '';
    if (!device) {
        res.status(422).json({ error: 'device is required (a stable name for this phone/modem).' });
        return;
    }

    const providerRaw = typeof req.body?.provider === 'string' ? req.body.provider : '';
    const provider = providerRaw ? canonicalProvider(providerRaw) : '';
    if (provider && (!getUssdPayoutProvider(provider) || !getUssdPayoutProvider(provider)!.enabled)) {
        res.status(422).json({ error: `provider is not enabled for USSD payouts.` });
        return;
    }

    const maxRaw = Number(req.body?.max ?? 5);
    const max = Math.min(Math.max(Number.isFinite(maxRaw) ? Math.trunc(maxRaw) : 5, 1), 10);

    try {
        const candidates = await prisma.payoutIntent.findMany({
            where: { status: 'PENDING', ...(provider ? { provider } : {}) },
            orderBy: { createdAt: 'asc' },
            take: max * 3,
        });

        const claimed: Array<Record<string, unknown>> = [];
        for (const candidate of candidates) {
            if (claimed.length >= max) break;
            const updated = await prisma.payoutIntent.updateMany({
                where: { id: candidate.id, status: 'PENDING', attempts: { lt: candidate.maxAttempts } },
                data: {
                    status: 'CLAIMED',
                    claimedAt: new Date(),
                    deviceHint: device,
                    attempts: { increment: 1 },
                },
            });
            if (updated.count === 1) {
                const row = await prisma.payoutIntent.findUniqueOrThrow({ where: { id: candidate.id } });
                claimed.push(agentPayload(row));
            }
        }
        // Candidates skipped here stay PENDING for the next poll of any device.
        // Never FAILED from the poll path: the reconciler settles exhaustion,
        // where it can be the sole judge that nobody will claim the row again.

        res.json({ success: true, device, transfers: claimed });
    } catch (error) {
        logger.error('Payout intent poll failed:', error);
        res.status(500).json({ error: 'poll_failed' });
    }
});

router.post('/result', async (req: Request, res: Response): Promise<void> => {
    const id = typeof req.body?.id === 'string' ? req.body.id : '';
    const status = typeof req.body?.status === 'string' ? req.body.status : '';
    const device = typeof req.body?.device === 'string' ? req.body.device.trim().slice(0, 64) : null;
    if (!id || !['succeeded', 'failed', 'retry', 'confirming'].includes(status)) {
        res.status(422).json({ error: 'id is required and status must be succeeded | failed | retry | confirming.' });
        return;
    }

    const providerRef = truncate(req.body?.providerRef, 191);
    const rawText = truncate(req.body?.rawText, MAX_NOTE_BYTES);
    const errorText = truncate(req.body?.error, MAX_NOTE_BYTES);

    try {
        const row = await prisma.payoutIntent.findUnique({ where: { id } });
        if (!row) {
            res.status(404).json({ error: 'not_found' });
            return;
        }
        if (row.status === 'SUCCEEDED' || row.status === 'FAILED' || row.status === 'CANCELED') {
            res.status(409).json({ error: 'already_settled', status: row.status });
            return;
        }

        if (status === 'confirming') {
            await prisma.payoutIntent.update({
                where: { id: row.id },
                data: { status: 'CONFIRMING', claimedAt: new Date() },
            });
            await appendEvent(row.id, {
                kind: 'agent_confirming',
                providerRef,
                rawText,
                device,
            });
            res.json({ success: true, status: 'CONFIRMING' });
            return;
        }

        if (status === 'succeeded') {
            // Accept the success from ANY live status: the row may have been
            // re-queued by the reconciler while this device was still dialling.
            // Money may already have moved, so dropping the result and letting
            // another agent re-dial would be a double payout — the only safe
            // read of a device-reported success is that the transfer happened.
            await settleSucceeded(row.id, providerRef, rawText);
            res.json({ success: true, status: 'SUCCEEDED' });
            return;
        }

        if (status === 'retry') {
            if (row.attempts >= row.maxAttempts) {
                await settleFailed(row.id, errorText ?? 'Device reported a retry beyond the attempt cap.', rawText);
                res.json({ success: true, status: 'FAILED' });
                return;
            }
            // Only PENDING/CLAIMED/CONFIRMING are mutable here (checked above);
            // this returns the row to the unclaimed queue for another agent.
            await prisma.payoutIntent.update({
                where: { id: row.id },
                data: { status: 'PENDING', lastError: errorText ?? 'Device reported a retry.', providerRef: null },
            });
            await appendEvent(row.id, { kind: 'agent_retry', error: errorText, rawText, device });
            res.json({ success: true, status: 'PENDING' });
            return;
        }

        // status === 'failed': no money moved, settle regardless of which live
        // state the row was in when the report arrived.
        await settleFailed(row.id, errorText ?? 'Device reported a failure.', rawText);
        res.json({ success: true, status: 'FAILED' });
    } catch (error) {
        logger.error('Payout intent result failed:', error);
        res.status(500).json({ error: 'result_failed' });
    }
});

router.get('/status', async (_req: Request, res: Response): Promise<void> => {
    try {
        const byStatus = await prisma.payoutIntent.groupBy({
            by: ['status', 'provider'],
            _count: { _all: true },
        });
        const now = Date.now();
        const providers = listUssdPayoutProviders().map((entry) => ({
            provider: entry.provider,
            displayName: entry.displayName,
            enabled: entry.enabled,
            ussdCode: entry.ussdCode,
        }));
        const staleClaims = await prisma.payoutIntent.count({
            where: {
                status: { in: ['CLAIMED', 'CONFIRMING'] },
                claimedAt: { lt: new Date(now - Math.min(CLAIM_TIMEOUT_MS, CONFIRM_TIMEOUT_MS)) },
            },
        });
        res.json({
            success: true,
            providers,
            recentDevices: await prisma.$queryRaw`
                SELECT "deviceHint" AS device, COUNT(*)::int AS count
                FROM "PayoutIntent"
                WHERE "deviceHint" IS NOT NULL AND "claimedAt" > NOW() - INTERVAL '24 hours'
                GROUP BY "deviceHint" ORDER BY count DESC LIMIT 20`,
            counters: {
                rows: byStatus.map((row) => ({ status: row.status, provider: row.provider, count: row._count._all })),
                staleClaims,
                claimTimeoutMs: CLAIM_TIMEOUT_MS,
            },
        });
    } catch (error) {
        logger.error('Payout agent status failed:', error);
        res.status(500).json({ error: 'status_failed' });
    }
});

// ─── Reconciler ───────────────────────────────────────────────────────────────

export async function reconcilePayoutIntents(): Promise<number> {
    const staleClaimed = await prisma.payoutIntent.findMany({
        where: { status: 'CLAIMED', claimedAt: { lt: new Date(Date.now() - CLAIM_TIMEOUT_MS) } },
        take: 100,
    });
    const staleConfirming = await prisma.payoutIntent.findMany({
        where: { status: 'CONFIRMING', claimedAt: { lt: new Date(Date.now() - CONFIRM_TIMEOUT_MS) } },
        take: 100,
    });
    // PENDING rows out of attempts have no claimer left — someone must fail them
    // or every funding caller sees a permanently pending transfer.
    const stalePending = await prisma.payoutIntent.findMany({
        where: {
            status: 'PENDING',
            createdAt: { lt: new Date(Date.now() - PENDING_GRACE_MS) },
        },
        take: 100,
    });

    let actions = 0;
    for (const row of stalePending) {
        // Only exhausted ones: a PENDING row with attempts left is simply
        // waiting for a poll, which agents may resume at any time.
        if (row.attempts >= row.maxAttempts) {
            const updated = await prisma.payoutIntent.updateMany({
                where: { id: row.id, status: 'PENDING' },
                data: { status: 'FAILED', settledAt: new Date(), lastError: 'Exhausted its attempts with no device result.' },
            });
            if (updated.count === 1) {
                await settleFailed(row.id, 'Exhausted its attempts with no device result.', null);
                actions += 1;
            }
        }
    }
    for (const row of staleClaimed) {
        if (row.attempts >= row.maxAttempts) {
            const updated = await prisma.payoutIntent.updateMany({
                where: { id: row.id, status: 'CLAIMED' },
                data: { status: 'FAILED', settledAt: new Date(), lastError: 'Exhausted its attempts with no device result.' },
            });
            if (updated.count === 1) {
                await settleFailed(row.id, 'Exhausted its attempts with no device result.', null);
                actions += 1;
            }
        } else {
            const updated = await prisma.payoutIntent.updateMany({
                where: { id: row.id, status: 'CLAIMED' },
                data: {
                    status: 'PENDING',
                    lastError: 'Device did not report a result; re-queued for the next agent.',
                },
            });
            if (updated.count === 1) {
                await appendEvent(row.id, { kind: 'reconciler_requeue', from: 'CLAIMED' });
                actions += 1;
            }
        }
    }
    for (const row of staleConfirming) {
        const updated = await prisma.payoutIntent.updateMany({
            where: { id: row.id, status: 'CONFIRMING' },
            data: { status: 'PENDING', lastError: 'Device never confirmed the dial; re-queued.' },
        });
        if (updated.count === 1) {
            await appendEvent(row.id, { kind: 'reconciler_requeue', from: 'CONFIRMING' });
            actions += 1;
        }
    }
    return actions;
}

let reconcilerTimer: NodeJS.Timeout | null = null;
let reconcilerRunning = false;
const RECONCILE_INTERVAL_MS = Math.max(10_000, Number(process.env.PAYOUT_RECONCILE_INTERVAL_MS ?? 60_000));

export function startPayoutIntentReconciler(): void {
    if (reconcilerTimer) return;
    reconcilerTimer = setInterval(() => {
        if (reconcilerRunning) return;
        reconcilerRunning = true;
        void reconcilePayoutIntents()
            .catch((error) => logger.error('Payout intent reconciliation failed:', error))
            .finally(() => {
                reconcilerRunning = false;
            });
    }, RECONCILE_INTERVAL_MS);
    reconcilerTimer.unref();
}

export default router;

function transferEventPayload(row: { id: string; workspaceId: string; provider: string; destination: string; amount: number; reference: string; providerRef?: string | null; lastError?: string | null }): Record<string, unknown> {
    return {
        intentId: row.id,
        provider: row.provider,
        // The destination is masked in events: webhooks fan out to third-party
        // receivers, and the full account number belongs in rows, not payloads.
        destination: `${row.destination.slice(0, 4)}**${row.destination.slice(-3)}`,
        amount: row.amount,
        reference: row.reference,
        providerRef: row.providerRef ?? null,
        lastError: row.lastError ?? null,
    };
}
