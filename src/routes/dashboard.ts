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
    const { workspaceId } = req.params;

    try {
        const membership = await verifyWorkspaceAccess(userId, workspaceId);
        if (!membership) {
            res.status(403).json({ success: false, error: 'Access denied.' });
            return;
        }

        const apiKeys = await prisma.apiKey.findMany({
            where: { workspaceId },
            select: {
                id: true,
                prefix: true,
                usageCount: true,
                lastUsed: true,
                isActive: true,
                createdAt: true,
                permissions: true,
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
    const { workspaceId } = req.params;
    const { label } = req.body as { label?: string };

    try {
        const membership = await verifyWorkspaceAccess(userId, workspaceId);
        if (!membership) {
            res.status(403).json({ success: false, error: 'Access denied.' });
            return;
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
            },
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
            },
        });
    } catch (err) {
        logger.error('Create API key error:', err);
        res.status(500).json({ success: false, error: 'Failed to create API key.' });
    }
});

router.delete('/:workspaceId/api-keys/:keyId', async (req: Request, res: Response): Promise<void> => {
    const userId = (req as any).userId as string;
    const { workspaceId, keyId } = req.params;

    try {
        const membership = await verifyWorkspaceAccess(userId, workspaceId);
        if (!membership) {
            res.status(403).json({ success: false, error: 'Access denied.' });
            return;
        }

        await prisma.apiKey.update({
            where: { id: keyId, workspaceId },
            data: { isActive: false },
        });

        res.json({ success: true });
    } catch (err) {
        logger.error('Revoke API key error:', err);
        res.status(500).json({ success: false, error: 'Failed to revoke API key.' });
    }
});

// ═══ PAYOUT ACCOUNTS ════════════════════════════════════════════════════════

router.get('/:workspaceId/payouts', async (req: Request, res: Response): Promise<void> => {
    const userId = (req as any).userId as string;
    const { workspaceId } = req.params;

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
    const { workspaceId } = req.params;
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

        const payout = await prisma.payoutAccount.create({
            data: {
                workspaceId,
                label,
                accountHolderName,
                type,
                account,
                providersAllowed: providersAllowed || ['telebirr'],
                isDefault: false,
                active: true,
            },
        });

        res.status(201).json({ success: true, payout });
    } catch (err) {
        logger.error('Create payout error:', err);
        res.status(500).json({ success: false, error: 'Failed to create payout account.' });
    }
});

router.delete('/:workspaceId/payouts/:payoutId', async (req: Request, res: Response): Promise<void> => {
    const userId = (req as any).userId as string;
    const { workspaceId, payoutId } = req.params;

    try {
        const membership = await verifyWorkspaceAccess(userId, workspaceId);
        if (!membership) {
            res.status(403).json({ success: false, error: 'Access denied.' });
            return;
        }

        await prisma.payoutAccount.update({
            where: { id: payoutId, workspaceId },
            data: { active: false },
        });

        res.json({ success: true });
    } catch (err) {
        logger.error('Delete payout error:', err);
        res.status(500).json({ success: false, error: 'Failed to delete payout account.' });
    }
});

// ═══ PAYMENT LINKS ══════════════════════════════════════════════════════════

router.get('/:workspaceId/payment-links', async (req: Request, res: Response): Promise<void> => {
    const userId = (req as any).userId as string;
    const { workspaceId } = req.params;

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
    const { workspaceId } = req.params;
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
                redirectUrl: redirectUrl || null,
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
    const { workspaceId } = req.params;

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
    const { workspaceId } = req.params;
    const { url, events } = req.body as { url?: string; events?: string[] };

    if (!url || !events || events.length === 0) {
        res.status(400).json({ success: false, error: 'url and events are required.' });
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
                url,
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
    const { workspaceId, webhookId } = req.params;

    try {
        const membership = await verifyWorkspaceAccess(userId, workspaceId);
        if (!membership) {
            res.status(403).json({ success: false, error: 'Access denied.' });
            return;
        }

        await prisma.webhook.update({
            where: { id: webhookId, workspaceId },
            data: { active: false },
        });

        res.json({ success: true });
    } catch (err) {
        logger.error('Delete webhook error:', err);
        res.status(500).json({ success: false, error: 'Failed to delete webhook.' });
    }
});

export default router;
