/**
 * Auth routes — email/password signup + login + session management.
 *
 * POST   /auth/signup   — create user + default workspace, return session token
 * POST   /auth/login    — validate credentials, return session token
 * GET    /auth/me       — get current user + workspaces (requires session token)
 * POST   /auth/logout   — invalidate session
 *
 * Session tokens are HMAC-signed with DASHBOARD_SECRET and stored in the
 * Session table. A valid signature is not enough on its own: every request also
 * re-checks the row, so logout and the 30-day expiry really revoke access.
 */

import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../utils/prisma';
import { resolveAppUrl } from '../config/appUrl';
import logger from '../utils/logger';
import { safeSecretEquals } from '../utils/secretCompare';
import { MemoryWindowCounter } from '../utils/expiringStore';
import { getRequestIp } from '../utils/requestIp';
import { isResetEmailConfigured, sendPasswordResetEmail } from '../utils/passwordResetEmail';

const router = Router();

const SESSION_TTL_DAYS = 30;
const TOKEN_PREFIX = 'nvd_sess_';

/**
 * The value stored in `Session.sessionToken`.
 *
 * sha256 of the bearer token, not the token itself. The column is the indexed
 * lookup key for every authenticated request, so storing the credential meant any
 * read of the table — a backup, a replica, a `mysqldump`, a SQL injection
 * elsewhere, a leaked `.sql` — yielded immediately usable 30-day sessions for
 * every logged-in user, with nothing to crack.
 *
 * ApiKey already stored `keyHash` for exactly this reason; Session did not.
 * Lookup is by hash, so the hash is the whole key space: there is no need to
 * also index the raw token, and no reason to keep it.
 *
 * sha256 rather than bcrypt/bcrypt-like work factors because the input is 24
 * bytes of `crypto.randomBytes` — there is no dictionary to search, so a slow
 * KDF buys nothing and costs a round trip per request.
 */
function hashSessionToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Create a signed session token: nvd_sess_<random>.<hmac>
 * The HMAC binds the token to DASHBOARD_SECRET so it can't be forged.
 */
function createSessionToken(userId: string): string {
    const random = crypto.randomBytes(24).toString('hex');
    const payload = `${userId}.${random}`;
    const hmac = signSessionPayload(payload);
    return `${TOKEN_PREFIX}${payload}.${hmac}`;
}

/**
 * Sign a session payload. Fails closed when DASHBOARD_SECRET is unset: a
 * published fallback key would let anyone mint a token for any userId, so
 * there is deliberately no default here.
 */
