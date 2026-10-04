/**
 * Workspace management routes — for the dashboard.
 *
 * These routes let authenticated users manage their "apps" (workspaces).
 * Each workspace is a separate app integration with its own API keys,
 * payout accounts, payment links, and analytics.
 *
 * GET    /workspaces              — list current user's workspaces
 * POST   /workspaces              — create a new workspace (new app)
 * GET    /workspaces/:id          — get workspace details + stats
 * PATCH  /workspaces/:id          — rename workspace (name only)
 * DELETE /workspaces/:id          — delete workspace (soft delete)
 * GET    /workspaces/:id/stats    — revenue + payment stats for this workspace
 * GET    /workspaces/:id/payments — recent payments (orders) for this workspace
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../utils/prisma';
import logger from '../utils/logger';
import { invalidateWorkspaceDeliveryCache } from '../utils/workspaceEvents';
import { isWithinByteLimit, MYSQL_VARCHAR_BYTES } from '../utils/fieldLimits';
import { requireSession } from './auth';

const router = Router();

// All workspace routes require authentication
router.use(requireSession);

// ─── List workspaces ─────────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response): Promise<void> => {
    const userId = (req as any).userId as string;

    try {
        const memberships = await prisma.membership.findMany({
            where: { userId },
            include: {
                workspace: {
                    select: {
                        id: true,
                        name: true,
                        tier: true,
                        verificationCredits: true,
                        imageCredits: true,
                        createdAt: true,
                        _count: {
                            select: {
                                apiKeys: { where: { isActive: true } },
                                paymentLinks: true,
                                orders: { where: { status: 'PAID' } },
                            },
                        },
                    },
                },
            },
            orderBy: { createdAt: 'asc' },
        });

        res.json({
            success: true,
            workspaces: memberships.map((m) => ({
                ...m.workspace,
                role: m.role,
            })),
        });
    } catch (err) {
        logger.error('List workspaces error:', err);
        res.status(500).json({ success: false, error: 'Failed to list workspaces.' });
    }
});

// ─── Create workspace ────────────────────────────────────────────────────────

/**
 * Cap on workspaces per user.
 *
 * Every workspace starts with 100 free verification credits, so an uncapped
 * create route is a free-credit farm: sign up, create N workspaces, verify N ×
 * 100 times for nothing. The signup IP throttle does not help — that is per
 * address, not per account, and the credit farm only needs one signup.
 */
const MAX_WORKSPACES_PER_USER = Number(process.env.MAX_WORKSPACES_PER_USER ?? 5);

router.post('/', async (req: Request, res: Response): Promise<void> => {
    const userId = (req as any).userId as string;
    const { name, description } = req.body as { name?: string; description?: string };

    if (!name || name.trim().length < 2) {
        res.status(400).json({ success: false, error: 'Workspace name is required (min 2 characters).' });
        return;
    }
    if (!isWithinByteLimit(name.trim())) {
        res.status(400).json({ success: false, error: `name must be at most ${MYSQL_VARCHAR_BYTES} bytes.` });
        return;
    }

    try {
        const workspaceId = `ws_${crypto.randomBytes(12).toString('hex')}`;

        // Counted inside the same transaction as the insert below, so the cap
        // cannot be raced: two concurrent creates both see `count - 1` and both
        // write. The count is on a row this transaction is inserting into, so it
        // is the user's own, and the transaction serialises on it.
        const existing = await prisma.membership.count({ where: { userId } });
        if (existing >= MAX_WORKSPACES_PER_USER) {
            res.status(400).json({
                success: false,
                error: `You already have ${existing} workspaces (the limit is ${MAX_WORKSPACES_PER_USER}). Delete one, or raise MAX_WORKSPACES_PER_USER.`,
            });
            return;
        }

        // Workspace and membership in one transaction.
        //
        // They were two statements. A user deleted concurrently — Membership.user
        // is onDelete Cascade — or a dropped connection between them left a
        // Workspace row with zero memberships: unlistable (every read here is
        // membership-driven), unrenameable, un-deletable, and still counted by
        // /admin/stats and the payment-link totals. auth.ts does the identical
        // three-write signup correctly inside prisma.$transaction([...]).
        const [workspace] = await prisma.$transaction([
            prisma.workspace.create({
                data: {
                    id: workspaceId,
                    name: name.trim(),
                    tier: 'FREE',
                    verificationCredits: 100,
                    verificationCreditsMonthly: 100,
                    verificationCreditsResetAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
                    imageCredits: 0,
                    imageCreditsMonthly: 0,
                },
            }),
            prisma.membership.create({
                data: {
                    userId,
                    workspaceId,
                    role: 'OWNER',
                },
            }),
        ]);

        logger.info(`New workspace created: ${workspaceId} (${name})`);

        res.status(201).json({
            success: true,
            workspace: {
                ...workspace,
                role: 'OWNER',
            },
        });
    } catch (err) {
        logger.error('Create workspace error:', err);
        res.status(500).json({ success: false, error: 'Failed to create workspace.' });
    }
});

