/**
 * Partner provisioning API — the "one-step setup" enabler for partner platforms
 * (EshiShop) that resell this verifier's verification to their own merchants.
 *
 * POST /internal/provision                       — provision (idempotent on
 *                                                  partner+externalId): workspace
 *                                                  + owner user + OWNER membership
 *                                                  + fresh API key + optional
 *                                                  payout account
 * POST /internal/workspaces/:externalId/api-keys — mint another API key
 * GET  /internal/workspaces/:externalId           — workspace summary (no secrets)
 *
 * Auth: `Authorization: Bearer <PARTNER_SECRET>` (timing-safe compare), so these
 * routes must be mounted BEFORE the global apiKeyAuth middleware — the same
 * mounting area as /auth. Everything here fails closed while PARTNER_SECRET is
 * unset: 401 for every request, never a guessable default.
 *
 * Idempotency contract (worklog 11-0, C1): a second POST /internal/provision
 * with the same (partner, externalId) reuses the existing workspace, updates its
 * name, and ALWAYS mints a fresh API key — the plaintext of which appears in the
 * response and is never logged, never stored (only its sha256 is, as with every
 * other key this service mints).
 *
 * Validation failures answer 422 {"error":"invalid_request","message"}; a bad or
 * missing partner secret answers 401 {"error":"unauthorized"}.
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../utils/prisma';
import logger from '../utils/logger';
import { safeSecretEquals } from '../utils/secretCompare';
import { MemoryWindowCounter } from '../utils/expiringStore';
import { getRequestIp } from '../utils/requestIp';
import { isWithinByteLimit, MYSQL_VARCHAR_BYTES } from '../utils/fieldLimits';
import { resolvePayoutState } from '../utils/payoutInput';
import { getBillingConfig } from '../config/billingConfig';

const router = Router();

// ─── Partner secret guard ─────────────────────────────────────────────────────

/**
 * Read at request time, not module load: tests and deployment tooling set
 * process.env.PARTNER_SECRET after import, and an empty value must fail closed on
 * every request rather than being captured once as "unset, allow all".
 */
function partnerSecretConfigured(): boolean {
    return Boolean(process.env.PARTNER_SECRET && process.env.PARTNER_SECRET.length >= 16);
}

function hasPartnerSecret(req: Request): boolean {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) return false;
    return safeSecretEquals(header.slice(7), process.env.PARTNER_SECRET);
}

// Brute-force throttle on the secret, mirroring the login throttles: the
// comparison is constant-time but the endpoint is still an unauthenticated
// surface, so a caller gets limited attempts per window.
const partnerAuthThrottle = new MemoryWindowCounter({ maxEntries: 20_000 });
const PARTNER_WINDOW_MS = 15 * 60 * 1000;
// Generous on purpose: this is a server-to-server surface (one IP per partner
// deployment), and a bulk migration can legitimately provision hundreds of
// shops in a burst — each create also pays a bcrypt on the hot path, which
// self-limits. The cap exists to bound SECRET brute-force, and 300 attempts
// per window is as hopeless against a 64-hex secret as 30 would be.
const PARTNER_MAX_PER_IP = 300;

router.use((req: Request, res: Response, next): void => {
    const ip = getRequestIp(req);
    if (partnerAuthThrottle.increment(`ip:${ip}`, PARTNER_WINDOW_MS).count > PARTNER_MAX_PER_IP) {
        res.status(429).json({ error: 'rate_limited', message: 'Too many partner API requests from this address. Try again later.' });
        return;
    }
    if (!partnerSecretConfigured() || !hasPartnerSecret(req)) {
        res.status(401).json({ error: 'unauthorized' });
        return;
    }
    next();
});

// ─── Validation helpers ───────────────────────────────────────────────────────

const PARTNER_SLUG = /^[a-z0-9-]+$/;
const EXTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const TELEGRAM_ID = /^\d{1,20}$/;

/** PARTNER_ALLOWED is a comma list (e.g. "eshishop"); unset means any valid slug. */
function allowedPartners(): string[] | null {
    const raw = process.env.PARTNER_ALLOWED;
    if (!raw || !raw.trim()) return null;
    const list = raw.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
    return list.length > 0 ? list : null;
}

function isPartnerAllowed(partner: string): boolean {
    const list = allowedPartners();
    return list === null || list.includes(partner);
}

/**
 * Workspaces addressable by these routes: those provisioned by an allowed
 * partner. With PARTNER_ALLOWED unset every provisioned workspace is (the single
 * partner deployment); with it set, a workspace belonging to a different or
 * unknown partner is invisible here even if its externalId leaks.
 */
