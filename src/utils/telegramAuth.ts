/**
 * Telegram payload verification, shared by POST /auth/telegram.
 *
 * Both documented Telegram login flows are supported, and both are verified
 * exactly per Telegram's own algorithms:
 *
 *  a) Login Widget (https://core.telegram.org/widgets/login):
 *       secret_key     = sha256(bot_token)
 *       data_check_string = every received field except `hash`, sorted by key
 *                           name, joined with "\n" as "key=value"
 *       hash           = HMAC_SHA256(secret_key, data_check_string), hex
 *
 *  b) Mini App / WebApps initData (https://core.telegram.org/copy/webapps#validating-data-received-via-the-mini-app):
 *       secret_key     = HMAC_SHA256(key=bot_token, message="WebAppData")
 *       data_check_string = every initData query parameter except `hash`,
 *                           sorted by key, joined with "\n" as "key=value"
 *                           (values URL-decoded)
 *       hash           = HMAC_SHA256(secret_key, data_check_string), hex
 *       the user object arrives URL-encoded in the `user` parameter
 *
 * The freshness rule for both is auth_date within AUTH_DATE_TTL_MS (24h per the
 * platform contract; Telegram only says "recent", a replayed captured payload
 * must not be accepted forever).
 *
 * Kept free of Prisma and Express so tests can drive it with fixed tokens and
 * fixed clocks.
 */

import crypto from 'crypto';
import { safeSecretEquals } from './secretCompare';

/** How fresh auth_date must be. 24 hours, per the platform contract. */
export const AUTH_DATE_TTL_MS = 24 * 60 * 60 * 1000;

/** What a verified payload tells us about the Telegram account. */
export interface TelegramUserInfo {
    /** Telegram numeric account id, as a decimal string. */
    id: string;
    firstName?: string;
    lastName?: string;
    username?: string;
    photoUrl?: string;
    authDate: number;
}

export type TelegramVerificationResult =
    | { ok: true; user: TelegramUserInfo }
    | { ok: false; error: string };

// ─── shared helpers ──────────────────────────────────────────────────────────

/**
 * The check string for a flat key→value map: entries sorted by key, joined
 * with "\n" as "key=value". The `hash` entry is excluded by the caller or here
 * — never part of the signed data.
 */
export function buildDataCheckString(fields: Record<string, string>): string {
    return Object.keys(fields)
        .filter((key) => key !== 'hash')
        .sort()
        .map((key) => `${key}=${fields[key]}`)
        .join('\n');
}

function hmacHex(key: crypto.BinaryLike | crypto.KeyObject, message: string): string {
    return crypto.createHmac('sha256', key).update(message).digest('hex');
}

/** auth_date must be a whole number of seconds, and within the TTL of `now`. */
function checkAuthDate(rawAuthDate: unknown, now: number): number | null {
    // Widgets send a number; JSON bodies occasionally carry a stringified number.
    // Anything else — undefined, NaN, "now", a date string — is not a timestamp.
    const value = typeof rawAuthDate === 'string' ? Number(rawAuthDate) : rawAuthDate;
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) return null;
    const age = now - value * 1000;
    if (age < -5 * 60 * 1000) return null; // more than 5 minutes in the future
    if (age > AUTH_DATE_TTL_MS) return null; // stale
    return value;
}

/** Pull the account fields out of a decoded user object (widget body or initData `user`). */
function extractUser(rawUser: Record<string, unknown>, authDate: number): TelegramUserInfo | null {
    const id = typeof rawUser.id === 'number' ? String(rawUser.id)
        : typeof rawUser.id === 'string' && /^\d+$/.test(rawUser.id) ? rawUser.id
        : null;
    if (!id) return null;

    const firstName = typeof rawUser.first_name === 'string' && rawUser.first_name.length > 0
        ? rawUser.first_name
        : undefined;
    const lastName = typeof rawUser.last_name === 'string' && rawUser.last_name.length > 0
        ? rawUser.last_name
        : undefined;
    const username = typeof rawUser.username === 'string' && rawUser.username.length > 0
        ? rawUser.username
        : undefined;
    const photoUrl = typeof rawUser.photo_url === 'string' && /^https?:\/\//.test(rawUser.photo_url)
        ? rawUser.photo_url
        : undefined;

    return { id, firstName, lastName, username, photoUrl, authDate };
}

// ─── (a) Login Widget ────────────────────────────────────────────────────────

