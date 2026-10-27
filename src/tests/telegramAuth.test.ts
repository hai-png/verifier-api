// POST /auth/telegram — both accepted payload shapes, verified per Telegram's own
// algorithms with a FIXED test bot token, so the hashes are constructed in-test
// and the route is exercised over real HTTP with a recorded Prisma (no MySQL
// needed — the existing test harness replaces prisma methods in place).
//
// Accept + reject matrix pinned here:
//   valid Login-Widget payload      -> 200, nvd_sess_ token, created:true
//   valid MiniApp initData          -> 200, token, created:false on repeat
//   tampered field                  -> 401 (signature no longer matches)
//   stale auth_date (>24h)          -> 401
//   TELEGRAM_BOT_TOKEN unset        -> 503
//   Session row stores sha256 only  -> lookup key never the credential
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import express from 'express';
import { AddressInfo } from 'node:net';
import { prisma } from '../utils/prisma';
import authRouter from '../routes/auth';

// ─── Fixed test fixture ───────────────────────────────────────────────────────

const BOT_TOKEN = '7123456789:AAH-test-telegram-bot-token-fixed-for-tests';
const SECRET = 'telegram-auth-test-dashboard-secret';

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

/** Login-Widget hash: HMAC_SHA256(key=sha256(bot_token), data_check_string). */
function widgetHash(fields: Record<string, string>): string {
    const checkString = Object.keys(fields)
        .filter((key) => key !== 'hash')
        .sort()
        .map((key) => `${key}=${fields[key]}`)
        .join('\n');
    const secretKey = crypto.createHash('sha256').update(BOT_TOKEN).digest();
    return crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');
}

/**
 * Build a Login-Widget style JSON body for the given telegram id.
 * `authDateSeconds` defaults to "one minute ago" (fresh).
 */
function widgetBody(overrides: Partial<Record<string, string | number>> = {}, authDateSeconds = Math.floor(Date.now() / 1000) - 60) {
    const fields: Record<string, string> = {
        id: '424242',
        first_name: 'Marta',
        last_name: 'Bekele',
        username: 'marta_bekele',
        photo_url: 'https://t.me/i/userpic/320/marta.jpg',
        auth_date: String(authDateSeconds),
        ...Object.fromEntries(Object.entries(overrides).map(([key, value]) => [key, String(value)])),
    };
    const hash = widgetHash(fields);
    return { body: { ...fields, hash }, fields, hash };
}

/** MiniApp hash: HMAC_SHA256(key=HMAC_SHA256(bot_token,"WebAppData"), check string). */
function miniAppHash(pairs: [string, string][]): string {
    const checkString = pairs
        .filter(([key]) => key !== 'hash')
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');
    const secretKey = crypto.createHmac('sha256', BOT_TOKEN).update('WebAppData').digest();
    return crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');
}

/**
 * Build a raw MiniApp initData query string. Values are percent-encoded the way
 * Telegram clients do; the `signature` parameter (which real initData carries)
 * participates in the check string, so this fixture is faithful to production.
 */
function miniAppInitData(authDateSeconds = Math.floor(Date.now() / 1000) - 60, userId = '848484') {
    const user = JSON.stringify({ id: Number(userId), first_name: 'Dani', username: 'dani_tg', auth_date: authDateSeconds });
    const pairs: [string, string][] = [
        ['auth_date', String(authDateSeconds)],
        ['query_id', 'AAFtestQueryId'],
        ['signature', 'fake-ed25519-signature-over-initData'],
        ['user', user],
    ];
    const hash = miniAppHash(pairs);
    return `${pairs.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')}&hash=${hash}`;
}

// ─── Harness ───────────────────────────────────────────────────────────────────

interface RecordedSession {
    sessionToken: string;
    userId: string;
    expires: Date;
}

function recordAuthMocks(t: test.TestContext, existingUser: Record<string, unknown> | null) {
    const originals: Array<() => void> = [];
    function replace(object: any, key: string, value: any) {
        const original = object[key];
        object[key] = value;
        originals.push(() => { object[key] = original; });
    }

    const sessions: RecordedSession[] = [];
    const createdUsers: Record<string, unknown>[] = [];
    const upsertedAccounts: Record<string, unknown>[] = [];
    const userUpdates: Record<string, unknown>[] = [];

    replace(prisma.user, 'findUnique', async () => existingUser);
    replace(prisma.user, 'create', async ({ data }: any) => {
        createdUsers.push(data);
        return {
            id: data.id,
            email: data.email ?? null,
            name: data.name ?? null,
            image: data.image ?? null,
            telegramId: data.telegramId ?? null,
        };
    });
    replace(prisma.user, 'update', async ({ data }: any) => {
        userUpdates.push(data);
        return { ...existingUser, ...data };
    });
    replace(prisma.account, 'upsert', async (args: any) => {
        upsertedAccounts.push(args);
        return {};
    });
    replace(prisma.session, 'create', async ({ data }: any) => {
        sessions.push({ sessionToken: data.sessionToken, userId: data.userId, expires: data.expires });
        return {};
    });
    t.after(() => originals.reverse().forEach((restore) => restore()));

    return { sessions, createdUsers, upsertedAccounts, userUpdates };
}

