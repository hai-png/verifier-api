import crypto from 'crypto';

/**
 * Constant-time comparison for shared secrets (admin key, dashboard secret,
 * session-token HMAC).
 *
 * Always returns false when the expected secret is unset. That is the whole
 * point: a deployment that forgot to configure a secret must fail closed, never
 * accept an absent or empty credential. Comparing with `===` against an empty
 * expected value would let `x-admin-key:` (sent with no value) authenticate.
 *
 * The length check is deliberate and safe: these are fixed-length random
 * secrets, so length is not the secret.
 */
export function safeSecretEquals(provided: unknown, expected: string | undefined): boolean {
    if (typeof provided !== 'string' || !expected) return false;
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}
