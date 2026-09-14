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
import { isResetEmailConfigured, sendPasswordResetEmail } from '../utils/passwordResetEmail';

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

// ─── Password reset ──────────────────────────────────────────────────────────

const RESET_TOKEN_TTL_MINUTES = 30;
const RESET_IDENTIFIER_PREFIX = 'pwreset:';

/** Where the dashboard's reset page lives (the emailed link points here). */
function resetPageUrl(rawToken: string): string {
    const base = (process.env.VERITAS_APP_URL || 'http://localhost:3000').replace(/\/$/, '');
    return `${base}/reset-password?token=${rawToken}`;
}

function hashResetToken(rawToken: string): string {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Issue a password-reset token for a user. Any previous outstanding token for
 * the same user is invalidated (single active token per user). Returns the
 * RAW token — only its sha256 hash is persisted.
 *
 * Exported so /admin/password-reset-link can issue links when email delivery
 * is not configured (admin-assisted reset).
 */
export async function createPasswordResetToken(userId: string): Promise<{ rawToken: string; expiresAt: Date }> {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const identifier = `${RESET_IDENTIFIER_PREFIX}${userId}`;
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000);

    await prisma.$transaction([
        prisma.verificationToken.deleteMany({ where: { identifier } }),
        prisma.verificationToken.create({
            data: { identifier, token: hashResetToken(rawToken), expires: expiresAt },
        }),
    ]);

    return { rawToken, expiresAt };
}

// Simple in-memory throttle so forgot-password can't be used to spam email
// (or probe accounts by timing). Max 3 requests per email per 15 minutes.
const forgotThrottle = new Map<string, { count: number; windowStart: number }>();
const FORGOT_WINDOW_MS = 15 * 60 * 1000;
const FORGOT_MAX_PER_WINDOW = 3;

function forgotAllowed(email: string): boolean {
    const now = Date.now();
    const entry = forgotThrottle.get(email);
    if (!entry || now - entry.windowStart > FORGOT_WINDOW_MS) {
        forgotThrottle.set(email, { count: 1, windowStart: now });
        return true;
    }
    entry.count += 1;
    return entry.count <= FORGOT_MAX_PER_WINDOW;
}

router.post('/forgot-password', async (req: Request, res: Response): Promise<void> => {
    const { email } = req.body as { email?: string };

    if (!email || typeof email !== 'string') {
        res.status(400).json({ success: false, error: 'Email is required.' });
        return;
    }

    const uniformResponse = {
        success: true,
        message: 'If an account exists for that email, a password reset link has been sent.',
    };

    const normalizedEmail = email.toLowerCase().trim();
    if (!forgotAllowed(normalizedEmail)) {
        res.json(uniformResponse);
        return;
    }

    try {
        const user = await prisma.user.findUnique({
            where: { email: normalizedEmail },
            include: {
                accounts: { where: { provider: 'credentials' }, select: { id: true }, take: 1 },
            },
        });

        if (user && user.accounts.length > 0) {
            const { rawToken } = await createPasswordResetToken(user.id);

            if (isResetEmailConfigured()) {
                try {
                    await sendPasswordResetEmail({
                        to: normalizedEmail,
                        name: user.name,
                        resetUrl: resetPageUrl(rawToken),
                        ttlMinutes: RESET_TOKEN_TTL_MINUTES,
                    });
                    logger.info(`Password reset email sent to ${normalizedEmail}`);
                } catch (emailErr) {
                    logger.error('Password reset email failed:', emailErr);
                }
            } else {
                logger.warn(
                    `Password reset requested for ${normalizedEmail} but RESEND_API_KEY is not configured. ` +
                    'Use POST /admin/password-reset-link (x-admin-key) to issue a link manually.'
                );
            }
        }

        res.json(uniformResponse);
    } catch (err) {
        logger.error('Forgot password error:', err);
        res.json(uniformResponse);
    }
});

router.post('/reset-password', async (req: Request, res: Response): Promise<void> => {
    const { token, password } = req.body as { token?: string; password?: string };

    if (!token || typeof token !== 'string') {
        res.status(400).json({ success: false, error: 'Reset token is required.' });
        return;
    }
    if (!password || password.length < 8) {
        res.status(400).json({ success: false, error: 'Password must be at least 8 characters.' });
        return;
    }

    try {
        const record = await prisma.verificationToken.findUnique({
            where: { token: hashResetToken(token) },
        });

        if (!record || !record.identifier.startsWith(RESET_IDENTIFIER_PREFIX)) {
            res.status(400).json({ success: false, error: 'Invalid or expired reset link.' });
            return;
        }
        if (record.expires < new Date()) {
            await prisma.verificationToken.deleteMany({ where: { token: record.token } });
            res.status(400).json({ success: false, error: 'Invalid or expired reset link.' });
            return;
        }

        const userId = record.identifier.slice(RESET_IDENTIFIER_PREFIX.length);
        const passwordHash = await bcrypt.hash(password, 10);

        await prisma.$transaction([
            prisma.verificationToken.deleteMany({ where: { token: record.token } }),
            prisma.account.updateMany({
                where: { userId, provider: 'credentials' },
                data: { passwordHash },
            }),
            prisma.session.deleteMany({ where: { userId } }),
        ]);

        logger.info(`Password reset completed for user ${userId}`);
        res.json({ success: true, message: 'Password updated. Please log in with your new password.' });
    } catch (err) {
        logger.error('Reset password error:', err);
        res.status(500).json({ success: false, error: 'Failed to reset password.' });
    }
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