function signSessionPayload(payload: string): string {
    const secret = process.env.DASHBOARD_SECRET;
    if (!secret) {
        throw new Error('DASHBOARD_SECRET is required to issue session tokens.');
    }
    return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Verify a session token. Returns userId if valid, null otherwise.
 *
 * The HMAC only proves the token was minted by this server with the current
 * secret. It is not sufficient on its own: the token must also still exist and
 * not be expired. `requireSession` enforces both against the Session table.
 */
function verifySessionToken(token: string): { userId: string } | null {
    if (!token.startsWith(TOKEN_PREFIX)) return null;
    const rest = token.slice(TOKEN_PREFIX.length);
    const lastDot = rest.lastIndexOf('.');
    if (lastDot === -1) return null;
    const payload = rest.slice(0, lastDot);
    const hmac = rest.slice(lastDot + 1);
    if (!/^[a-f0-9]{64}$/.test(hmac)) return null;
    if (!process.env.DASHBOARD_SECRET) return null;
    const expectedHmac = signSessionPayload(payload);
    if (!safeSecretEquals(hmac, expectedHmac)) return null;
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
    // Each signup costs a bcrypt hash plus two writes, and the route is
    // unauthenticated: cap how many one client can create per hour.
    if (!signupAllowed(getRequestIp(req))) {
        res.status(429).json({ success: false, error: 'Too many accounts created from this address. Try again later.' });
        return;
    }

    try {
        // Not an enumeration oracle.
        //
        // /auth/login goes out of its way to answer identically for a registered
        // address and a wrong password, and /auth/forgot-password returns a
        // uniform body. Signup handed the same answer away unauthenticated, with
        // a 409 saying so, before any password hashing. Combined with the signup
        // IP throttle that is a free list of which addresses hold accounts.
        //
        // Respond 201 either way. A duplicate still gets `token: null` and no
        // session, so the caller cannot tell from the body; the genuine case is
        // distinguishable only by whether a token came back, which is the
        // information the caller already supplied.
        const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
        if (existing) {
            logger.info(`Signup attempted for an address that already exists: ${email.toLowerCase()}`);
            res.status(201).json({
                success: true,
                token: null,
                message: 'If this address can be registered, it has been.',
            });
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
                sessionToken: hashSessionToken(token),
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

    const normalisedEmail = normaliseEmail(email);
    if (!normalisedEmail) {
        // Same shape as a wrong password: never reveal whether the address is
        // registered, and never spend bcrypt on garbage input.
        res.status(401).json({ success: false, error: 'Invalid email or password.' });
        return;
    }
    if (!loginAllowed(normalisedEmail, getRequestIp(req))) {
        res.status(429).json({ success: false, error: 'Too many login attempts. Try again later.' });
        return;
    }

    try {
        const user = await prisma.user.findUnique({
            where: { email: normalisedEmail },
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
                sessionToken: hashSessionToken(token),
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

/**
 * The session token from the Authorization header, and nowhere else.
 *
 * The `req.cookies?.session` fallback that used to sit here is gone. It is the
 * whole cross-origin story: the API sets `cors({ origin: true })`, which
 * reflects *any* Origin, and `CORS_CREDENTIALS=true` — the documented setting —
 * then adds `Access-Control-Allow-Credentials`. With a cookie accepted here, any
 * website a logged-in dashboard user visited could make credentialed requests to
 * /auth/me, /dashboard/:ws/orders, /dashboard/:ws/payouts and /dashboard/:ws/api-keys
 * and *read the responses*: every buyer's name, email and phone, the full payout
 * bank account numbers, and the ability to mint keys or rewrite payout
 * destinations. There is no CSRF token and no Origin check, so removing the
 * cookie path is the control.
 *
 * The dashboard keeps the token in `localStorage` and sends it as a bearer
 * (web/src/lib/api.ts), so nothing legitimate depended on the cookie.
 */
function bearerToken(req: Request): string {
    const authHeader = req.headers.authorization || '';
    return authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
}

router.get('/me', async (req: Request, res: Response): Promise<void> => {
    const token = bearerToken(req);

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
            where: { sessionToken: hashSessionToken(token) },
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
                        verificationCreditsUnlimited: true,
                        imageCreditsUnlimited: true,
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
    const token = bearerToken(req);

    if (token) {
        try {
            await prisma.session.deleteMany({ where: { sessionToken: hashSessionToken(token) } });
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
    return `${resolveAppUrl()}/reset-password?token=${rawToken}`;
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

// Throttle so forgot-password cannot be used to spam email or probe accounts by
// timing. Bounded, because the key is caller-supplied and the route is
// unauthenticated: an unbounded Map was a memory-exhaustion lever.
const forgotThrottle = new MemoryWindowCounter({ maxEntries: 10_000 });
const FORGOT_WINDOW_MS = 15 * 60 * 1000;
const FORGOT_MAX_PER_WINDOW = 3;

// Credential endpoints run bcrypt at cost 10 (~100 ms of CPU each) and are
// unauthenticated, so without a limit they are both an online brute-force
// vector and a CPU-exhaustion DoS against a shared-CPU instance.
const loginThrottle = new MemoryWindowCounter({ maxEntries: 10_000 });
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_PER_WINDOW = 10;
const loginIpThrottle = new MemoryWindowCounter({ maxEntries: 20_000 });
const LOGIN_MAX_PER_IP = 50;

const signupThrottle = new MemoryWindowCounter({ maxEntries: 20_000 });
const SIGNUP_WINDOW_MS = 60 * 60 * 1000;
const SIGNUP_MAX_PER_IP = 5;

// Deliberately permissive: this rejects obvious abuse, it does not attempt to
// implement RFC 5322. The reset/login flows compare on the same normalised
// value, so a permissive check cannot lock a real user out of their own account.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const MAX_EMAIL_LENGTH = 254;

function normaliseEmail(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const email = raw.trim().toLowerCase();
    if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) return null;
    if (!EMAIL_PATTERN.test(email)) return null;
    return email;
}

function forgotAllowed(email: string): boolean {
    return forgotThrottle.increment(email, FORGOT_WINDOW_MS).count <= FORGOT_MAX_PER_WINDOW;
}

function loginAllowed(email: string, ip: string): boolean {
    return loginThrottle.increment(`email:${email}`, LOGIN_WINDOW_MS).count <= LOGIN_MAX_PER_WINDOW
        && loginIpThrottle.increment(`ip:${ip}`, LOGIN_WINDOW_MS).count <= LOGIN_MAX_PER_IP;
}

function signupAllowed(ip: string): boolean {
    return signupThrottle.increment(`ip:${ip}`, SIGNUP_WINDOW_MS).count <= SIGNUP_MAX_PER_IP;
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

    // Validate before using the address as a throttle key, so the bounded
    // counter cannot be filled with arbitrary strings by an anonymous caller.
    const normalizedEmail = normaliseEmail(email);
    if (!normalizedEmail) {
        res.json(uniformResponse);
        return;
    }
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
        const tokenHash = hashResetToken(token);
        const now = new Date();

        // Claim the token first, atomically.
        //
        // This used to be `findUnique` outside the transaction followed by a
        // `deleteMany` inside it, so two concurrent redemptions of the same link
        // both read a live record and both completed — the "single use" property
        // the reset email promises was not enforced, and the two password writes
        // raced. `deleteMany` returning 1 is the claim: exactly one caller can
        // win it, and the loser's count is 0.
        const claimed = await prisma.verificationToken.deleteMany({
            where: { token: tokenHash, expires: { gt: now } },
        });
        if (claimed.count !== 1) {
            res.status(400).json({ success: false, error: 'Invalid or expired reset link.' });
            return;
        }

        const record = await prisma.verificationToken.findFirst({
            where: { token: tokenHash, expires: { gt: now } },
        });
        // Reachable only if something deleted the row between the claim and the
        // read. Treat as invalid rather than proceeding: without the identifier
        // there is no user to update, and the token is spent either way.
        if (!record || !record.identifier.startsWith(RESET_IDENTIFIER_PREFIX)) {
            res.status(400).json({ success: false, error: 'Invalid or expired reset link.' });
            return;
        }

        const userId = record.identifier.slice(RESET_IDENTIFIER_PREFIX.length);
        const passwordHash = await bcrypt.hash(password, 10);

        await prisma.$transaction([
            prisma.account.updateMany({
                where: { userId, provider: 'credentials' },
                data: { passwordHash },
            }),
            // Every existing session dies with the old password.
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
export async function requireSession(req: Request, res: Response, next: NextFunction): Promise<void> {
    // Bearer only — see bearerToken() for why there is no cookie fallback.
    const token = bearerToken(req);

    if (!token) {
        res.status(401).json({ success: false, error: 'Authentication required.' });
        return;
    }

    const sessionData = verifySessionToken(token);
    if (!sessionData) {
        res.status(401).json({ success: false, error: 'Invalid session.' });
        return;
    }

    // The HMAC only proves this server minted the token with the current
    // secret. On its own it never expires and survives logout, so the row must
    // still exist, still be unexpired, and still belong to the same user.
    try {
        const session = await prisma.session.findUnique({
            where: { sessionToken: hashSessionToken(token) },
            select: { userId: true, expires: true },
        });
        if (!session || session.expires < new Date() || session.userId !== sessionData.userId) {
            res.status(401).json({ success: false, error: 'Session expired.' });
            return;
        }
    } catch (err) {
        logger.error('Session validation error:', err);
        res.status(500).json({ success: false, error: 'Internal server error.' });
        return;
    }

    // Attach to request for downstream handlers
    (req as any).userId = sessionData.userId;
    next();
}

export default router;
