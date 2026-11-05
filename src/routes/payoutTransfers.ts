/**
 * payoutTransfers router
 *
 * POST   /payout-transfers          create a payout intent (idempotent on reference)
 * GET    /payout-transfers         list intents (status/provider filters)
 * GET    /payout-transfers/:id     read one intent
 * POST   /payout-transfers/:id/cancel   cancel a PENDING intent
 *
 * These intents are executed by the USSD device agent fleet, not by this
 * process: see routes/internalPayoutAgent.ts. Creation only validates that a
 * transfer is well-formed and queued; nothing is "sent" until an agent reports
 * a result. Outcomes fan out as `payout.succeeded` / `payout.failed` workspace
 * events.
 */

import { Prisma, PayoutIntentStatus } from '@prisma/client';
import { Request, Response, Router } from 'express';
import { prisma } from '../utils/prisma';
import logger from '../utils/logger';
import { canonicalProvider } from '../utils/payoutInput';
import {
    dialSpec,
    getUssdPayoutProvider,
    listUssdPayoutProviders,
    validatePayoutIntentAmount,
    validatePayoutIntentDestination,
} from '../config/payoutUssd';

const router = Router();

const REFERENCE_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const MAX_EVENT_NOTES = 200;

type AuthSource = 'DASHBOARD' | 'API_KEY';

function getAuthContext(req: Request): { workspaceId: string; source: AuthSource; apiKeyId: string | null } | null {
    const apiKeyData = (req as any).apiKeyData as { id: string; workspaceId: string } | null;
    const workspaceContext = (req as any).workspaceContext as {
        workspace: { id: string };
        source: 'dashboard' | 'api_key';
    } | null;

    if (workspaceContext?.source === 'dashboard') {
        return { workspaceId: workspaceContext.workspace.id, source: 'DASHBOARD', apiKeyId: null };
    }
    if (apiKeyData) {
        return { workspaceId: apiKeyData.workspaceId, source: 'API_KEY', apiKeyId: apiKeyData.id };
    }
    return null;
}

function maskDestination(destination: string): string {
    if (destination.length <= 8) return '*'.repeat(destination.length);
    return `${destination.slice(0, 4)}${'*'.repeat(Math.max(3, destination.length - 8))}${destination.slice(-4)}`;
}

function publicTransfer(row: Prisma.PayoutIntentGetPayload<Record<string, never>>): Record<string, unknown> {
    return {
        id: row.id,
        workspaceId: row.workspaceId,
        provider: row.provider,
        destination: maskDestination(row.destination),
        accountHolderName: row.accountHolder,
        amount: row.amount,
        reference: row.reference,
        status: row.status,
        providerRef: row.providerRef,
        attempts: row.attempts,
        maxAttempts: row.maxAttempts,
        lastError: row.lastError,
        createdAt: row.createdAt.toISOString(),
        claimedAt: row.claimedAt?.toISOString() ?? null,
        settledAt: row.settledAt?.toISOString() ?? null,
    };
}

function agentPayload(row: Prisma.PayoutIntentGetPayload<Record<string, never>>): Record<string, unknown> {
    const spec = dialSpec(row.provider);
    return {
        id: row.id,
        provider: row.provider,
        ussdCode: spec?.ussdCode ?? null,
        destinationKind: spec?.destinationKind ?? null,
        destination: row.destination,
        accountHolderName: row.accountHolder,
        amount: row.amount,
        reference: row.reference,
        attempts: row.attempts,
        maxAttempts: row.maxAttempts,
    };
}

router.get('/providers', (req: Request, res: Response): void => {
    res.json({
        success: true,
        providers: listUssdPayoutProviders().map((entry) => ({
            provider: entry.provider,
            displayName: entry.displayName,
            destinationKind: entry.destinationKind,
            enabled: entry.enabled,
            minAmount: entry.minAmount,
            maxAmount: entry.maxAmount,
        })),
    });
});