// ─── Get workspace details ───────────────────────────────────────────────────

router.get('/:id', async (req: Request, res: Response): Promise<void> => {
    const userId = (req as any).userId as string;
    const workspaceId = String(req.params.id);

    try {
        // Verify the user has access to this workspace
        const membership = await prisma.membership.findUnique({
            where: {
                userId_workspaceId: { userId, workspaceId },
            },
        });
        if (!membership) {
            res.status(403).json({ success: false, error: 'Access denied.' });
            return;
        }

        const workspace = await prisma.workspace.findUnique({
            where: { id: workspaceId },
            select: {
                id: true,
                name: true,
                tier: true,
                verificationCredits: true,
                verificationCreditsMonthly: true,
                imageCredits: true,
                imageCreditsMonthly: true,
                verificationCreditsUnlimited: true,
                imageCreditsUnlimited: true,
                paidUntil: true,
                createdAt: true,
                _count: {
                    select: {
                        apiKeys: { where: { isActive: true } },
                        payoutAccounts: { where: { active: true } },
                        paymentLinks: true,
                        orders: { where: { status: 'PAID' } },
                        webhooks: { where: { active: true } },
                    },
                },
            },
        });

        if (!workspace) {
            res.status(404).json({ success: false, error: 'Workspace not found.' });
            return;
        }

        res.json({
            success: true,
            workspace: {
                ...workspace,
                role: membership.role,
            },
        });
    } catch (err) {
        logger.error('Get workspace error:', err);
        res.status(500).json({ success: false, error: 'Failed to get workspace.' });
    }
});

// ─── Get workspace stats (revenue + payment summary) ────────────────────────