function partnerWorkspaceFilter() {
    const list = allowedPartners();
    return list === null
        ? { partner: { not: null } }
        : { partner: { in: list } };
}

interface ProvisionInput {
    externalId: string;
    partner: string;
    workspaceName: string;
    ownerName: string;
    ownerEmail: string | null;
    ownerTelegramId: string | null;
    ownerTelegramUsername: string | null;
    plan: 'free' | 'pro';
    payout: {
        label: string;
        accountHolderName: string;
        providersAllowed: unknown;
        providerAccounts: unknown;
    } | null;
}

function invalid(res: Response, message: string): void {
    res.status(422).json({ error: 'invalid_request', message });
}

function optionalTrimmedString(value: unknown): string | null | 'invalid' {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') return 'invalid';
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function parseProvisionBody(body: Record<string, unknown>): ProvisionInput | { error: string } {
    const externalId = optionalTrimmedString(body.externalId);
    if (!externalId) return { error: 'externalId is required.' };
    if (externalId.length > MYSQL_VARCHAR_BYTES || !EXTERNAL_ID.test(externalId)) {
        return { error: 'externalId must match [A-Za-z0-9][A-Za-z0-9._:@-]* and be at most 191 bytes.' };
    }

    const partner = optionalTrimmedString(body.partner);
    if (!partner) return { error: 'partner is required.' };
    if (partner.length > 32 || !PARTNER_SLUG.test(partner)) {
        return { error: 'partner must be a slug of 1-32 characters matching ^[a-z0-9-]+$ (e.g. "eshishop").' };
    }
    if (!isPartnerAllowed(partner)) {
        return { error: `partner "${partner}" is not in PARTNER_ALLOWED.` };
    }

    const workspaceName = optionalTrimmedString(body.workspaceName);
    if (!workspaceName) return { error: 'workspaceName is required.' };
    if (!isWithinByteLimit(workspaceName)) {
        return { error: `workspaceName must be at most ${MYSQL_VARCHAR_BYTES} bytes.` };
    }

    const ownerName = optionalTrimmedString(body.ownerName);
    if (!ownerName) return { error: 'ownerName is required.' };
    if (!isWithinByteLimit(ownerName)) {
        return { error: `ownerName must be at most ${MYSQL_VARCHAR_BYTES} bytes.` };
    }

    let ownerEmail: string | null = null;
    if (body.ownerEmail !== undefined && body.ownerEmail !== null && body.ownerEmail !== '') {
        if (typeof body.ownerEmail !== 'string' || !EMAIL_PATTERN.test(body.ownerEmail.trim().toLowerCase())) {
            return { error: 'ownerEmail must be a valid email address.' };
        }
        ownerEmail = body.ownerEmail.trim().toLowerCase();
        if (ownerEmail.length > MYSQL_VARCHAR_BYTES) return { error: 'ownerEmail is too long.' };
    }

    let ownerTelegramId: string | null = null;
    if (body.ownerTelegramId !== undefined && body.ownerTelegramId !== null && body.ownerTelegramId !== '') {
        const raw = String(body.ownerTelegramId).trim();
        if (!TELEGRAM_ID.test(raw)) return { error: 'ownerTelegramId must be the Telegram account id (digits only).' };
        ownerTelegramId = raw;
    }

    let ownerTelegramUsername: string | null = null;
    if (body.ownerTelegramUsername !== undefined && body.ownerTelegramUsername !== null && body.ownerTelegramUsername !== '') {
        if (typeof body.ownerTelegramUsername !== 'string') return { error: 'ownerTelegramUsername must be a string.' };
        const trimmed = body.ownerTelegramUsername.trim().replace(/^@/, '');
        if (trimmed.length === 0 || trimmed.length > 32) return { error: 'ownerTelegramUsername must be 1-32 characters.' };
        ownerTelegramUsername = trimmed;
    }

    let plan: 'free' | 'pro' = 'free';
    if (body.plan !== undefined && body.plan !== null && body.plan !== '') {
        if (body.plan !== 'free' && body.plan !== 'pro') return { error: 'plan must be "free" or "pro".' };
        plan = body.plan;
    }

    let payout: ProvisionInput['payout'] = null;
    if (body.payout !== undefined && body.payout !== null) {
        const raw = body.payout as Record<string, unknown>;
        if (typeof raw !== 'object' || Array.isArray(raw)) {
            return { error: 'payout must be an object.' };
        }
        const label = optionalTrimmedString(raw.label);
        if (!label) return { error: 'payout.label is required.' };
        if (!isWithinByteLimit(label)) return { error: 'payout.label must be at most 191 bytes.' };

        const accountHolderName = optionalTrimmedString(raw.accountHolderName);
        if (!accountHolderName) return { error: 'payout.accountHolderName is required.' };
        if (!isWithinByteLimit(accountHolderName)) return { error: 'payout.accountHolderName must be at most 191 bytes.' };

        if (!Array.isArray(raw.providersAllowed)) {
            return { error: 'payout.providersAllowed must be an array of provider names.' };
        }
        if (raw.providerAccounts === undefined || typeof raw.providerAccounts !== 'object' || Array.isArray(raw.providerAccounts)) {
            return { error: 'payout.providerAccounts must map provider → account number.' };
        }
        payout = {
            label,
            accountHolderName,
            providersAllowed: raw.providersAllowed,
            providerAccounts: raw.providerAccounts,
        };
    }

    return {
        externalId,
        partner,
        workspaceName,
        ownerName,
        ownerEmail,
        ownerTelegramId,
        ownerTelegramUsername,
        plan,
        payout,
    };
}

// ─── Shared response builders ─────────────────────────────────────────────────

const PAYOUT_PUBLIC_SELECT = {
    id: true,
    label: true,
    accountHolderName: true,
    providersAllowed: true,
    providerAccounts: true,
} as const;

async function listPayoutAccounts(workspaceId: string) {
    const accounts = await prisma.payoutAccount.findMany({
        where: { workspaceId, active: true },
        select: PAYOUT_PUBLIC_SELECT,
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
    return accounts.map((account) => ({
        id: account.id,
        label: account.label,
        accountHolderName: account.accountHolderName,
        providersAllowed: account.providersAllowed,
        providerAccounts: account.providerAccounts,
    }));
}

/**
 * Mint an API key the same way the dashboard does (sha256 at rest, prefix for
 * display, verify+webhooks permissions) and return the plaintext ONCE.
 *
 * The plaintext exists only in the return value and the HTTP response — never in
 * a log line, never in a database column.
 */
async function mintWorkspaceApiKey(workspaceId: string, name: string): Promise<{ rawKey: string; id: string }> {
    const rawSecret = crypto.randomBytes(24).toString('hex');
    const rawKey = `sk_live_${rawSecret}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const prefix = `sk_live_${rawSecret.substring(0, 6)}...`;
    const apiKey = await prisma.apiKey.create({
        data: {
            keyHash,
            prefix,
            name,
            workspaceId,
            usageCount: 0,
            isActive: true,
            permissions: ['verify', 'webhooks'],
        },
        select: { id: true },
    });
    return { rawKey, id: apiKey.id };
}

async function findProvisionedWorkspace(externalId: string) {
    const where = { externalId, ...partnerWorkspaceFilter() } as { externalId: string; partner: { not: null } | { in: string[] } };
    return prisma.workspace.findFirst({
        where,
        select: { id: true, name: true, partner: true, externalId: true },
    });
}

// ─── POST /provision ─────────────────────────────────────────────────────────

router.post('/provision', async (req: Request, res: Response): Promise<void> => {
    const parsed = parseProvisionBody((req.body ?? {}) as Record<string, unknown>);
    if ('error' in parsed) {
        invalid(res, parsed.error);
        return;
    }
    const input = parsed;

    try {
        let workspace = await findProvisionedWorkspace(input.externalId);
        let created = false;

        // Idempotency is on externalId, which is globally unique. A workspace
        // with the same externalId under a DIFFERENT partner is a name collision
        // between partner namespaces, not a replay of this partner's call.
        if (workspace === null) {
            const collision = await prisma.workspace.findUnique({
                where: { externalId: input.externalId },
                select: { partner: true },
            });
            if (collision !== null) {
                invalid(res, `externalId "${input.externalId}" already belongs to a different partner.`);
                return;
            }
        }

        if (workspace !== null) {
            // Replay: keep the workspace, refresh its display name.
            if (workspace.name !== input.workspaceName) {
                await prisma.workspace.update({
                    where: { id: workspace.id },
                    data: { name: input.workspaceName },
                });
            }
        } else {
            // ── Resolve the owner ──────────────────────────────────────────────
            // Email first (the partner's canonical identity), then Telegram id,
            // else a fresh user. A fresh user gets a random bcrypt password so
            // the row cannot be logged into by password — the owner signs in via
            // Telegram when ownerTelegramId was supplied, or via password reset
            // against a real ownerEmail. A partner with neither gets a synthetic
            // address under partners.local, which no real mailbox can receive.
            const byEmail = input.ownerEmail
                ? await prisma.user.findUnique({ where: { email: input.ownerEmail }, select: { id: true } })
                : null;
            const byTelegram = !byEmail && input.ownerTelegramId
                ? await prisma.user.findUnique({ where: { telegramId: input.ownerTelegramId }, select: { id: true } })
                : null;
            const existingOwnerId = byEmail?.id ?? byTelegram?.id ?? null;

            const workspaceId = `ws_${crypto.randomBytes(12).toString('hex')}`;
            const monthlyCredits = input.plan === 'pro'
                ? (await getBillingConfig()).proQuotaMonthly
                : 100;
            const imageCreditsMonthly = input.plan === 'pro'
                ? (await getBillingConfig()).proImageCredits
                : 0;

            const workspaceData = {
                id: workspaceId,
                name: input.workspaceName,
                externalId: input.externalId,
                partner: input.partner,
                tier: (input.plan === 'pro' ? 'PRO' : 'FREE') as 'PRO' | 'FREE',
                verificationCredits: monthlyCredits,
                verificationCreditsMonthly: monthlyCredits,
                verificationCreditsResetAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
                imageCredits: 0,
                imageCreditsMonthly: imageCreditsMonthly,
            };

            if (existingOwnerId !== null) {
                await prisma.$transaction([
                    prisma.workspace.create({ data: workspaceData }),
                    prisma.membership.create({
                        data: { userId: existingOwnerId, workspaceId, role: 'OWNER' as const },
                    }),
                ]);
            } else {
                const userId = `usr_${crypto.randomBytes(12).toString('hex')}`;
                const email = input.ownerEmail ?? `partner+${input.externalId}@partners.local`;
                // Unguessable, unrecoverable, unrevealed — the account is
                // unreachable by password by construction, matching the
                // synthetic-owner contract.
                const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);

                await prisma.$transaction([
                    prisma.user.create({
                        data: {
                            id: userId,
                            email,
                            name: input.ownerName,
                            ...(input.ownerTelegramId ? { telegramId: input.ownerTelegramId } : {}),
                            accounts: {
                                create: [
                                    {
                                        id: `acc_${crypto.randomBytes(12).toString('hex')}`,
                                        provider: 'credentials',
                                        providerAccountId: userId,
                                        type: 'credentials',
                                        passwordHash,
                                    },
                                    ...(input.ownerTelegramId
                                        ? [{
                                            id: `acc_${crypto.randomBytes(12).toString('hex')}`,
                                            provider: 'telegram',
                                            providerAccountId: input.ownerTelegramId,
                                            type: 'oauth',
                                        }]
                                        : []),
                                ],
                            },
                        },
                    }),
                    prisma.workspace.create({ data: workspaceData }),
                    prisma.membership.create({
                        data: { userId, workspaceId, role: 'OWNER' as const },
                    }),
                ]);
            }

            workspace = { id: workspaceId, name: input.workspaceName, partner: input.partner, externalId: input.externalId };
            created = true;
            logger.info(`Partner ${input.partner} provisioned workspace ${workspaceId} (externalId ${input.externalId})`);
        }

        // ALWAYS a fresh key — the response hands the plaintext to the caller
        // exactly once, so a replayed provision never leaves a partner unable to
        // fetch a working credential.
        const minted = await mintWorkspaceApiKey(workspace.id, `${input.partner}-auto`);

        let payoutAccountId: string | null = null;
        if (input.payout) {
            const current = await prisma.payoutAccount.findFirst({
                where: { workspaceId: workspace.id, label: input.payout.label, active: true },
                select: { id: true, account: true, providersAllowed: true, providerAccounts: true },
            });

            // Same unified-account validation as POST /payouts (utils/payoutInput):
            // providers must be sellable payout providers and every provider must
            // resolve to a non-empty destination.
            const resolved = resolvePayoutState(
                current
                    ? { account: current.account, providersAllowed: current.providersAllowed, providerAccounts: current.providerAccounts }
                    : null,
                {
                    providersAllowed: input.payout.providersAllowed,
                    providerAccounts: input.payout.providerAccounts,
                },
            );
            if ('error' in resolved) {
                invalid(res, `payout is invalid: ${resolved.error}`);
                return;
            }

            if (current) {
                await prisma.payoutAccount.updateMany({
                    where: { id: current.id, workspaceId: workspace.id },
                    data: {
                        label: input.payout.label,
                        accountHolderName: input.payout.accountHolderName,
                        type: resolved.data.type,
                        account: resolved.data.account,
                        providersAllowed: resolved.data.providersAllowed,
                        providerAccounts: resolved.data.providerAccounts,
                    },
                });
                payoutAccountId = current.id;
            } else {
                const existingCount = await prisma.payoutAccount.count({
                    where: { workspaceId: workspace.id, active: true },
                });
                const account = await prisma.payoutAccount.create({
                    data: {
                        workspaceId: workspace.id,
                        label: input.payout.label,
                        accountHolderName: input.payout.accountHolderName,
                        type: resolved.data.type,
                        account: resolved.data.account,
                        providersAllowed: resolved.data.providersAllowed,
                        providerAccounts: resolved.data.providerAccounts,
                        isDefault: existingCount === 0,
                    },
                    select: { id: true },
                });
                payoutAccountId = account.id;
            }
        }

        const payoutAccounts = await listPayoutAccounts(workspace.id);

        // The apiKey is the one secret in this response; nothing about it is
        // logged, and its sha256 is the only stored form.
        res.status(created ? 201 : 200).json({
            ok: true,
            workspaceId: workspace.id,
            apiKey: minted.rawKey,
            apiKeyId: minted.id,
            payoutAccountId,
            payoutAccounts,
            created,
        });
    } catch (err) {
        // A concurrent provision of the same externalId loses the unique-index
        // race and lands here; treat it as the replay it is rather than a 500.
        const code = (err as { code?: string })?.code;
        if (code === 'P2002') {
            const existing = await findProvisionedWorkspace(input.externalId).catch(() => null);
            if (existing !== null) {
                logger.warn(`Concurrent provision of externalId ${input.externalId} by partner ${input.partner}; retriable as a replay`);
                res.status(409).json({
                    error: 'version_conflict',
                    message: 'This workspace was provisioned concurrently. Retry the same request; it is idempotent.',
                });
                return;
            }
        }
        logger.error('Provision error:', err instanceof Error ? err.message : err);
        res.status(500).json({ error: 'internal_error', message: 'Failed to provision workspace.' });
    }
});

// ─── POST /workspaces/:externalId/api-keys ───────────────────────────────────

router.post('/workspaces/:externalId/api-keys', async (req: Request, res: Response): Promise<void> => {
    const externalId = String(req.params.externalId || '').trim();
    if (!externalId || !EXTERNAL_ID.test(externalId) || externalId.length > MYSQL_VARCHAR_BYTES) {
        invalid(res, 'externalId in the path is missing or malformed.');
        return;
    }

    try {
        const workspace = await findProvisionedWorkspace(externalId);
        if (!workspace) {
            res.status(404).json({ error: 'not_found', message: `No workspace provisioned with externalId "${externalId}".` });
            return;
        }

        const minted = await mintWorkspaceApiKey(workspace.id, `${workspace.partner ?? 'partner'}-auto`);
        res.status(201).json({
            ok: true,
            apiKey: minted.rawKey,
            apiKeyId: minted.id,
        });
    } catch (err) {
        logger.error('Partner key mint error:', err instanceof Error ? err.message : err);
        res.status(500).json({ error: 'internal_error', message: 'Failed to mint API key.' });
    }
});

// ─── GET /workspaces/:externalId ──────────────────────────────────────────────

router.get('/workspaces/:externalId', async (req: Request, res: Response): Promise<void> => {
    const externalId = String(req.params.externalId || '').trim();
    if (!externalId || !EXTERNAL_ID.test(externalId) || externalId.length > MYSQL_VARCHAR_BYTES) {
        invalid(res, 'externalId in the path is missing or malformed.');
        return;
    }

    try {
        const workspace = await findProvisionedWorkspace(externalId);
        if (!workspace) {
            res.status(404).json({ error: 'not_found', message: `No workspace provisioned with externalId "${externalId}".` });
            return;
        }

        const [apiKeys, payoutAccounts] = await Promise.all([
            prisma.apiKey.findMany({
                where: { workspaceId: workspace.id, isActive: true },
                select: { id: true, name: true, prefix: true, createdAt: true, lastUsed: true },
                orderBy: { createdAt: 'desc' },
            }),
            listPayoutAccounts(workspace.id),
        ]);

        // Key hashes and session credentials never appear here — only display
        // metadata, the same surface the dashboard itself exposes.
        res.json({
            ok: true,
            workspaceId: workspace.id,
            name: workspace.name,
            apiKeys: apiKeys.map((key) => ({
                id: key.id,
                name: key.name,
                prefix: key.prefix,
                createdAt: key.createdAt,
                lastUsedAt: key.lastUsed,
            })),
            payoutAccounts,
        });
    } catch (err) {
        logger.error('Partner workspace lookup error:', err instanceof Error ? err.message : err);
        res.status(500).json({ error: 'internal_error', message: 'Failed to load workspace.' });
    }
});

export default router;
