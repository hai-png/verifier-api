/**
 * Shared session-token helpers.
 *
 * Moved out of routes/auth.ts when POST /auth/telegram needed the exact same
 * credential: the `nvd_sess_<userId>.<random>.<hmac>` token, HMAC-bound to
 * DASHBOARD_SECRET, with only its sha256 stored in the Session table. Every
 * issuer of dashboard sessions now goes through this one module, so the token
 * format, the storage rule ("hash, never the credential") and the fail-closed
 * behaviour when DASHBOARD_SECRET is unset cannot drift between call sites.
 */

import crypto from 'crypto';
import { prisma } from './prisma';
import { safeSecretEquals } from './secretCompare';

export const SESSION_TTL_DAYS = 30;
export const TOKEN_PREFIX = 'nvd_sess_';

/**
 * The value stored in `Session.sessionToken`.
 *
 * sha256 of the bearer token, not the token itself. The column is the indexed
 * lookup key for every authenticated request, so storing the credential meant any
 * read of the table — a backup, a replica, a `mysqldump`, a SQL injection
 * elsewhere, a leaked `.sql` — yielded immediately usable 30-day sessions for
 * every logged-in user, with nothing to crack. `ApiKey.keyHash` works the same
 * way.
 *
 * sha256 rather than bcrypt/bcrypt-like work factors because the input is 24
 * bytes of `crypto.randomBytes` — there is no dictionary to search, so a slow KDF
 * buys nothing and costs a round trip per request.
 */
export function hashSessionToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
}

/** Sign a session payload. Fails closed when DASHBOARD_SECRET is unset: a
 * published fallback key would let anyone mint a token for any userId, so there
 * is deliberately no default here.
 */
export function signSessionPayload(payload: string): string {
    const secret = process.env.DASHBOARD_SECRET;
    if (!secret) {
        throw new Error('DASHBOARD_SECRET is required to issue session tokens.');
    }
    return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Create a signed session token: nvd_sess_<random>.<hmac>
 * The HMAC binds the token to DASHBOARD_SECRET so it can't be forged.
 */
export function createSessionToken(userId: string): string {
    const random = crypto.randomBytes(24).toString('hex');
    const payload = `${userId}.${random}`;
    const hmac = signSessionPayload(payload);
    return `${TOKEN_PREFIX}${payload}.${hmac}`;
}

/**
 * Verify a session token. Returns userId if valid, null otherwise.
 *
 * The HMAC only proves the token was minted by this server with the current
 * secret. It is not sufficient on its own: the token must also still exist and
 * not be expired. `requireSession` (routes/auth.ts) enforces both against the
 * Session table.
 */
export function verifySessionToken(token: string): { userId: string } | null {
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
 * Mint a fresh session token for `userId` and persist its sha256 in the
 * Session table with the standard 30-day expiry.
 *
 * Returns the RAW bearer token — the one and only place it is handed out; the
 * database only ever sees the hash, and callers must never log the return value.
 */
export async function issueSession(userId: string): Promise<string> {
    const token = createSessionToken(userId);
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
    await prisma.session.create({
        data: {
            sessionToken: hashSessionToken(token),
            userId,
            expires: expiresAt,
        },
    });
    return token;
}