async function serve(t: test.TestContext) {
    const app = express();
    app.use(express.json());
    app.use('/auth', authRouter);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/auth`;
    t.after(async () => {
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
        await new Promise<void>((r) => setImmediate(r));
    });
    return url;
}

function post(url: string, body: unknown, ip: string) {
    return fetch(`${url}/telegram`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
        body: JSON.stringify(body),
    });
}

function withEnv(t: test.TestContext, env: Record<string, string | undefined>) {
    const previous: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(env)) {
        previous[key] = process.env[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    t.after(() => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

test('a valid Login-Widget payload signs the user in and creates the account', async (t) => {
    withEnv(t, { TELEGRAM_BOT_TOKEN: BOT_TOKEN, DASHBOARD_SECRET: SECRET });
    const { sessions, createdUsers, upsertedAccounts } = recordAuthMocks(t, null);
    const url = await serve(t);
    const { body } = widgetBody();

    const response = await post(url, body, '198.51.100.101');
    assert.equal(response.status, 200);
    const data = await response.json() as any;
    assert.equal(data.success, true);
    assert.equal(data.created, true);
    assert.match(data.token, /^nvd_sess_/);
    assert.equal(data.user.id, createdUsers[0]!.id);
    assert.equal(data.user.email, null);
    assert.equal(data.user.name, 'Marta Bekele');

    // The User row is keyed by the Telegram id and carries the provider Account
    // row in the NextAuth shape.
    assert.equal(createdUsers[0]!.telegramId, '424242');
    const account = (createdUsers[0]!.accounts as any).create;
    assert.equal(account.provider, 'telegram');
    assert.equal(account.providerAccountId, '424242');
    assert.equal(account.type, 'oauth');
    assert.equal(upsertedAccounts.length, 0, 'a brand-new user needs no separate upsert');

    // Session storage rule: sha256 of the bearer, never the credential.
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.sessionToken, sha256(data.token));
    assert.notEqual(sessions[0]!.sessionToken, data.token);
    assert.equal(sessions[0]!.userId, createdUsers[0]!.id);
    assert.ok(sessions[0]!.expires.getTime() > Date.now() + 29 * 24 * 60 * 60 * 1000, '30-day expiry');
});

test('a valid MiniApp initData payload signs the user in', async (t) => {
    withEnv(t, { TELEGRAM_BOT_TOKEN: BOT_TOKEN, DASHBOARD_SECRET: SECRET });
    const { sessions, createdUsers } = recordAuthMocks(t, null);
    const url = await serve(t);

    const response = await post(url, { initData: miniAppInitData() }, '198.51.100.102');
    assert.equal(response.status, 200);
    const data = await response.json() as any;
    assert.equal(data.success, true);
    assert.equal(data.created, true);
    assert.match(data.token, /^nvd_sess_/);
    assert.equal(data.user.name, 'Dani');

    // The MiniApp user param carries the Telegram id.
    assert.equal(createdUsers[0]!.telegramId, '848484');
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.sessionToken, sha256(data.token));
});

test('a repeat sign-in reuses the user, refreshes the photo, and reports created:false', async (t) => {
    withEnv(t, { TELEGRAM_BOT_TOKEN: BOT_TOKEN, DASHBOARD_SECRET: SECRET });
    const existing = {
        id: 'usr_existing',
        email: null,
        name: 'Marta Bekele',
        image: 'https://t.me/i/userpic/320/old.jpg',
        telegramId: '424242',
    };
    const { createdUsers, upsertedAccounts, userUpdates } = recordAuthMocks(t, existing);
    const url = await serve(t);
    const { body } = widgetBody();

    const response = await post(url, body, '198.51.100.103');
    assert.equal(response.status, 200);
    const data = await response.json() as any;
    assert.equal(data.success, true);
    assert.equal(data.created, false);
    assert.equal(data.user.id, 'usr_existing');
    assert.equal(createdUsers.length, 0, 'an existing Telegram user must never create a second row');

    // Photo refreshed from the payload; the name the user already has is kept.
    assert.equal(userUpdates.length, 1);
    assert.equal((userUpdates[0] as any).image, 'https://t.me/i/userpic/320/marta.jpg');
    assert.equal((userUpdates[0] as any).name, undefined);

    // The provider Account row is idempotently ensured.
    assert.equal(upsertedAccounts.length, 1);
    assert.equal((upsertedAccounts[0] as any).where.provider_providerAccountId.provider, 'telegram');
});

test('a tampered Login-Widget field is rejected', async (t) => {
    withEnv(t, { TELEGRAM_BOT_TOKEN: BOT_TOKEN, DASHBOARD_SECRET: SECRET });
    const { sessions, createdUsers } = recordAuthMocks(t, null);
    const url = await serve(t);
    const { body } = widgetBody();

    // Same signature, different person: the attacker's classic move.
    const tampered = { ...body, first_name: 'Someone Else' };
    const rejected = await post(url, tampered, '198.51.100.104');
    assert.equal(rejected.status, 401);
    assert.match((await rejected.json() as any).error, /signature/i);
    assert.equal(createdUsers.length, 0);
    assert.equal(sessions.length, 0);
});

test('a tampered MiniApp initData field is rejected', async (t) => {
    withEnv(t, { TELEGRAM_BOT_TOKEN: BOT_TOKEN, DASHBOARD_SECRET: SECRET });
    const { sessions } = recordAuthMocks(t, null);
    const url = await serve(t);

    const valid = miniAppInitData();
    // Swap the signed user for a different one, keeping the original hash.
    const attacker = JSON.stringify({ id: 999, first_name: 'Attacker' });
    const tampered = valid.replace(/user=[^&]+/, `user=${encodeURIComponent(attacker)}`);
    assert.notEqual(tampered, valid);

    const response = await post(url, { initData: tampered }, '198.51.100.106');
    assert.equal(response.status, 401);
    assert.equal(sessions.length, 0);
});

test('a stale auth_date is rejected in both shapes', async (t) => {
    withEnv(t, { TELEGRAM_BOT_TOKEN: BOT_TOKEN, DASHBOARD_SECRET: SECRET });
    const { sessions, createdUsers } = recordAuthMocks(t, null);
    const url = await serve(t);

    const staleSeconds = Math.floor(Date.now() / 1000) - 25 * 60 * 60; // 25h ago
    const widget = widgetBody({}, staleSeconds);
    const widgetResponse = await post(url, widget.body, '198.51.100.107');
    assert.equal(widgetResponse.status, 401);
    assert.match((await widgetResponse.json() as any).error, /auth_date/);

    const miniAppResponse = await post(url, { initData: miniAppInitData(staleSeconds) }, '198.51.100.108');
    assert.equal(miniAppResponse.status, 401);

    assert.equal(createdUsers.length, 0);
    assert.equal(sessions.length, 0);
});

test('an unsigned or malformed payload is rejected without touching the database', async (t) => {
    withEnv(t, { TELEGRAM_BOT_TOKEN: BOT_TOKEN, DASHBOARD_SECRET: SECRET });
    const { sessions, createdUsers } = recordAuthMocks(t, null);
    const url = await serve(t);

    const noHash = await post(url, { id: 1, auth_date: Math.floor(Date.now() / 1000) }, '198.51.100.109');
    assert.equal(noHash.status, 401);

    const badHash = await post(url, { id: 1, auth_date: Math.floor(Date.now() / 1000), hash: '0'.repeat(64) }, '198.51.100.110');
    assert.equal(badHash.status, 401);

    const empty = await post(url, { initData: 'auth_date=123&hash=abc' }, '198.51.100.111');
    assert.equal(empty.status, 401);

    assert.equal(createdUsers.length, 0);
    assert.equal(sessions.length, 0);
});

test('without TELEGRAM_BOT_TOKEN the route reports 503 and signs nobody in', async (t) => {
    withEnv(t, { TELEGRAM_BOT_TOKEN: undefined, DASHBOARD_SECRET: SECRET });
    const { sessions, createdUsers } = recordAuthMocks(t, null);
    const url = await serve(t);
    const { body } = widgetBody();

    const response = await post(url, body, '198.51.100.112');
    assert.equal(response.status, 503);
    const data = await response.json() as any;
    assert.match(data.error, /TELEGRAM_BOT_TOKEN/);
    assert.equal(createdUsers.length, 0);
    assert.equal(sessions.length, 0);
});
