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
import logger from '../utils/logger';
import { safeSecretEquals } from '../utils/secretCompare';
import { MemoryWindowCounter } from '../utils/expiringStore';
import { getBillingConfig } from '../config/billingConfig';
import { addMonths, getMonthlyImageCredits, getVerificationMonthlyQuota } from '../config/plans';
import { getRequestIp } from '../utils/requestIp';
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
    const hmac = signSessionPayload(payload);
    return `${TOKEN_PREFIX}${payload}.${hmac}`;
}

/**
 * The value persisted in `Session.sessionToken`.
 *
 * The column used to hold the bearer token itself, in plaintext, so a database
 * read — a dump, a backup, a stale replica, a compromised admin console, a SQL
 * injection somewhere else in the stack — handed over live dashboard sessions for
 * every logged-in user, with no way to tell which ones had been taken. Passwords
 * in `Account.passwordHash` are bcrypt'd and reset tokens in `VerificationToken`
 * are sha256'd; sessions were the one credential stored raw.
 *
 * SHA-256 rather than bcrypt is deliberate here: the token carries 192 bits of
 * `randomBytes` plus an HMAC, so there is no dictionary to slow down, and the
 * `@unique` index needs an exact-match lookup — a salted hash could not be
 * queried by value at all.
 */
export function hashSessionToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
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
    // Same normaliser login and forgot-password use, not a looser local pattern.
    // Signup previously stored `email.toLowerCase()` without trimming and under a
    // more permissive regex, so an address accepted here (" User@dom..ain") could
    // never be matched again by login or by a password reset: the account existed
    // but was permanently unreachable. Validating on the normalised value makes
    // the three flows agree by construction.
    const signupEmail = normaliseEmail(email);
    if (!signupEmail) {
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
        // Check if user already exists
        const existing = await prisma.user.findUnique({ where: { email: signupEmail } });
        if (existing) {
            res.status(409).json({ success: false, error: 'An account with this email already exists.' });
            return;
        }

        // Hash password
        const passwordHash = await hashPassword(password);

        // Create user + default workspace + membership in a transaction
        const userId = `usr_${crypto.randomBytes(12).toString('hex')}`;
        const workspaceId = `ws_${crypto.randomBytes(12).toString('hex')}`;
        const displayName = typeof name === 'string' && name.trim() ? name.trim() : signupEmail.split('@')[0];

        // Plan entitlements come from PlanPricingConfig, the same source
        // tierGate.syncWorkspacePlanState reads. Hardcoding 100 credits and a
        // 30-day reset here created a second source of truth: an operator who
        // changed freeQuotaNewMonthly saw no effect on new signups until the
        // first reset, and `+30 days` did not match `addMonths(now, 1)` used
        // everywhere else, so the very first reset landed on a different
        // anniversary than every subsequent one.
        const billingConfig = await getBillingConfig();
        const freeQuota = getVerificationMonthlyQuota('FREE', false, billingConfig);
        const freeImageCredits = getMonthlyImageCredits('FREE', billingConfig);
        const creditsResetAt = addMonths(new Date(), 1);

        await prisma.$transaction([
            prisma.user.create({
                data: {
                    id: userId,
                    email: signupEmail,
                    name: displayName,
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
                    name: `${displayName}'s Workspace`,
                    tier: 'FREE',
                    verificationCredits: freeQuota,
                    verificationCreditsMonthly: freeQuota,
                    verificationCreditsResetAt: creditsResetAt,
                    imageCredits: freeImageCredits,
                    imageCreditsMonthly: freeImageCredits,
                    imageCreditsResetAt: creditsResetAt,
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

        logger.info('New user signed up', { userId, workspaceId });

        res.status(201).json({
            success: true,
            token,
            user: {
                id: userId,
                email: signupEmail,
                name: displayName,
            },
            workspace: {
                id: workspaceId,
                name: `${displayName}'s Workspace`,
                tier: 'FREE',
                verificationCredits: freeQuota,
                verificationCreditsMonthly: freeQuota,
                imageCredits: freeImageCredits,
                imageCreditsMonthly: freeImageCredits,
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

        logger.info('User logged in', { userId: user.id });

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
    // Bearer only. A `req.cookies?.session` fallback used to sit here, but
    // nothing in this codebase ever calls `res.cookie('session', ...)` — the
    // branch could only be reached by a cookie set from another origin or tossed
    // by an attacker who can write to the domain. A session credential that
    // arrives automatically with every same-site request is also the CSRF shape;
    // an explicit Authorization header is not. Dead code, and a loaded gun.
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

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
    // Bearer only. A `req.cookies?.session` fallback used to sit here, but
    // nothing in this codebase ever calls `res.cookie('session', ...)` — the
    // branch could only be reached by a cookie set from another origin or tossed
    // by an attacker who can write to the domain. A session credential that
    // arrives automatically with every same-site request is also the CSRF shape;
    // an explicit Authorization header is not. Dead code, and a loaded gun.
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

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

// /reset-password was the one unauthenticated credential endpoint with no limit.
// The token is 256 random bits, so it cannot be guessed — but each attempt is a
// free database round trip, and a *valid* token is single-use, so an attacker who
// has intercepted one can also burn it by racing the owner to the endpoint. The
// bcrypt.hash below is ~100 ms of CPU per call on a shared-CPU instance.
const resetThrottle = new MemoryWindowCounter({ maxEntries: 10_000 });
const RESET_WINDOW_MS = 15 * 60 * 1000;
const RESET_MAX_PER_WINDOW = 5;
const resetIpThrottle = new MemoryWindowCounter({ maxEntries: 20_000 });
const RESET_MAX_PER_IP = 25;
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
    // Count both before comparing. `a <= N && b <= M` short-circuits, so once the
    // per-email budget tripped the per-IP counter stopped being incremented — an
    // attacker rotating addresses accumulated no IP history at all and the
    // per-IP cap never engaged.
    const perEmail = loginThrottle.increment(`email:${email}`, LOGIN_WINDOW_MS).count;
    const perIp = loginIpThrottle.increment(`ip:${ip}`, LOGIN_WINDOW_MS).count;
    return perEmail <= LOGIN_MAX_PER_WINDOW && perIp <= LOGIN_MAX_PER_IP;
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

/**
 * Whether a password-reset attempt may proceed.
 *
 * Both counters are incremented before either is compared — the short-circuit
 * bug that `loginAllowed` had would otherwise let an attacker rotating source
 * addresses accumulate no IP history at all.
 *
 * The per-token key is the sha256 the route already computes for the lookup, not
 * the token: a throttle map is not a place to keep a live credential.
 */
function resetAllowed(tokenHash: string, ip: string): boolean {
    const perToken = resetThrottle.increment(`token:${tokenHash}`, RESET_WINDOW_MS).count;
    const perIp = resetIpThrottle.increment(`ip:${ip}`, RESET_WINDOW_MS).count;
    return perToken <= RESET_MAX_PER_WINDOW && perIp <= RESET_MAX_PER_IP;
}

router.post('/reset-password', async (req: Request, res: Response): Promise<void> => {
    const { token, password } = req.body as { token?: string; password?: string };

    if (!resetAllowed(hashResetToken(String(token ?? '')), getRequestIp(req))) {
        // The IP is logged, the token is not: it may still be valid for its owner.
        logger.warn('Password reset throttled', { ip: getRequestIp(req) });
        res.status(429).json({ success: false, error: 'Too many reset attempts. Try again later.' });
        return;
    }

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
export async function requireSession(req: Request, res: Response, next: NextFunction): Promise<void> {
    // Bearer only. A `req.cookies?.session` fallback used to sit here, but
    // nothing in this codebase ever calls `res.cookie('session', ...)` — the
    // branch could only be reached by a cookie set from another origin or tossed
    // by an attacker who can write to the domain. A session credential that
    // arrives automatically with every same-site request is also the CSRF shape;
    // an explicit Authorization header is not. Dead code, and a loaded gun.
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

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
