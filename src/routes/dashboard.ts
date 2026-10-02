/**
 * Dashboard routes — for managing API keys, payout accounts, and payment links
 * via the web dashboard (session-authenticated, not API-key-authenticated).
 *
 * These wrap the existing admin/api-key + payouts + payment-links endpoints
 * but use session auth (requireSession middleware) instead of x-admin-key /
 * x-api-key headers. This lets the dashboard manage everything without exposing
 * the admin secret to the browser.
 *
 * /dashboard/api-keys     — list, create, revoke API keys for the workspace
 * /dashboard/payouts      — list, create, update payout accounts
 * /dashboard/payment-links — list, create, update payment links
 * /dashboard/webhooks     — list, create, update webhooks
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../utils/prisma';
import logger from '../utils/logger';
import { requireSession } from './auth';
import { generateApiKey } from '../middleware/apiKeyAuth';
import { createVerificationPipeline, dashboardVerificationAccess } from '../middleware/verificationPipeline';
import { verifyImageGate } from '../middleware/tierGate';
import { rateLimiter } from '../middleware/rateLimiter';
import { verifyImageHandler } from '../services/verifyImage';
import {
    normaliseAccount,
    normaliseProviders as normalisePayoutProviders,
    validatePayoutEdit,
    validatePayoutInput,
} from '../utils/payoutInput';
import { assertBrowserNavigableUrl, assertSafeOutboundUrl, UnsafeOutboundUrlError } from '../utils/safeUrl';
import { WORKSPACE_EVENTS } from '../utils/workspaceEvents';
import {
    ensureProviderCoverage,
    getWorkspacePayoutAccounts,
    normaliseIdList,
    normaliseOptionalText,
    normaliseOptionalUrl,
    normaliseProviders,
    resolvePositiveInteger,
} from './products';

const router = Router();

// All dashboard routes require session auth
router.use(requireSession);

// ─── Helper: verify workspace access ─────────────────────────────────────────

async function verifyWorkspaceAccess(userId: string, workspaceId: string) {
    const membership = await prisma.membership.findUnique({
        where: { userId_workspaceId: { userId, workspaceId } },
    });
    return membership;
}

// ═══ API KEYS ═══════════════════════════════════════════════════════════════

router.get('/:workspaceId/api-keys', async (req: Request, res: Response): Promise<void> => {
    const userId = (req as any).userId as string;
    const { workspaceId } = req.params as { workspaceId: string };

    try {
        const membership = await verifyWorkspaceAccess(userId, workspaceId);
        if (!membership) {
            res.status(403).json({ success: false, error: 'Access denied.' });
            return;
        }

        const apiKeys = await prisma.apiKey.findMany({
            where: { workspaceId, isActive: true },
            select: {
                id: true,
                prefix: true,
                usageCount: true,
                lastUsed: true,
                isActive: true,
                createdAt: true,
                permissions: true,
                // So the dashboard can show which key is bound to which account
                // and offer to change it, instead of the binding being invisible
                // until a verification is refused.
                defaultPayoutAccountId: true,
                defaultPayoutAccount: { select: { id: true, label: true, account: true } },
            },
            orderBy: { createdAt: 'desc' },
        });

        res.json({ success: true, apiKeys });
    } catch (err) {
        logger.error('List API keys error:', err);
        res.status(500).json({ success: false, error: 'Failed to list API keys.' });
    }
});

router.post('/:workspaceId/api-keys', async (req: Request, res: Response): Promise<void> => {
    const userId = (req as any).userId as string;
    const { workspaceId } = req.params as { workspaceId: string };
    const { label, defaultPayoutAccountId } = req.body as {
        label?: string;
        defaultPayoutAccountId?: string;
    };

    try {
        const membership = await verifyWorkspaceAccess(userId, workspaceId);
        if (!membership) {
            res.status(403).json({ success: false, error: 'Access denied.' });
            return;
        }

        // Scoped to this workspace, so binding an account cannot point a key at
        // another tenant's. An unknown id is reported rather than silently
        // ignored: a key that looks bound but checks nothing is worse than none.
        let payoutAccountId: string | null = null;
        if (typeof defaultPayoutAccountId === 'string' && defaultPayoutAccountId.trim() !== '') {
            const account = await prisma.payoutAccount.findFirst({
                where: { id: defaultPayoutAccountId.trim(), workspaceId, active: true },
                select: { id: true },
            });
            if (!account) {
                res.status(400).json({ success: false, error: 'Payout account not found in this workspace.' });
                return;
            }
            payoutAccountId = account.id;
        }

        // Generate a new API key directly attached to this workspace
        const rawSecret = crypto.randomBytes(24).toString('hex');
        const rawKey = `sk_live_${rawSecret}`;
        const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
        const prefix = `sk_live_${rawSecret.substring(0, 6)}...`;

        const apiKey = await prisma.apiKey.create({
            data: {
                keyHash,
                prefix,
                workspaceId,
                usageCount: 0,
                isActive: true,
                permissions: ['verify', 'webhooks'],
                ...(payoutAccountId ? { defaultPayoutAccountId: payoutAccountId } : {}),
            },
            include: { defaultPayoutAccount: { select: { id: true, label: true, account: true } } },
        });

        logger.info(`New API key created for workspace ${workspaceId}`);

        res.status(201).json({
            success: true,
            message: 'IMPORTANT: Copy this key now. You will not be able to view it again.',
            apiKey: {
                id: apiKey.id,
                key: rawKey,
                prefix: apiKey.prefix,
                createdAt: apiKey.createdAt,
                defaultPayoutAccountId: apiKey.defaultPayoutAccountId,
                defaultPayoutAccount: apiKey.defaultPayoutAccount,
            },
        });
    } catch (err) {
        logger.error('Create API key error:', err);
        res.status(500).json({ success: false, error: 'Failed to create API key.' });
    }
});

// Bind or unbind the payout account this key's verifications are checked against.
// Keys are long-lived, so the binding has to be changeable after creation — and
// clearable, because turning the check off must be as easy as turning it on.
// `null` or "" clears it.
router.patch('/:workspaceId/api-keys/:keyId/payout-account', async (req: Request, res: Response): Promise<void> => {
    const userId = (req as any).userId as string;
    const { workspaceId, keyId } = req.params as { workspaceId: string; keyId: string };
    const { payoutAccountId } = req.body as { payoutAccountId?: string | null };

    try {
        const membership = await verifyWorkspaceAccess(userId, workspaceId);
        if (!membership) {
            res.status(403).json({ success: false, error: 'Access denied.' });
            return;
        }

        // Both sides of the key are scoped to this workspace, so a key id from
        // another tenant cannot be reached by guessing.
        const key = await prisma.apiKey.findFirst({
            where: { id: keyId, workspaceId },
            select: { id: true },
        });
        if (!key) {
            res.status(404).json({ success: false, error: 'API key not found.' });
            return;
        }

        const wantsBinding = typeof payoutAccountId === 'string' && payoutAccountId.trim() !== '';
        if (wantsBinding) {
            const account = await prisma.payoutAccount.findFirst({
                where: { id: (payoutAccountId as string).trim(), workspaceId, active: true },
                select: { id: true },
            });
            if (!account) {
                res.status(400).json({ success: false, error: 'Payout account not found in this workspace.' });
                return;
            }
        }

        const updated = await prisma.apiKey.update({
            where: { id: keyId },
            data: { defaultPayoutAccountId: wantsBinding ? (payoutAccountId as string).trim() : null },
            select: {
                id: true,
                defaultPayoutAccountId: true,
                defaultPayoutAccount: { select: { id: true, label: true, account: true } },
            },
        });

        res.json({ success: true, apiKey: updated });
    } catch (err) {
        logger.error('Update API key payout account error:', err);
        res.status(500).json({ success: false, error: 'Failed to update API key.' });
    }
});

router.delete('/:workspaceId/api-keys/:keyId', async (req: Request, res: Response): Promise<void> => {
    const userId = (req as any).userId as string;
    const { workspaceId, keyId } = req.params as { workspaceId: string; keyId: string };

    try {
        const membership = await verifyWorkspaceAccess(userId, workspaceId);
        if (!membership) {
            res.status(403).json({ success: false, error: 'Access denied.' });
            return;
        }

        const updated = await prisma.apiKey.updateMany({
            where: { id: keyId, workspaceId },
            data: { isActive: false },
        });

        if (updated.count === 0) {
            res.status(404).json({ success: false, error: 'API key not found.' });
            return;
        }

        res.json({ success: true });
    } catch (err) {
        logger.error('Revoke API key error:', err);
        res.status(500).json({ success: false, error: 'Failed to revoke API key.' });
    }
});

// ═══ PAYOUT ACCOUNTS ════════════════════════════════════════════════════════

router.get('/:workspaceId/payouts', async (req: Request, res: Response): Promise<void> => {
    const userId = (req as any).userId as string;
    const { workspaceId } = req.params as { workspaceId: string };

    try {
        const membership = await verifyWorkspaceAccess(userId, workspaceId);
        if (!membership) {
            res.status(403).json({ success: false, error: 'Access denied.' });
            return;
        }

        const payouts = await prisma.payoutAccount.findMany({
            where: { workspaceId, active: true },
            select: {
                id: true,
                label: true,
                accountHolderName: true,
                type: true,
                account: true,
                providersAllowed: true,
                isDefault: true,
                createdAt: true,
            },
            orderBy: { createdAt: 'desc' },
        });

        res.json({ success: true, payouts });
    } catch (err) {
        logger.error('List payouts error:', err);
        res.status(500).json({ success: false, error: 'Failed to list payout accounts.' });
    }
});

router.post('/:workspaceId/payouts', async (req: Request, res: Response): Promise<void> => {
    const userId = (req as any).userId as string;
    const { workspaceId } = req.params as { workspaceId: string };
    const { label, accountHolderName, type, account, providersAllowed } = req.body as {
        label?: string;
        accountHolderName?: string;
        type?: 'PHONE' | 'BANK';
        account?: string;
        providersAllowed?: string[];
    };

        if (!label || !accountHolderName || !type || !account) {
        res.status(400).json({ success: false, error: 'label, accountHolderName, type, and account are required.' });
        return;
    }

    try {
        const membership = await verifyWorkspaceAccess(userId, workspaceId);
        if (!membership) {
            res.status(403).json({ success: false, error: 'Access denied.' });
            return;
        }

        // This route used to store whatever it was given, while the API-key route
        // validated. An account with a malformed phone number could be saved here,
        // then be offered as the expected recipient and quietly never match a
        // receipt. Same validation as POST /payouts now.
        const providers = normalisePayoutProviders(providersAllowed ?? ['telebirr']);
        const problem = validatePayoutInput(type, normaliseAccount(account), providers);
        if (problem) {
            res.status(400).json({ success: false, error: problem });
            return;
        }

        // First account in a workspace becomes the default, matching POST /payouts.
        const existing = await prisma.payoutAccount.count({ where: { workspaceId, active: true } });

        const payout = await prisma.payoutAccount.create({
            data: {
                workspaceId,
                label,
                accountHolderName,
                type,
                account: normaliseAccount(account),
                providersAllowed: providers,
                isDefault: existing === 0,
                active: true,
            },
        });

        res.status(201).json({ success: true, payout });
    } catch (err) {
        logger.error('Create payout error:', err);
        res.status(500).json({ success: false, error: 'Failed to create payout account.' });
    }
});

// Edit an account. Absent entirely before, so the only way to correct a label, a
// holder name or a provider list from the UI was to delete the account and
// recreate it — which would break any product or payment link pointing at it.
router.patch('/:workspaceId/payouts/:payoutId', async (req: Request, res: Response): Promise<void> => {
    const userId = (req as any).userId as string;
    const { workspaceId, payoutId } = req.params as { workspaceId: string; payoutId: string };
    const body = req.body as Record<string, unknown>;

    try {
        const membership = await verifyWorkspaceAccess(userId, workspaceId);
        if (!membership) {
            res.status(403).json({ success: false, error: 'Access denied.' });
            return;
        }

        const current = await prisma.payoutAccount.findFirst({
            where: { id: payoutId, workspaceId, active: true },
            select: { id: true, type: true, account: true, providersAllowed: true, isDefault: true },
        });
        if (!current) {
            res.status(404).json({ success: false, error: 'Payout account not found.' });
            return;
        }

        const validated = validatePayoutEdit({ type: current.type }, body);
        if ('error' in validated) {
            res.status(400).json({ success: false, error: validated.error });
            return;
        }

        // Setting a default has to unset the others in one transaction, or a
        // second "default" can appear and nothing knows which one wins.
        const wantsDefault = body.isDefault === true;
        const shouldClear = wantsDefault || body.isDefault === false;

        const payout = await prisma.$transaction(async (tx) => {
            if (shouldClear) {
                await tx.payoutAccount.updateMany({
                    where: { workspaceId, isDefault: true },
                    data: { isDefault: false },
                });
            }
            return tx.payoutAccount.update({
                where: { id: payoutId },
                data: {
                    ...validated.data,
                    ...(shouldClear ? { isDefault: wantsDefault } : {}),
                },
            });
        });

        res.json({ success: true, payout });
    } catch (err) {
        logger.error('Update payout error:', err);
        res.status(500).json({ success: false, error: 'Failed to update payout account.' });
    }
});

router.delete('/:workspaceId/payouts/:payoutId', async (req: Request, res: Response): Promise<void> => {
    const userId = (req as any).userId as string;
    const { workspaceId, payoutId } = req.params as { workspaceId: string; payoutId: string };

    try {
        const membership = await verifyWorkspaceAccess(userId, workspaceId);
        if (!membership) {
            res.status(403).json({ success: false, error: 'Access denied.' });
            return;
        }

        const updated = await prisma.payoutAccount.updateMany({
            where: { id: payoutId, workspaceId },
            data: { active: false },
        });

        if (updated.count === 0) {
            res.status(404).json({ success: false, error: 'Payout account not found.' });
            return;
        }

        res.json({ success: true });
    } catch (err) {
        logger.error('Delete payout error:', err);
        res.status(500).json({ success: false, error: 'Failed to delete payout account.' });
    }
});

// ═══ PAYMENT LINKS ══════════════════════════════════════════════════════════

router.get('/:workspaceId/payment-links', async (req: Request, res: Response): Promise<void> => {
    const userId = (req as any).userId as string;
    const { workspaceId } = req.params as { workspaceId: string };

    try {
        const membership = await verifyWorkspaceAccess(userId, workspaceId);
        if (!membership) {
            res.status(403).json({ success: false, error: 'Access denied.' });
            return;
        }

        const links = await prisma.paymentLink.findMany({
            where: { workspaceId },
            select: {
                id: true,
                name: true,
                mode: true,
                fixedAmount: true,
                acceptedProviders: true,
                status: true,
                redirectUrl: true,
                expiresAt: true,
                createdAt: true,
                _count: { select: { orders: { where: { status: 'PAID' } } } },
            },
            orderBy: { createdAt: 'desc' },
        });

        res.json({ success: true, paymentLinks: links });
    } catch (err) {
        logger.error('List payment links error:', err);
        res.status(500).json({ success: false, error: 'Failed to list payment links.' });
    }
});

router.post('/:workspaceId/payment-links', async (req: Request, res: Response): Promise<void> => {
    const userId = (req as any).userId as string;
    const { workspaceId } = req.params as { workspaceId: string };
    const { name, fixedAmount, acceptedProviders, redirectUrl, payoutAccountIds } = req.body as {
        name?: string;
        fixedAmount?: number;
        acceptedProviders?: string[];
        redirectUrl?: string;
        payoutAccountIds?: string[];
    };

    if (!name || !fixedAmount || !acceptedProviders || acceptedProviders.length === 0) {
        res.status(400).json({ success: false, error: 'name, fixedAmount, and acceptedProviders are required.' });
        return;
    }
    // This route stored redirectUrl verbatim, while the API-key route validated
    // it. The value is rendered as an href on the buyer's checkout page, so
    // reject anything that is not http(s) rather than silently storing a
    // javascript: URL.
    let safeRedirectUrl: string | null = null;
    if (redirectUrl !== undefined && redirectUrl !== null && redirectUrl !== '') {
        try {
            safeRedirectUrl = assertBrowserNavigableUrl(redirectUrl).toString();
        } catch (err) {
            res.status(400).json({
                success: false,
                error: err instanceof UnsafeOutboundUrlError ? err.message : 'redirectUrl must be a valid http(s) URL.',
            });
            return;
        }
    }

    try {
        const membership = await verifyWorkspaceAccess(userId, workspaceId);
        if (!membership) {
            res.status(403).json({ success: false, error: 'Access denied.' });
            return;
        }

        // Verify payout accounts cover all accepted providers
        if (payoutAccountIds && payoutAccountIds.length > 0) {
            const payouts = await prisma.payoutAccount.findMany({
                where: { id: { in: payoutAccountIds }, workspaceId, active: true },
                select: { providersAllowed: true },
            });
            const coveredProviders = new Set(
                payouts.flatMap((p) => p.providersAllowed as string[])
            );
            const uncovered = acceptedProviders.filter((p) => !coveredProviders.has(p));
            if (uncovered.length > 0) {
                res.status(400).json({
                    success: false,
                    error: `No payout account covers these providers: ${uncovered.join(', ')}. Create a payout account for them first.`,
                });
                return;
            }
        }

        const link = await prisma.paymentLink.create({
            data: {
                workspaceId,
                name,
                mode: 'CUSTOM',
                fixedAmount,
                acceptedProviders,
                redirectUrl: safeRedirectUrl,
                status: 'ACTIVE',
                creatorType: 'DASHBOARD',
            },
        });

        // Link payout accounts if provided
        if (payoutAccountIds && payoutAccountIds.length > 0) {
            await prisma.paymentLink.update({
                where: { id: link.id },
                data: {
                    payoutAccounts: {
                        connect: payoutAccountIds.map((id) => ({ id })),
                    },
                },
            });
        }

        res.status(201).json({ success: true, paymentLink: link });
    } catch (err) {
        logger.error('Create payment link error:', err);
        res.status(500).json({ success: false, error: 'Failed to create payment link.' });
    }
});

// ═══ WEBHOOKS ═══════════════════════════════════════════════════════════════

router.get('/:workspaceId/webhooks', async (req: Request, res: Response): Promise<void> => {
    const userId = (req as any).userId as string;
    const { workspaceId } = req.params as { workspaceId: string };

    try {
        const membership = await verifyWorkspaceAccess(userId, workspaceId);
        if (!membership) {
            res.status(403).json({ success: false, error: 'Access denied.' });
            return;
        }

        const webhooks = await prisma.webhook.findMany({
            where: { workspaceId },
            select: {
                id: true,
                url: true,
                events: true,
                active: true,
                createdAt: true,
                _count: { select: { deliveries: true } },
            },
            orderBy: { createdAt: 'desc' },
        });

        res.json({ success: true, webhooks });
    } catch (err) {
        logger.error('List webhooks error:', err);
        res.status(500).json({ success: false, error: 'Failed to list webhooks.' });
    }
});

router.post('/:workspaceId/webhooks', async (req: Request, res: Response): Promise<void> => {
    const userId = (req as any).userId as string;
    const { workspaceId } = req.params as { workspaceId: string };
    const { url, events } = req.body as { url?: string; events?: string[] };

    if (!url || !events || events.length === 0) {
        res.status(400).json({ success: false, error: 'url and events are required.' });
        return;
    }
    // Same allowlist as POST /webhooks. This route previously validated neither
    // the URL nor the event names, so any member could register a target the
    // server would later fetch on their behalf.
    if (!Array.isArray(events) || events.length === 0 ||
        events.some((e) => !(WORKSPACE_EVENTS as readonly string[]).includes(e))) {
        res.status(400).json({
            success: false,
            error: `Unknown events. Valid: ${WORKSPACE_EVENTS.join(', ')}`,
        });
        return;
    }
    let safeUrl: string;
    try {
        safeUrl = (await assertSafeOutboundUrl(url)).toString();
    } catch (err) {
        if (err instanceof UnsafeOutboundUrlError) {
            res.status(400).json({ success: false, error: err.message });
            return;
        }
        res.status(400).json({ success: false, error: 'url must be a valid URL.' });
        return;
    }

    try {
        const membership = await verifyWorkspaceAccess(userId, workspaceId);
        if (!membership) {
            res.status(403).json({ success: false, error: 'Access denied.' });
            return;
        }

        const signingSecret = crypto.randomBytes(32).toString('hex');

        const webhook = await prisma.webhook.create({
            data: {
                workspaceId,
                url: safeUrl,
                events,
                active: true,
                signingSecret,
            },
        });

        res.status(201).json({
            success: true,
            webhook: {
                ...webhook,
                signingSecret, // Show once at creation
            },
        });
    } catch (err) {
        logger.error('Create webhook error:', err);
        res.status(500).json({ success: false, error: 'Failed to create webhook.' });
    }
});

router.delete('/:workspaceId/webhooks/:webhookId', async (req: Request, res: Response): Promise<void> => {
    const userId = (req as any).userId as string;
    const { workspaceId, webhookId } = req.params as { workspaceId: string; webhookId: string };

    try {
        const membership = await verifyWorkspaceAccess(userId, workspaceId);
        if (!membership) {
            res.status(403).json({ success: false, error: 'Access denied.' });
            return;
        }

        const updated = await prisma.webhook.updateMany({
            where: { id: webhookId, workspaceId },
            data: { active: false },
        });

        if (updated.count === 0) {
            res.status(404).json({ success: false, error: 'Webhook not found.' });
            return;
        }

        res.json({ success: true });
    } catch (err) {
        logger.error('Delete webhook error:', err);
        res.status(500).json({ success: false, error: 'Failed to delete webhook.' });
    }
});

// ═══ PRODUCTS ═════════════════════════════════════════════════════════════════

router.get('/:workspaceId/products', async (req: Request, res: Response): Promise<void> => {
    const userId = (req as any).userId as string;
    const { workspaceId } = req.params as { workspaceId: string };

    try {
        const membership = await verifyWorkspaceAccess(userId, workspaceId);
        if (!membership) {
            res.status(403).json({ success: false, error: 'Access denied.' });
            return;
        }

        const products = await prisma.product.findMany({
            where: { workspaceId },
            select: {
                id: true,
                name: true,
                price: true,
                active: true,
                acceptedProviders: true,
                maxBuyers: true,
                createdAt: true,
                payoutAccounts: { select: { id: true, label: true } },
                _count: { select: { orders: true } },
            },
            orderBy: { createdAt: 'desc' },
        });

        res.json({ success: true, products });
    } catch (err) {
        logger.error('List products error:', err);
        res.status(500).json({ success: false, error: 'Failed to list products.' });
    }
});

router.post('/:workspaceId/products', async (req: Request, res: Response): Promise<void> => {
    const userId = (req as any).userId as string;
    const { workspaceId } = req.params as { workspaceId: string };
    const { name, price, acceptedProviders: rawProviders, payoutAccountIds: rawIds, description, maxBuyers } = req.body as {
        name?: string;
        price?: number;
        acceptedProviders?: unknown;
        payoutAccountIds?: unknown;
        description?: string;
        maxBuyers?: number;
    };

    const trimmedName = typeof name === 'string' ? name.trim() : '';
    if (!trimmedName) {
        res.status(400).json({ success: false, error: 'name is required.' });
        return;
    }
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
        res.status(400).json({ success: false, error: 'price must be a positive number.' });
        return;
    }
    const acceptedProviders = normaliseProviders(rawProviders);
    if (!acceptedProviders) {
        res.status(400).json({ success: false, error: 'acceptedProviders must be a non-empty array of supported providers.' });
        return;
    }
    const payoutAccountIds = normaliseIdList(rawIds);
    if (payoutAccountIds.length === 0) {
        res.status(400).json({ success: false, error: 'At least one payout account is required.' });
        return;
    }
    const cleanDescription = normaliseOptionalText(description);
    const buyers = resolvePositiveInteger(maxBuyers);
    if (buyers === 'invalid') {
        res.status(400).json({ success: false, error: 'maxBuyers must be a positive integer when provided.' });
        return;
    }

    try {
        const membership = await verifyWorkspaceAccess(userId, workspaceId);
        if (!membership) {
            res.status(403).json({ success: false, error: 'Access denied.' });
            return;
        }

        const payoutAccounts = await getWorkspacePayoutAccounts(workspaceId, payoutAccountIds);
        if (payoutAccounts.length !== payoutAccountIds.length) {
            res.status(400).json({ success: false, error: 'One or more payout accounts were not found.' });
            return;
        }
        const coverageError = ensureProviderCoverage(acceptedProviders, payoutAccounts);
        if (coverageError) {
            res.status(400).json({ success: false, error: coverageError });
            return;
        }

        const product = await prisma.$transaction(async (tx) => {
            const created = await tx.product.create({
                data: {
                    workspaceId,
                    name: trimmedName,
                    description: cleanDescription,
                    price,
                    acceptedProviders,
                    maxBuyers: buyers,
                    payoutAccounts: { connect: payoutAccounts.map((a) => ({ id: a.id })) },
                },
            });
            await tx.paymentLink.create({
                data: {
                    workspaceId,
                    productId: created.id,
                    creatorType: 'DASHBOARD',
                    name: created.name,
                    mode: 'PRODUCT',
                    fixedAmount: created.price,
                    acceptedProviders,
                    isDefaultForProduct: true,
                    payoutAccounts: { connect: payoutAccounts.map((a) => ({ id: a.id })) },
                },
            });
            return created;
        });

        res.status(201).json({ success: true, product });
    } catch (err) {
        logger.error('Create product error:', err);
        res.status(500).json({ success: false, error: 'Failed to create product.' });
    }
});

// ═══ ORDERS ═══════════════════════════════════════════════════════════════════

router.get('/:workspaceId/orders', async (req: Request, res: Response): Promise<void> => {
    const userId = (req as any).userId as string;
    const { workspaceId } = req.params as { workspaceId: string };
    const rawPage = Array.isArray(req.query.page) ? req.query.page[0] : req.query.page;
    const rawPageSize = Array.isArray(req.query.pageSize) ? req.query.pageSize[0] : req.query.pageSize;
    const page = Math.max(1, parseInt(String(rawPage ?? '1'), 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(String(rawPageSize ?? '25'), 10) || 25));

    try {
        const membership = await verifyWorkspaceAccess(userId, workspaceId);
        if (!membership) {
            res.status(403).json({ success: false, error: 'Access denied.' });
            return;
        }

        const where = { workspaceId };
        const [total, orders] = await Promise.all([
            prisma.order.count({ where }),
            prisma.order.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip: (page - 1) * pageSize,
                take: pageSize,
                select: {
                    id: true,
                    buyerName: true,
                    buyerEmail: true,
                    reference: true,
                    provider: true,
                    amountPaid: true,
                    status: true,
                    createdAt: true,
                    paymentLink: { select: { id: true, name: true } },
                    product: { select: { id: true, name: true } },
                },
            }),
        ]);

        res.json({
            success: true,
            orders,
            pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
        });
    } catch (err) {
        logger.error('List orders error:', err);
        res.status(500).json({ success: false, error: 'Failed to list orders.' });
    }
});

// ═══ MANUAL VERIFICATION ═════════════════════════════════════════════════════
// Verification history. The rows already exist — every successful verification
// records one so a replayed receipt can be recognised — but nothing could show
// them, so the replay flag was only visible in an API response. This is what
// makes the history a merchant can actually look at: which references they have
// accepted, when each was first seen, and how many times it has come back.
router.get('/:workspaceId/verifications', async (req: Request, res: Response): Promise<void> => {
    const userId = (req as any).userId as string;
    const { workspaceId } = req.params as { workspaceId: string };
    const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(String(req.query.pageSize ?? '25'), 10) || 25));

    try {
        const membership = await verifyWorkspaceAccess(userId, workspaceId);
        if (!membership) {
            res.status(403).json({ success: false, error: 'Access denied.' });
            return;
        }

        const where = { workspaceId };
        const [rows, total] = await Promise.all([
            prisma.verifiedTransaction.findMany({
                where,
                orderBy: { lastSeenAt: 'desc' },
                skip: (page - 1) * pageSize,
                take: pageSize,
                select: {
                    id: true, provider: true, reference: true, amount: true,
                    firstSeenAt: true, lastSeenAt: true, seenCount: true,
                },
            }),
            prisma.verifiedTransaction.count({ where }),
        ]);

        res.json({
            success: true,
            verifications: rows,
            pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
        });
    } catch (err) {
        logger.error('List verifications error:', err);
        res.status(500).json({ success: false, error: 'Failed to list verifications.' });
    }
});

router.post('/:workspaceId/verify', dashboardVerificationAccess(), ...createVerificationPipeline({ envelope: 'dashboard' }));

/**
 * Image verification for the dashboard, on the same terms as POST /verify-image.
 *
 * The browser cannot call that route directly: apiKeyAuth does not accept a
 * Bearer session token, and /verify-image is not on its skip list, so a
 * dashboard session alone gets 401. This mounts the identical handler behind
 * dashboardVerificationAccess() — which is what makes /dashboard/* reachable at
 * all — and then verifyImageGate, which enforces the tier ceiling and the
 * image-credit balance and sets resolvedAccount exactly as it does for API keys.
 *
 * A duplicate of the handler, not a wrapper, so the credit decrement, the OCR
 * call and the payout-account check cannot drift apart between the two entry
 * points.
 *
 * rateLimiter is not optional here. POST /verify-image has it (index.ts), and
 * without one on this route an image verification was unmetered from the
 * browser. That matters more now than it did: an unlimited workspace spends no
 * image credits, so credits are no longer what bounds how fast it can call
 * Mistral Vision, and an unmetered route is unbounded spend on someone else's
 * API key. It charges the workspace's normal plan rate limit.
 */
router.post(
    '/:workspaceId/verify-image',
    rateLimiter,
    dashboardVerificationAccess(),
    verifyImageGate,
    ...verifyImageHandler,
);

export default router;