/**
 * Verify a Login-Widget style flat JSON body:
 *   { id, first_name?, last_name?, username?, photo_url?, auth_date, hash }
 *
 * Every non-hash field the client sent takes part in the check string, so a
 * tampered or added field breaks the signature (that is the point of the
 * format: the whole body is signed).
 */
export function verifyTelegramLoginWidget(
    body: Record<string, unknown>,
    botToken: string,
    now: number = Date.now(),
): TelegramVerificationResult {
    const { hash, ...rest } = body;
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/i.test(hash)) {
        return { ok: false, error: 'Missing or malformed hash.' };
    }

    // Every remaining field must be a scalar the check string can render
    // losslessly; a nested object or array is not a widget payload.
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(rest)) {
        if (typeof value !== 'string' && typeof value !== 'number') {
            return { ok: false, error: `Field ${key} is not a valid Login Widget field.` };
        }
        fields[key] = String(value);
    }

    const authDate = checkAuthDate(fields.auth_date, now);
    if (authDate === null) {
        return { ok: false, error: 'auth_date is missing, malformed or older than 24 hours.' };
    }

    const secretKey = crypto.createHash('sha256').update(botToken).digest();
    const expected = hmacHex(secretKey, buildDataCheckString(fields));
    if (!safeSecretEquals(hash.toLowerCase(), expected)) {
        return { ok: false, error: 'Invalid Telegram payload signature.' };
    }

    const user = extractUser(fields, authDate);
    if (!user) {
        return { ok: false, error: 'Payload does not identify a Telegram account.' };
    }
    return { ok: true, user };
}

// ─── (b) Mini App initData ───────────────────────────────────────────────────

/**
 * Verify a Mini App style body: { initData: "<raw querystring>" }.
 *
 * The raw string is parsed with URLSearchParams — which decodes the values the
 * same way Telegram's own JS examples do — every parameter except `hash` takes
 * part in the check string, and the `user` parameter is URL-encoded JSON.
 */
export function verifyTelegramMiniAppInitData(
    initData: string,
    botToken: string,
    now: number = Date.now(),
): TelegramVerificationResult {
    if (typeof initData !== 'string' || initData.trim() === '') {
        return { ok: false, error: 'initData must be a non-empty string.' };
    }

    let params: URLSearchParams;
    try {
        params = new URLSearchParams(initData);
    } catch {
        return { ok: false, error: 'initData is not a valid query string.' };
    }

    const hash = params.get('hash');
    if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) {
        return { ok: false, error: 'initData is missing a valid hash parameter.' };
    }

    const fields: Record<string, string> = {};
    for (const [key, value] of params.entries()) {
        if (key !== 'hash') fields[key] = value;
    }

    const authDate = checkAuthDate(fields.auth_date, now);
    if (authDate === null) {
        return { ok: false, error: 'auth_date is missing, malformed or older than 24 hours.' };
    }

    const secretKey = crypto.createHmac('sha256', botToken).update('WebAppData').digest();
    const expected = hmacHex(secretKey, buildDataCheckString(fields));
    if (!safeSecretEquals(hash.toLowerCase(), expected)) {
        return { ok: false, error: 'Invalid Telegram initData signature.' };
    }

    const rawUser = fields.user ? JSON.parse(fields.user) as unknown : null;
    if (!rawUser || typeof rawUser !== 'object' || Array.isArray(rawUser)) {
        return { ok: false, error: 'initData does not carry a user object.' };
    }
    const user = extractUser(rawUser as Record<string, unknown>, authDate);
    if (!user) {
        return { ok: false, error: 'initData user object does not identify a Telegram account.' };
    }
    return { ok: true, user };
}

/**
 * Verify either accepted body shape and return the Telegram account it proves.
 *
 * A body with an `initData` string is treated as the Mini App shape; anything
 * else is treated as the Login Widget shape (which fails with its own message
 * when the fields are absent).
 */
export function verifyTelegramAuthPayload(
    body: Record<string, unknown>,
    botToken: string,
    now: number = Date.now(),
): TelegramVerificationResult {
    if (typeof body?.initData === 'string') {
        return verifyTelegramMiniAppInitData(body.initData, botToken, now);
    }
    return verifyTelegramLoginWidget(body, botToken, now);
}

/** Display name for a Telegram user, used when creating/refreshing the User row. */
export function telegramDisplayName(user: TelegramUserInfo): string {
    const parts = [user.firstName, user.lastName].filter((part): part is string => Boolean(part));
    if (parts.length > 0) return parts.join(' ');
    return user.username ?? `Telegram ${user.id}`;
}
