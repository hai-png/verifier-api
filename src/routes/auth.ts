/**
 * Auth routes — email/password signup + login + Telegram sign-in + session management.
 *
 * POST   /auth/signup   — create user + default workspace, return session token
 * POST   /auth/login    — validate credentials, return session token
 * POST   /auth/telegram — verify a signed Telegram payload (Login Widget or
 *                          Mini App initData), find-or-create the user, return
 *                          the same kind of session token
 * GET    /auth/me       — get current user + workspaces (requires session token)
 * POST   /auth/logout   — invalidate session
 *
 * Session tokens are HMAC-signed with DASHBOARD_SECRET and stored as sha256 in the
 * Session table. A valid signature is not enough on its own: every request also
 * re-checks the row, so logout and the 30-day expiry really revoke access.
 * The token format + storage rule live in utils/sessionToken.ts, shared by every
 * session issuer (email login, signup, Telegram sign-in).
 */

import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../utils/prisma';
import { resolveAppUrl } from '../config/appUrl';
import logger from '../utils/logger';
import { MemoryWindowCounter } from '../utils/expiringStore';
import { getRequestIp } from '../utils/requestIp';
import { isResetEmailConfigured, sendPasswordResetEmail } from '../utils/passwordResetEmail';
import {
    hashSessionToken,
    issueSession,
    verifySessionToken,
} from '../utils/sessionToken';
import {
    telegramDisplayName,
    verifyTelegramAuthPayload,
} from '../utils/telegramAuth';
import { isWithinByteLimit, MYSQL_VARCHAR_BYTES } from '../utils/fieldLimits';

const router = Router();

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

        // Create session (token format + sha256-at-rest storage in utils/sessionToken.ts)
        const token = await issueSession(userId);

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

        // Create session (token format + sha256-at-rest storage in utils/sessionToken.ts)
        const token = await issueSession(user.id);

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

// ─── Telegram sign-in ────────────────────────────────────────────────────────

/**
 * POST /auth/telegram — sign in (or register) with a Telegram account.
 *
 * The body is one of the two shapes Telegram itself produces, both verified per
 * Telegram's own algorithms (utils/telegramAuth.ts):
 *
 *   a) Login Widget callback JSON: { id, first_name?, last_name?, username?,
 *      photo_url?, auth_date, hash } — the shape the dashboard's
 *      "Continue with Telegram" button posts.
 *   b) Mini App initData: { initData: "<raw query string>" } — lets a Telegram
 *      Mini App SSO a merchant into this dashboard by forwarding its own
 *      initData. EshiShop uses this to hand merchants a Noveld session.
 *
 * On success the response mirrors POST /auth/login (same nvd_sess_ session
 * token, same user shape) plus `created`, so a caller can tell a first sign-in
 * from a repeat one. auth_date must be within 24 hours.
 */
const telegramThrottle = new MemoryWindowCounter({ maxEntries: 20_000 });
const telegramAccountThrottle = new MemoryWindowCounter({ maxEntries: 20_000 });
const TELEGRAM_WINDOW_MS = 15 * 60 * 1000;
const TELEGRAM_MAX_PER_IP = 30;
const TELEGRAM_MAX_PER_ACCOUNT = 10;

function telegramIpAllowed(ip: string): boolean {
    return telegramThrottle.increment(`ip:${ip}`, TELEGRAM_WINDOW_MS).count <= TELEGRAM_MAX_PER_IP;
}

function telegramAccountAllowed(telegramId: string): boolean {
    return telegramAccountThrottle.increment(`tg:${telegramId}`, TELEGRAM_WINDOW_MS).count <= TELEGRAM_MAX_PER_ACCOUNT;
}

/**
 * VARCHAR(191) in *bytes* (Amharic names are multi-byte and common here), cut on
 * a code-point boundary so a truncated name is never invalid UTF-8.
 */