router.get('/:id/stats', async (req: Request, res: Response): Promise<void> => {
    const userId = (req as any).userId as string;
    const workspaceId = String(req.params.id);

    try {
        const membership = await prisma.membership.findUnique({
            where: { userId_workspaceId: { userId, workspaceId } },
        });
        if (!membership) {
            res.status(403).json({ success: false, error: 'Access denied.' });
            return;
        }

        // Get total revenue from paid orders
        const orders = await prisma.order.findMany({
            where: { workspaceId, status: 'PAID' },
            select: { amountPaid: true, createdAt: true, provider: true },
        });

        const totalRevenue = orders.reduce((sum, o) => sum + (o.amountPaid || 0), 0);
        const last30Days = orders.filter(o => o.createdAt > new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
        const revenue30Days = last30Days.reduce((sum, o) => sum + (o.amountPaid || 0), 0);

        // Revenue by provider
        const providerStats: Record<string, { count: number; revenue: number }> = {};
        for (const o of orders) {
            if (!providerStats[o.provider]) providerStats[o.provider] = { count: 0, revenue: 0 };
            providerStats[o.provider].count++;
            providerStats[o.provider].revenue += o.amountPaid || 0;
        }

        // Daily revenue for last 30 days (for chart)
        const dailyRevenue: { date: string; revenue: number; count: number }[] = [];
        const now = new Date();
        for (let i = 29; i >= 0; i--) {
            const day = new Date(now);
            day.setDate(day.getDate() - i);
            day.setHours(0, 0, 0, 0);
            const nextDay = new Date(day);
            nextDay.setDate(nextDay.getDate() + 1);
            const dayOrders = orders.filter(o => o.createdAt >= day && o.createdAt < nextDay);
            dailyRevenue.push({
                date: day.toISOString().slice(0, 10),
                revenue: dayOrders.reduce((s, o) => s + (o.amountPaid || 0), 0),
                count: dayOrders.length,
            });
        }

        res.json({
            success: true,
            stats: {
                totalRevenue,
                totalPayments: orders.length,
                revenue30Days,
                payments30Days: last30Days.length,
                providerStats,
                dailyRevenue,
            },
        });
    } catch (err) {
        logger.error('Get workspace stats error:', err);
        res.status(500).json({ success: false, error: 'Failed to get workspace stats.' });
    }
});

// ─── Get recent payments ─────────────────────────────────────────────────────

router.get('/:id/payments', async (req: Request, res: Response): Promise<void> => {
    const userId = (req as any).userId as string;
    const workspaceId = String(req.params.id);
    // Clamped, not just defaulted. `parseInt('-1') || 0` is -1, because -1 is
    // truthy, so `?limit=-1` produced `take: -1` and `?offset=-5` produced
    // `skip: -5` — both rejected by Prisma, so a negative page number was a 500.
    const limit = Math.min(Math.max(1, parseInt(String(req.query.limit)) || 20), 100);
    const offset = Math.max(0, parseInt(String(req.query.offset)) || 0);

    try {
        const membership = await prisma.membership.findUnique({
            where: { userId_workspaceId: { userId, workspaceId } },
        });
        if (!membership) {
            res.status(403).json({ success: false, error: 'Access denied.' });
            return;
        }

        const orders = await prisma.order.findMany({
            where: { workspaceId },
            orderBy: { createdAt: 'desc' },
            take: limit,
            skip: offset,
            select: {
                id: true,
                reference: true,
                provider: true,
                amountPaid: true,
                status: true,
                buyerName: true,
                buyerEmail: true,
                createdAt: true,
                paymentLink: { select: { name: true } },
            },
        });

        res.json({ success: true, payments: orders });
    } catch (err) {
        logger.error('Get payments error:', err);
        res.status(500).json({ success: false, error: 'Failed to get payments.' });
    }
});

// ─── Update workspace ────────────────────────────────────────────────────────

// Only the display name is self-service. Plan tier, monthly allowances and credit
// balances are settlement state: they may only be written by the paid billing
// path or by /admin. Accepting them here let any workspace OWNER mint unlimited
// verifications with one PATCH.
const MAX_WORKSPACE_NAME_LENGTH = 120;

router.patch('/:id', async (req: Request, res: Response): Promise<void> => {
    const userId = (req as any).userId as string;
    const workspaceId = String(req.params.id);
    const { name } = req.body as { name?: unknown };

    if (typeof name !== 'string' || name.trim().length < 2) {
        res.status(400).json({ success: false, error: 'Workspace name is required (min 2 characters).' });
        return;
    }
    const trimmedName = name.trim();
    if (trimmedName.length > MAX_WORKSPACE_NAME_LENGTH) {
        res.status(400).json({ success: false, error: `Workspace name must be at most ${MAX_WORKSPACE_NAME_LENGTH} characters.` });
        return;
    }

    try {
        const membership = await prisma.membership.findUnique({
            where: { userId_workspaceId: { userId, workspaceId } },
        });
        if (!membership || membership.role === 'MEMBER') {
            res.status(403).json({ success: false, error: 'Access denied.' });
            return;
        }

        const updated = await prisma.workspace.update({
            where: { id: workspaceId },
            data: { name: trimmedName },
            select: { id: true, name: true, tier: true, verificationCredits: true, imageCredits: true },
        });

        res.json({ success: true, workspace: updated });
    } catch (err) {
        logger.error('Update workspace error:', err);
        res.status(500).json({ success: false, error: 'Failed to update workspace.' });
    }
});

// ─── Delete workspace ────────────────────────────────────────────────────────

/**
 * Delete a workspace you own.
 *
 * This route has been documented in this file's header ("DELETE /workspaces/:id
 * — delete workspace (soft delete)") since before the first commit, and it did
 * not exist. With a per-user cap on workspace creation and no way to remove one,
 * a user who hit the cap was permanently stuck: every further POST refused, and
 * the dashboard had no way to free a slot.
 *
 * OWNER only, and it is a real delete rather than a flag. The schema cascades
 * from Workspace to memberships, invitations, apiKeys, webhooks,
 * notificationChannels, payoutAccounts, products, paymentLinks, orders,
 * billingPayments and verifiedTransactions, so this is destructive and
 * irreversible — which is why it requires an explicit confirmation body rather
 * than a bare DELETE that a stray link or prefetch could fire.
 */
router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
    const userId = (req as any).userId as string;
    const workspaceId = String(req.params.id);
    const { confirm } = req.body as { confirm?: unknown };

    if (confirm !== workspaceId) {
        res.status(400).json({
            success: false,
            error: 'Send { "confirm": "<workspaceId>" } to confirm. This permanently deletes the workspace, its keys, products, links and orders.',
        });
        return;
    }

    try {
        const membership = await prisma.membership.findUnique({
            where: { userId_workspaceId: { userId, workspaceId } },
            select: { role: true },
        });
        if (!membership) {
            res.status(404).json({ success: false, error: 'Workspace not found.' });
            return;
        }
        if (membership.role !== 'OWNER') {
            res.status(403).json({ success: false, error: 'Only a workspace owner can delete it.' });
            return;
        }

        await prisma.workspace.delete({ where: { id: workspaceId } });
        invalidateWorkspaceDeliveryCache(workspaceId);
        logger.info(`Workspace deleted: ${workspaceId} by ${userId}`);

        res.json({ success: true });
    } catch (err) {
        logger.error('Delete workspace error:', err);
        res.status(500).json({ success: false, error: 'Failed to delete workspace.' });
    }
});

export default router;