router.post('/', async (req: Request, res: Response): Promise<void> => {
    const auth = getAuthContext(req);
    if (!auth) {
        res.status(401).json({ success: false, error: 'Authentication required.' });
        return;
    }

    const provider = canonicalProvider(String(req.body?.provider ?? ''));
    const entry = getUssdPayoutProvider(provider);
    if (!entry || !entry.enabled) {
        const known = listUssdPayoutProviders().map((p) => `${p.provider}${p.enabled ? '' : ' (disabled)'}`).join(', ');
        res.status(400).json({ success: false, error: `provider is not available for USSD payouts. Available: ${known}.` });
        return;
    }

    const destinationRaw = req.body?.destination;
    if (typeof destinationRaw !== 'string') {
        res.status(400).json({ success: false, error: 'destination is required.' });
        return;
    }
    const destination = destinationRaw.trim();
    if (!destination) {
        res.status(400).json({ success: false, error: 'destination is required.' });
        return;
    }
    const destinationError = validatePayoutIntentDestination(provider, destination);
    if (destinationError) {
        res.status(400).json({ success: false, error: destinationError });
        return;
    }

    const amount = Number(req.body?.amount);
    if (typeof req.body?.amount === 'boolean' || !Number.isFinite(amount)) {
        res.status(400).json({ success: false, error: 'amount must be a number of ETB.' });
        return;
    }
    const amountError = validatePayoutIntentAmount(provider, Math.round(amount * 100) / 100);
    if (amountError) {
        res.status(400).json({ success: false, error: amountError });
        return;
    }

    const reference = typeof req.body?.reference === 'string' ? req.body.reference.trim() : '';
    if (!REFERENCE_PATTERN.test(reference)) {
        res.status(400).json({ success: false, error: 'reference must be 1-64 characters of letters, digits, dot, underscore, colon or dash.' });
        return;
    }

    const accountHolderRaw = req.body?.accountHolderName;
    let accountHolder: string | null = null;
    if (accountHolderRaw !== undefined && accountHolderRaw !== null) {
        if (typeof accountHolderRaw !== 'string') {
            res.status(400).json({ success: false, error: 'accountHolderName must be a string.' });
            return;
        }
        const trimmed = accountHolderRaw.trim();
        if (trimmed.length > 0) {
            if (Buffer.byteLength(trimmed, 'utf8') > 191) {
                res.status(400).json({ success: false, error: 'accountHolderName must be at most 191 bytes.' });
                return;
            }
            accountHolder = trimmed;
        }
    }

    try {
        const created = await prisma.payoutIntent.create({
            data: {
                workspaceId: auth.workspaceId,
                provider,
                destination,
                accountHolder,
                amount: Math.round(amount * 100) / 100,
                reference,
                createdBy: auth.source === 'DASHBOARD' ? 'DASHBOARD' : auth.apiKeyId,
            },
        });
        res.status(201).json({ success: true, created: true, transfer: agentPayload(created) });
        return;
    } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            const existing = await prisma.payoutIntent.findUnique({
                where: { workspaceId_reference: { workspaceId: auth.workspaceId, reference } },
            });
            if (existing) {
                const sameTransfer = existing.provider === provider
                    && existing.destination === destination
                    && Math.abs(existing.amount - amount) < 0.005;
                if (!sameTransfer) {
                    res.status(409).json({ success: false, error: 'reference already used for a different transfer.' });
                    return;
                }
                res.status(200).json({ success: true, created: false, transfer: agentPayload(existing) });
                return;
            }
        }
        logger.error('Failed to create payout intent:', error);
        res.status(500).json({ success: false, error: 'Failed to create the payout transfer.' });
    }
});

router.get('/', async (req: Request, res: Response): Promise<void> => {
    const auth = getAuthContext(req);
    if (!auth) {
        res.status(401).json({ success: false, error: 'Authentication required.' });
        return;
    }

    const statusFilter = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : null;
    const where: Prisma.PayoutIntentWhereInput = { workspaceId: auth.workspaceId };
    if (statusFilter) {
        if (!(Object.values(PayoutIntentStatus) as string[]).includes(statusFilter)) {
            res.status(400).json({ success: false, error: 'Unknown status. Valid: PENDING, CLAIMED, CONFIRMING, SUCCEEDED, FAILED, CANCELED.' });
            return;
        }
        where.status = statusFilter as PayoutIntentStatus;
    }
    if (typeof req.query.provider === 'string') {
        where.provider = canonicalProvider(req.query.provider);
    }

    const limitRaw = Number(req.query.limit ?? 50);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : 50, 1), 100);

    try {
        const rows = await prisma.payoutIntent.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: limit,
        });
        res.json({ success: true, transfers: rows.map(publicTransfer) });
    } catch (error) {
        logger.error('Failed to list payout intents:', error);
        res.status(500).json({ success: false, error: 'Failed to list payout transfers.' });
    }
});

router.get('/:id', async (req: Request, res: Response): Promise<void> => {
    const auth = getAuthContext(req);
    if (!auth) {
        res.status(401).json({ success: false, error: 'Authentication required.' });
        return;
    }

    try {
        const row = await prisma.payoutIntent.findFirst({
            where: { id: String(req.params.id), workspaceId: auth.workspaceId },
        });
        if (!row) {
            res.status(404).json({ success: false, error: 'Payout transfer not found.' });
            return;
        }
        res.json({ success: true, transfer: publicTransfer(row) });
    } catch (error) {
        logger.error('Failed to read payout intent:', error);
        res.status(500).json({ success: false, error: 'Failed to read the payout transfer.' });
    }
});

router.post('/:id/cancel', async (req: Request, res: Response): Promise<void> => {
    const auth = getAuthContext(req);
    if (!auth) {
        res.status(401).json({ success: false, error: 'Authentication required.' });
        return;
    }

    try {
        const current = await prisma.payoutIntent.findFirst({
            where: { id: String(req.params.id), workspaceId: auth.workspaceId },
        });
        if (!current) {
            res.status(404).json({ success: false, error: 'Payout transfer not found.' });
            return;
        }
        if (current.status !== 'PENDING') {
            res.status(409).json({
                success: false,
                error: `Only PENDING transfers can be canceled; this one is ${current.status}.`,
            });
            return;
        }
        const updated = await prisma.payoutIntent.update({
            where: { id: current.id },
            data: { status: 'CANCELED', settledAt: new Date(), lastError: 'Canceled by the caller.' },
        });
        res.json({ success: true, transfer: publicTransfer(updated) });
    } catch (error) {
        logger.error('Failed to cancel payout intent:', error);
        res.status(500).json({ success: false, error: 'Failed to cancel the payout transfer.' });
    }
});

export default router;
export { agentPayload, maskDestination, REFERENCE_PATTERN, MAX_EVENT_NOTES };