function truncateToBytes(value: string, maxBytes: number = MYSQL_VARCHAR_BYTES): string {
    let out = '';
    for (const ch of value) {
        if (Buffer.byteLength(out + ch, 'utf8') > maxBytes) break;
        out += ch;
    }
    return out;
}

router.post('/telegram', async (req: Request, res: Response): Promise<void> => {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
        // Disabled rather than broken: with no bot token nothing can be
        // verified, so the route says so instead of accepting or guessing.
        res.status(503).json({
            success: false,
            error: 'Telegram sign-in is not configured on this server. Set TELEGRAM_BOT_TOKEN to enable it.',
        });
        return;
    }

    if (!telegramIpAllowed(getRequestIp(req))) {
        res.status(429).json({ success: false, error: 'Too many Telegram sign-in attempts. Try again later.' });
        return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const verified = verifyTelegramAuthPayload(body, botToken);
    if (!verified.ok) {
        res.status(401).json({ success: false, error: verified.error });
        return;
    }

    const telegramUser = verified.user;
    if (!telegramAccountAllowed(telegramUser.id)) {
        res.status(429).json({ success: false, error: 'Too many Telegram sign-in attempts. Try again later.' });
        return;
    }

    try {
        const displayName = truncateToBytes(telegramDisplayName(telegramUser));
        // Telegram photo URLs are https and can exceed the column width; the
        // picture is optional, so drop it rather than 500 on the insert.
        const photoUrl = telegramUser.photoUrl && isWithinByteLimit(telegramUser.photoUrl)
            ? telegramUser.photoUrl
            : undefined;

        let created = false;
        let user: { id: string; email: string | null; name: string | null; image: string | null; telegramId: string | null };

        const existing = await prisma.user.findUnique({
            where: { telegramId: telegramUser.id },
            select: { id: true, email: true, name: true, image: true, telegramId: true },
        });

        if (existing) {
            // Repeat sign-in. Never overwrite a name the user set themselves;
            // refresh the photo when Telegram reports a different one.
            const patch: { name?: string; image?: string } = {};
            if (!existing.name && displayName) patch.name = displayName;
            if (photoUrl && photoUrl !== existing.image) patch.image = photoUrl;
            if (Object.keys(patch).length > 0) {
                await prisma.user.update({ where: { id: existing.id }, data: patch });
            }
            // The NextAuth-shaped Account row keeps the provider linkage even
            // for users provisioned elsewhere; upsert is idempotent on
            // (provider, providerAccountId).
            await prisma.account.upsert({
                where: { provider_providerAccountId: { provider: 'telegram', providerAccountId: telegramUser.id } },
                update: {},
                create: {
                    id: `acc_${crypto.randomBytes(12).toString('hex')}`,
                    userId: existing.id,
                    type: 'oauth',
                    provider: 'telegram',
                    providerAccountId: telegramUser.id,
                },
            });
            user = existing;
        } else {
            // First sign-in: a user with no email and no password — there is
            // nothing to log in with except Telegram itself.
            const userId = `usr_${crypto.randomBytes(12).toString('hex')}`;
            user = await prisma.user.create({
                data: {
                    id: userId,
                    name: displayName || null,
                    image: photoUrl ?? null,
                    telegramId: telegramUser.id,
                    accounts: {
                        create: {
                            id: `acc_${crypto.randomBytes(12).toString('hex')}`,
                            type: 'oauth',
                            provider: 'telegram',
                            providerAccountId: telegramUser.id,
                        },
                    },
                },
                select: { id: true, email: true, name: true, image: true, telegramId: true },
            });
            created = true;
        }

        // Same token, storage and expiry as email login (utils/sessionToken.ts).
        const token = await issueSession(user.id);

        logger.info(`Telegram user ${telegramUser.id} signed in${created ? ' (new account)' : ''}`);

        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                image: user.image,
            },
            created,
        });
    } catch (err) {
        logger.error('Telegram sign-in error:', err);
        res.status(500).json({ success: false, error: 'Failed to sign in with Telegram.' });
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
