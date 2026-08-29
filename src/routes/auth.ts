/**
 * Auth routes — email/password signup + login + session management.
 *
 * POST   /auth/signup   — create user + default workspace, return session token
 * POST   /auth/login    — validate credentials, return session token
 * GET    /auth/me       — get current user + workspaces (requires session token)
 * POST   /auth/logout   — invalidate session
 *
 * Session tokens are JWTs signed with DASHBOARD_SECRET, stored in the Session
 * table. The dashboard (Next.js) stores the token in an httpOnly cookie and
 * sends it via Authorization: Bearer <token>.
 */

import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../utils/prisma';
import logger from '../utils/logger';

const router = Router();

const SESSION_TTL_DAYS = 30;
const TOKEN_PREFIX = 'nvd_sess_';

/**
 * Create a signed session token: nvd_sess_<random>.<hmac>
 * The HMAC binds the token to DASHBOARD_SECRET so it can't be forged.
 */
function createSessionToken(userId: string): string {
    const random = crypto.randomBytes(24).toString('hex');
    const payload = `${userId}.${random}`;
    const hmac = crypto.createHmac('sha256', process.env.DASHBOARD_SECRET || 'fallback-secret')
        .update(payload)
        .digest('hex');
    return `${TOKEN_PREFIX}${payload}.${hmac}`;
}

/**
 * Verify a session token. Returns userId if valid, null otherwise.
 */
function verifySessionToken(token: string): { userId: string } | null {
    if (!token.startsWith(TOKEN_PREFIX)) return null;
    const rest = token.slice(TOKEN_PREFIX.length);
    const lastDot = rest.lastIndexOf('.');
    if (lastDot === -1) return null;
    const payload = rest.slice(0, lastDot);
    const hmac = rest.slice(lastDot + 1);
    const expectedHmac = crypto.createHmac('sha256', process.env.DASHBOARD_SECRET || 'fallback-secret')
        .update(payload)
        .digest('hex');
    if (hmac !== expectedHmac) return null;
    const [userId] = payload.split('.');
    return { userId };
}

/**
 * Hash a password with bcrypt (cost factor 10 — ~100ms per hash, good balance).
 */
async function hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, 10);
}

/**
 * Verify a password against a bcrypt hash.
 */
async function verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
}

// ─── Signup ──────────────────────────────────────────────────────────────────

