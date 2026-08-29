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
 * PATCH  /workspaces/:id          — update workspace name/settings
 * DELETE /workspaces/:id          — delete workspace (soft delete)
 * GET    /workspaces/:id/stats    — revenue + payment stats for this workspace
 * GET    /workspaces/:id/payments — recent payments (orders) for this workspace
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../utils/prisma';
import logger from '../utils/logger';
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

router.post('/', async (req: Request, res: Response): Promise<void> => {
    const userId = (req as any).userId as string;
    const { name, description } = req.body as { name?: string; description?: string };

    if (!name || name.trim().length < 2) {
        res.status(400).json({ success: false, error: 'Workspace name is required (min 2 characters).' });
        return;
    }

    try {
        const workspaceId = `ws_${crypto.randomBytes(12).toString('hex')}`;

        const workspace = await prisma.workspace.create({
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
        });

        await prisma.membership.create({
            data: {
                userId,
                workspaceId,
                role: 'OWNER',
            },
        });

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
    const workspaceId = req.params.id;

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
    const workspaceId = req.params.id;

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
    const workspaceId = req.params.id;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = parseInt(req.query.offset as string) || 0;

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
            take: Math.min(limit, 100),
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

router.patch('/:id', async (req: Request, res: Response): Promise<void> => {
    const userId = (req as any).userId as string;
    const workspaceId = req.params.id;
    const { name } = req.body as { name?: string };

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
            data: name ? { name: name.trim() } : {},
            select: { id: true, name: true, tier: true },
        });

        res.json({ success: true, workspace: updated });
    } catch (err) {
        logger.error('Update workspace error:', err);
        res.status(500).json({ success: false, error: 'Failed to update workspace.' });
    }
});

export default router;