router.post('/signup', async (req: Request, res: Response): Promise<void> => {
    const { email, password, name } = req.body as {
        email?: string;
        password?: string;
        name?: string;
    };

    if (!email || !password) {
        res.status(400).json({ success: false, error: 'Email and password are required.' });
        return;
    }
    if (password.length < 8) {
        res.status(400).json({ success: false, error: 'Password must be at least 8 characters.' });
        return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        res.status(400).json({ success: false, error: 'Invalid email format.' });
        return;
    }

    try {
        // Check if user already exists
        const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
        if (existing) {
            res.status(409).json({ success: false, error: 'An account with this email already exists.' });
            return;
        }

        // Hash password
        const passwordHash = await hashPassword(password);

        // Create user + default workspace + membership in a transaction
        const userId = `usr_${crypto.randomBytes(12).toString('hex')}`;
        const workspaceId = `ws_${crypto.randomBytes(12).toString('hex')}`;

        await prisma.$transaction([
            prisma.user.create({
                data: {
                    id: userId,
                    email: email.toLowerCase(),
                    name: name || email.split('@')[0],
                    // Store password hash in the Account table (NextAuth pattern:
                    // provider='credentials', providerAccountId=userId)
                    accounts: {
                        create: {
                            id: `acc_${crypto.randomBytes(12).toString('hex')}`,
                            provider: 'credentials',
                            providerAccountId: userId,
                            type: 'credentials',
                            passwordHash,
                        },
                    },
                },
            }),
            prisma.workspace.create({
                data: {
                    id: workspaceId,
                    name: `${name || email.split('@')[0]}'s Workspace`,
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

        // Create session
        const token = createSessionToken(userId);
        const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
        await prisma.session.create({
            data: {
                sessionToken: token,
                userId,
                expires: expiresAt,
            },
        });

        logger.info(`New user signed up: ${email}`);

        res.status(201).json({
            success: true,
            token,
            user: {
                id: userId,
                email: email.toLowerCase(),
                name: name || email.split('@')[0],
            },
            workspace: {
                id: workspaceId,
                name: `${name || email.split('@')[0]}'s Workspace`,
                tier: 'FREE',
            },
        });
    } catch (err) {
        logger.error('Signup error:', err);
        res.status(500).json({ success: false, error: 'Failed to create account.' });
    }
});

// ─── Login ───────────────────────────────────────────────────────────────────

router.post('/login', async (req: Request, res: Response): Promise<void> => {
    const { email, password } = req.body as { email?: string; password?: string };

    if (!email || !password) {
        res.status(400).json({ success: false, error: 'Email and password are required.' });
        return;
    }

    try {
        const user = await prisma.user.findUnique({
            where: { email: email.toLowerCase() },
            include: {
                accounts: {
                    where: { provider: 'credentials' },
                    select: { passwordHash: true },
                    take: 1,
                },
            },
        });

        if (!user || user.accounts.length === 0) {
            res.status(401).json({ success: false, error: 'Invalid email or password.' });
            return;
        }

        const valid = await verifyPassword(password, user.accounts[0].passwordHash || '');
        if (!valid) {
            res.status(401).json({ success: false, error: 'Invalid email or password.' });
            return;
        }

        // Create session
        const token = createSessionToken(user.id);
        const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
        await prisma.session.create({
            data: {
                sessionToken: token,
                userId: user.id,
                expires: expiresAt,
            },
        });

        logger.info(`User logged in: ${email}`);

        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
            },
        });
    } catch (err) {
        logger.error('Login error:', err);
        res.status(500).json({ success: false, error: 'Failed to login.' });
    }
});

// ─── Get current user ────────────────────────────────────────────────────────

router.get('/me', async (req: Request, res: Response): Promise<void> => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : req.cookies?.session || '';

    if (!token) {
        res.status(401).json({ success: false, error: 'Not authenticated.' });
        return;
    }

    const sessionData = verifySessionToken(token);
    if (!sessionData) {
        res.status(401).json({ success: false, error: 'Invalid session.' });
        return;
    }

    try {
        // Check session in DB (not expired, not deleted)
        const session = await prisma.session.findUnique({
            where: { sessionToken: token },
            include: {
                user: {
                    select: {
                        id: true,
                        email: true,
                        name: true,
                        role: true,
                        currentWorkspaceId: true,
                    },
                },
            },
        });

        if (!session || session.expires < new Date()) {
            res.status(401).json({ success: false, error: 'Session expired.' });
            return;
        }

        // Get user's workspaces
        const memberships = await prisma.membership.findMany({
            where: { userId: session.userId },
            include: {
                workspace: {
                    select: {
                        id: true,
                        name: true,
                        tier: true,
                        verificationCredits: true,
                        verificationCreditsMonthly: true,
                        imageCredits: true,
                        imageCreditsMonthly: true,
                    },
                },
            },
        });

        res.json({
            success: true,
            user: session.user,
            workspaces: memberships.map((m) => ({
                ...m.workspace,
                role: m.role,
            })),
        });
    } catch (err) {
        logger.error('Get user error:', err);
        res.status(500).json({ success: false, error: 'Failed to get user data.' });
    }
});

// ─── Logout ──────────────────────────────────────────────────────────────────

router.post('/logout', async (req: Request, res: Response): Promise<void> => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : req.cookies?.session || '';

    if (token) {
        try {
            await prisma.session.deleteMany({ where: { sessionToken: token } });
        } catch {
            // ignore — session may already be deleted
        }
    }

    res.json({ success: true });
});

// ─── Auth middleware for dashboard routes ────────────────────────────────────

/**
 * Middleware that requires a valid session token.
 * Sets req.user = { id, email, name } on success.
 * Use this to protect dashboard-facing endpoints (workspace management, etc.)
 */
export function requireSession(req: Request, res: Response, next: NextFunction): void {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : req.cookies?.session || '';

    if (!token) {
        res.status(401).json({ success: false, error: 'Authentication required.' });
        return;
    }

    const sessionData = verifySessionToken(token);
    if (!sessionData) {
        res.status(401).json({ success: false, error: 'Invalid session.' });
        return;
    }

    // Attach to request for downstream handlers
    (req as any).userId = sessionData.userId;
    next();
}

export default router;
