// POST /internal/provision + the partner workspace routes (worklog 11-0, C1).
//
// The harness the repo already uses for DB-backed behaviour without a live
// MySQL: mount the router over real HTTP and replace prisma methods in place
// with recorders. What is pinned here:
//
//   bad/missing PARTNER_SECRET       -> 401 {"error":"unauthorized"}
//   PARTNER_SECRET unset             -> 401 (fail closed, never allow-all)
//   invalid body                     -> 422 {"error":"invalid_request","message"}
//   partner outside PARTNER_ALLOWED  -> 422
//   create path                      -> 201, sk_live_ key, sha256 stored, OWNER
//                                       membership, synthetic owner email
//   replay path                      -> 200 created:false, name updated, fresh
//                                       key minted, payout upserted by label
//   payout validation                -> the sellable-provider set from payouts
//   GET /internal/workspaces/:id     -> no secrets in the response
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import express from 'express';
import { AddressInfo } from 'node:net';
import { prisma } from '../utils/prisma';
import internalProvisionRouter from '../routes/internalProvision';

const PARTNER_SECRET = 'partner-secret-for-provision-tests-0123456789';
const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

// ─── Recording harness ─────────────────────────────────────────────────────────

interface Recorded {
    workspacesCreated: Record<string, any>[];
    workspacesUpdated: Record<string, any>[];
    usersCreated: Record<string, any>[];
    membershipsCreated: Record<string, any>[];
    apiKeysCreated: Record<string, any>[];
    payoutAccountsCreated: Record<string, any>[];
    payoutAccountsUpdated: Record<string, any>[];
    sessionsWritten: number;
}

function recordPrisma(t: test.TestContext, existing: {
    workspace?: Record<string, unknown> | null;
    userByEmail?: Record<string, unknown> | null;
    userByTelegramId?: Record<string, unknown> | null;
    payoutByLabel?: Record<string, unknown> | null;
    apiKeys?: Record<string, unknown>[];
    payoutAccounts?: Record<string, unknown>[];
}): Recorded {
    const originals: Array<() => void> = [];
    function replace(object: any, key: string, value: any) {
        const original = object[key];
        object[key] = value;
        originals.push(() => { object[key] = original; });
    }

    const recorded: Recorded = {
        workspacesCreated: [],
        workspacesUpdated: [],
        usersCreated: [],
        membershipsCreated: [],
        apiKeysCreated: [],
        payoutAccountsCreated: [],
        payoutAccountsUpdated: [],
        sessionsWritten: 0,
    };

    // findFirst is used by findProvisionedWorkspace (externalId + partner) and by
    // the payout upsert (label); dispatch on the where clause. Only the exact
    // externalId resolves, so 404 paths stay honest.
    replace(prisma.workspace, 'findFirst', async ({ where }: any) => {
        if (where && where.externalId === 'shop-1') return existing.workspace ?? null;
        if (where && where.externalId !== undefined) return null;
        return null;
    });
    replace(prisma.workspace, 'findUnique', async () => null);
    replace(prisma.workspace, 'update', async ({ data }: any) => {
        recorded.workspacesUpdated.push(data);
        return data;
    });
    replace(prisma.workspace, 'create', async ({ data }: any) => {
        recorded.workspacesCreated.push(data);
        return data;
    });

    replace(prisma.user, 'findUnique', async ({ where }: any) => {
        if (where && where.email !== undefined) return existing.userByEmail ?? null;
        if (where && where.telegramId !== undefined) return existing.userByTelegramId ?? null;
        return null;
    });
    replace(prisma.user, 'create', async ({ data }: any) => {
        recorded.usersCreated.push(data);
        return { id: data.id, ...data };
    });

    replace(prisma.membership, 'create', async ({ data }: any) => {
        recorded.membershipsCreated.push(data);
        return data;
    });

    let keyCounter = 0;
    replace(prisma.apiKey, 'create', async ({ data }: any) => {
        recorded.apiKeysCreated.push(data);
        keyCounter += 1;
        return { id: `key_${keyCounter}` };
    });
    replace(prisma.apiKey, 'findMany', async () => existing.apiKeys ?? []);

    replace(prisma.payoutAccount, 'findFirst', async ({ where }: any) => {
        if (where && where.label !== undefined) return existing.payoutByLabel ?? null;
        return null;
    });
    replace(prisma.payoutAccount, 'count', async () => 0);
    replace(prisma.payoutAccount, 'create', async ({ data }: any) => {
        recorded.payoutAccountsCreated.push(data);
        return { id: 'po_new' };
    });
    replace(prisma.payoutAccount, 'updateMany', async ({ data }: any) => {
        recorded.payoutAccountsUpdated.push(data);
        return { count: 1 };
    });
    replace(prisma.payoutAccount, 'findMany', async () => existing.payoutAccounts ?? []);

    // planPricingConfig is read by getBillingConfig(); null -> DEFAULT row.
    replace(prisma.planPricingConfig, 'findUnique', async () => null);

    // The provision transaction is three mocked creates; awaiting them all is
    // exactly what the real $transaction does for an array of PrismaPromises.
    replace((prisma as any), '$transaction', async (args: any[]) => Promise.all(args));

    t.after(() => originals.reverse().forEach((restore) => restore()));
    return recorded;
}

async function serve(t: test.TestContext) {
    const app = express();
    app.use(express.json());
    app.use('/internal', internalProvisionRouter);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal`;
    t.after(async () => {
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
        await new Promise<void>((r) => setImmediate(r));
    });
    return url;
}

const authedHeaders = () => ({ 'content-type': 'application/json', authorization: `Bearer ${PARTNER_SECRET}`, 'cf-connecting-ip': '198.51.100.50' });

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

const baseBody = {
    externalId: 'shop-1',
    partner: 'eshishop',
    workspaceName: "Hanna's Boutique",
    ownerName: 'Hanna Tesfaye',
    ownerTelegramId: '556677',
};

const payoutBody = {
    label: 'Main account',
    accountHolderName: 'Hanna Tesfaye',
    providersAllowed: ['telebirr', 'cbe'],
    providerAccounts: { telebirr: '0911223344', cbe: '1000123456789012' },
};

// ─── Auth ──────────────────────────────────────────────────────────────────────

test('partner routes require the exact PARTNER_SECRET and fail closed without one', async (t) => {
    const url = await serve(t);

    // Unset: nothing works, and the error shape is the contract's.
    withEnv(t, { PARTNER_SECRET: undefined });
    const unsetNoHeader = await fetch(`${url}/workspaces/shop-1`, { headers: { 'cf-connecting-ip': '198.51.100.60' } });
    assert.equal(unsetNoHeader.status, 401);
    assert.deepEqual(await unsetNoHeader.json(), { error: 'unauthorized' });

    // Set but not provided / wrong.
    withEnv(t, { PARTNER_SECRET: PARTNER_SECRET });
    const missingHeader = await fetch(`${url}/workspaces/shop-1`, { headers: { 'cf-connecting-ip': '198.51.100.61' } });
    assert.equal(missingHeader.status, 401);
    assert.deepEqual(await missingHeader.json(), { error: 'unauthorized' });

    const wrong = await fetch(`${url}/workspaces/shop-1`, {
        headers: { authorization: 'Bearer definitely-not-the-secret', 'cf-connecting-ip': '198.51.100.62' },
    });
    assert.equal(wrong.status, 401);
    assert.deepEqual(await wrong.json(), { error: 'unauthorized' });
});

// ─── Validation ─────────────────────────────────────────────────────────────────

test('an invalid provision body answers 422 invalid_request with a message', async (t) => {
    withEnv(t, { PARTNER_SECRET: PARTNER_SECRET });
    recordPrisma(t, {});
    const url = await serve(t);

    const cases: Array<{ body: Record<string, unknown>; match: RegExp }> = [
        { body: { ...baseBody, externalId: undefined }, match: /externalId/ },
        { body: { ...baseBody, externalId: 'bad id with spaces' }, match: /externalId/ },
        { body: { ...baseBody, partner: undefined }, match: /partner/ },
        { body: { ...baseBody, partner: 'Not-A-Slug!' }, match: /partner/ },
        { body: { ...baseBody, workspaceName: '  ' }, match: /workspaceName/ },
        { body: { ...baseBody, ownerName: undefined }, match: /ownerName/ },
        { body: { ...baseBody, ownerEmail: 'not-an-email' }, match: /ownerEmail/ },
        { body: { ...baseBody, ownerTelegramId: 'abc' }, match: /ownerTelegramId/ },
        { body: { ...baseBody, plan: 'enterprise' }, match: /plan/ },
        { body: { ...baseBody, payout: { ...payoutBody, label: '' } }, match: /payout\.label/ },
        { body: { ...baseBody, payout: { ...payoutBody, providersAllowed: ['telebirr', 'zemen'], providerAccounts: { telebirr: '0911223344', zemen: '123' } } }, match: /unsupported providers/ },
        { body: { ...baseBody, payout: { ...payoutBody, providerAccounts: { telebirr: '0911223344' } } }, match: /No account number for: cbe/ },
    ];

    for (let i = 0; i < cases.length; i++) {
        const { body, match } = cases[i]!;
        const response = await fetch(`${url}/provision`, {
            method: 'POST',
            headers: { ...authedHeaders(), 'cf-connecting-ip': `198.51.100.${70 + i}` },
            body: JSON.stringify(body),
        });
        assert.equal(response.status, 422, `case ${i}: ${JSON.stringify(body.partner ?? '')}`);
        const data = await response.json() as any;
        assert.equal(data.error, 'invalid_request');
        assert.match(data.message, match, `case ${i} message`);
    }
});

test('PARTNER_ALLOWED rejects partners that are not on the list', async (t) => {
    withEnv(t, { PARTNER_SECRET: PARTNER_SECRET, PARTNER_ALLOWED: 'eshishop' });
    recordPrisma(t, {});
    const url = await serve(t);

    const response = await fetch(`${url}/provision`, {
        method: 'POST',
        headers: { ...authedHeaders(), 'cf-connecting-ip': '198.51.100.90' },
        body: JSON.stringify({ ...baseBody, partner: 'someone-else' }),
    });
    assert.equal(response.status, 422);
    const data = await response.json() as any;
    assert.equal(data.error, 'invalid_request');
    assert.match(data.message, /PARTNER_ALLOWED/);
});

// ─── Create path ────────────────────────────────────────────────────────────────

test('provision creates workspace + owner + key + payout and returns 201', async (t) => {
    withEnv(t, { PARTNER_SECRET: PARTNER_SECRET });
    const recorded = recordPrisma(t, {
        payoutAccounts: [
            {
                id: 'po_new',
                label: 'Main account',
                accountHolderName: 'Hanna Tesfaye',
                providersAllowed: ['telebirr', 'cbe'],
                providerAccounts: { telebirr: '0911223344', cbe: '1000123456789012' },
            },
        ],
    });
    const url = await serve(t);

    const response = await fetch(`${url}/provision`, {
        method: 'POST',
        headers: authedHeaders(),
        body: JSON.stringify({ ...baseBody, payout: payoutBody }),
    });
    assert.equal(response.status, 201);
    const data = await response.json() as any;

    // Contract response shape.
    assert.equal(data.ok, true);
    assert.equal(data.created, true);
    assert.equal(data.payoutAccountId, 'po_new');
    assert.equal(Array.isArray(data.payoutAccounts), true);
    assert.equal(data.payoutAccounts.length, 1);
    assert.equal(data.payoutAccounts[0].label, 'Main account');
    assert.deepEqual(data.payoutAccounts[0].providersAllowed, ['telebirr', 'cbe']);

    // A fresh sk_live_ key, returned once, stored only as its sha256.
    assert.match(data.apiKey, /^sk_live_[0-9a-f]{48}$/);
    assert.equal(typeof data.apiKeyId, 'string');
    assert.equal(recorded.apiKeysCreated.length, 1);
    assert.equal(recorded.apiKeysCreated[0]!.keyHash, sha256(data.apiKey));
    assert.equal(recorded.apiKeysCreated[0]!.name, 'eshishop-auto');
    assert.equal(recorded.apiKeysCreated[0]!.isActive, true);
    assert.ok(!('key' in recorded.apiKeysCreated[0]!), 'the plaintext key must never be stored');

    // Workspace: linked to the partner's external id, free plan credits.
    assert.equal(recorded.workspacesCreated.length, 1);
    const workspace = recorded.workspacesCreated[0]!;
    assert.equal(workspace.externalId, 'shop-1');
    assert.equal(workspace.partner, 'eshishop');
    assert.equal(workspace.name, "Hanna's Boutique");
    assert.equal(workspace.tier, 'FREE');
    assert.equal(workspace.verificationCredits, 100);
    assert.equal(workspace.verificationCreditsMonthly, 100);

    // Owner: synthetic email under partners.local, linked Telegram id, OWNER.
    assert.equal(recorded.usersCreated.length, 1);
    const user = recorded.usersCreated[0]!;
    assert.equal(user.email, 'partner+shop-1@partners.local');
    assert.equal(user.telegramId, '556677');
    assert.equal(user.name, 'Hanna Tesfaye');
    const accounts = user.accounts.create as Record<string, unknown>[];
    assert.equal(accounts.length, 2, 'credentials + telegram provider rows');
    assert.equal(accounts.find((a) => a.provider === 'telegram')!.providerAccountId, '556677');
    assert.ok(accounts.find((a) => a.provider === 'credentials')!.passwordHash, 'random unguessable password hash');
    assert.equal(recorded.membershipsCreated.length, 1);
    assert.equal(recorded.membershipsCreated[0]!.role, 'OWNER');

    // Payout account created with the same destination rules as POST /payouts.
    assert.equal(recorded.payoutAccountsCreated.length, 1);
    const payout = recorded.payoutAccountsCreated[0]!;
    assert.equal(payout.label, 'Main account');
    assert.equal(payout.account, '0911223344');
    assert.equal(payout.type, 'UNIFIED');
    assert.deepEqual(payout.providerAccounts, { telebirr: '0911223344', cbe: '1000123456789012' });
});

test('provision with plan "pro" grants the PRO tier and pro quotas', async (t) => {
    withEnv(t, { PARTNER_SECRET: PARTNER_SECRET });
    const recorded = recordPrisma(t, {});
    const url = await serve(t);

    const response = await fetch(`${url}/provision`, {
        method: 'POST',
        headers: { ...authedHeaders(), 'cf-connecting-ip': '198.51.100.91' },
        body: JSON.stringify({ ...baseBody, externalId: 'shop-pro', plan: 'pro', ownerTelegramId: undefined }),
    });
    assert.equal(response.status, 201);
    assert.equal(recorded.workspacesCreated.length, 1);
    assert.equal(recorded.workspacesCreated[0]!.tier, 'PRO');
    assert.equal(recorded.workspacesCreated[0]!.verificationCreditsMonthly, 2000);
    assert.equal(recorded.workspacesCreated[0]!.imageCreditsMonthly, 100);
    // No telegram id -> only the credentials row.
    assert.equal((recorded.usersCreated[0]!.accounts.create as unknown[]).length, 1);
});

test('provision reuses an existing owner by email and links their telegram id', async (t) => {
    withEnv(t, { PARTNER_SECRET: PARTNER_SECRET });
    const recorded = recordPrisma(t, {
        userByEmail: { id: 'usr_hanna_existing' },
    });
    const url = await serve(t);

    const response = await fetch(`${url}/provision`, {
        method: 'POST',
        headers: { ...authedHeaders(), 'cf-connecting-ip': '198.51.100.92' },
        body: JSON.stringify({ ...baseBody, ownerEmail: 'hanna@example.com' }),
    });
    assert.equal(response.status, 201);
    assert.equal(recorded.usersCreated.length, 0, 'an existing user must be reused, not duplicated');
    assert.equal(recorded.membershipsCreated[0]!.userId, 'usr_hanna_existing');
    assert.equal(recorded.membershipsCreated[0]!.role, 'OWNER');
});

// ─── Replay path ────────────────────────────────────────────────────────────────

test('a replayed provision updates the name, mints a fresh key, upserts the payout', async (t) => {
    withEnv(t, { PARTNER_SECRET: PARTNER_SECRET });
    const recorded = recordPrisma(t, {
        workspace: { id: 'ws_existing', name: 'Old Name', partner: 'eshishop', externalId: 'shop-1' },
        payoutByLabel: {
            id: 'po_existing',
            account: '0911223344',
            providersAllowed: ['telebirr'],
            providerAccounts: { telebirr: '0911223344' },
        },
        payoutAccounts: [
            {
                id: 'po_existing',
                label: 'Main account',
                accountHolderName: 'Hanna Tesfaye',
                providersAllowed: ['telebirr', 'cbe'],
                providerAccounts: { telebirr: '0911223344', cbe: '1000123456789012' },
            },
        ],
    });
    const url = await serve(t);

    const response = await fetch(`${url}/provision`, {
        method: 'POST',
        headers: authedHeaders(),
        body: JSON.stringify({ ...baseBody, workspaceName: 'Renamed Boutique', payout: payoutBody }),
    });
    assert.equal(response.status, 200);
    const data = await response.json() as any;
    assert.equal(data.ok, true);
    assert.equal(data.created, false);
    assert.equal(data.workspaceId, 'ws_existing');
    assert.equal(data.payoutAccountId, 'po_existing');

    // Name updated, no duplicate workspace/user, ALWAYS a fresh key.
    assert.equal(recorded.workspacesUpdated.length, 1);
    assert.equal(recorded.workspacesUpdated[0]!.name, 'Renamed Boutique');
    assert.equal(recorded.workspacesCreated.length, 0);
    assert.equal(recorded.usersCreated.length, 0);
    assert.equal(recorded.apiKeysCreated.length, 1);
    assert.equal(recorded.apiKeysCreated[0]!.keyHash, sha256(data.apiKey));

    // Payout upserted by label: same row updated with the new destinations.
    assert.equal(recorded.payoutAccountsCreated.length, 0);
    assert.equal(recorded.payoutAccountsUpdated.length, 1);
    assert.deepEqual(recorded.payoutAccountsUpdated[0]!.providerAccounts, { telebirr: '0911223344', cbe: '1000123456789012' });
});

// ─── Workspace routes ──────────────────────────────────────────────────────────

test('GET /workspaces/:externalId returns the summary and no secrets', async (t) => {
    withEnv(t, { PARTNER_SECRET: PARTNER_SECRET });
    recordPrisma(t, {
        workspace: { id: 'ws_existing', name: 'Shop', partner: 'eshishop', externalId: 'shop-1' },
        apiKeys: [{ id: 'key_1', name: 'eshishop-auto', prefix: 'sk_live_abc123...', createdAt: new Date(0), lastUsed: null }],
        payoutAccounts: [
            { id: 'po_existing', label: 'Main', accountHolderName: 'Hanna', providersAllowed: ['telebirr'], providerAccounts: { telebirr: '0911223344' } },
        ],
    });
    const url = await serve(t);

    const good = await fetch(`${url}/workspaces/shop-1`, { headers: { authorization: `Bearer ${PARTNER_SECRET}`, 'cf-connecting-ip': '198.51.100.94' } });
    assert.equal(good.status, 200);
    const text = await good.text();
    const data = JSON.parse(text) as any;
    assert.equal(data.ok, true);
    assert.equal(data.workspaceId, 'ws_existing');
    assert.equal(data.name, 'Shop');
    assert.equal(data.apiKeys.length, 1);
    assert.equal(data.apiKeys[0].name, 'eshishop-auto');
    assert.equal(data.apiKeys[0].lastUsedAt, null);
    assert.equal(data.payoutAccounts.length, 1);
    // The response must carry no credential material of any kind. Key prefixes
    // are display data (the dashboard shows them too); a full key is sk_live_
    // plus 48 hex chars, and hashes/passwords never leave the table.
    assert.ok(!text.includes('keyHash'), 'no keyHash in response');
    assert.ok(!/sk_live_[0-9a-f]{48}/.test(text), 'no full API key material in response');
    assert.ok(!text.includes('passwordHash'), 'no password material in response');

    const missing = await fetch(`${url}/workspaces/never-provisioned`, { headers: { authorization: `Bearer ${PARTNER_SECRET}`, 'cf-connecting-ip': '198.51.100.95' } });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json() as any).error, 'not_found');
});

test('POST /workspaces/:externalId/api-keys mints another key', async (t) => {
    withEnv(t, { PARTNER_SECRET: PARTNER_SECRET });
    const recorded = recordPrisma(t, {
        workspace: { id: 'ws_existing', name: 'Shop', partner: 'eshishop', externalId: 'shop-1' },
    });
    const url = await serve(t);

    const response = await fetch(`${url}/workspaces/shop-1/api-keys`, {
        method: 'POST',
        headers: { authorization: `Bearer ${PARTNER_SECRET}`, 'cf-connecting-ip': '198.51.100.96' },
        body: JSON.stringify({}),
    });
    assert.equal(response.status, 201);
    const data = await response.json() as any;
    assert.equal(data.ok, true);
    assert.match(data.apiKey, /^sk_live_[0-9a-f]{48}$/);
    assert.equal(typeof data.apiKeyId, 'string');
    assert.equal(recorded.apiKeysCreated.length, 1);
    assert.equal(recorded.apiKeysCreated[0]!.keyHash, sha256(data.apiKey));
    assert.equal(recorded.apiKeysCreated[0]!.workspaceId, 'ws_existing');

    const missing = await fetch(`${url}/workspaces/never-provisioned/api-keys`, {
        method: 'POST',
        headers: { authorization: `Bearer ${PARTNER_SECRET}`, 'cf-connecting-ip': '198.51.100.97' },
        body: JSON.stringify({}),
    });
    assert.equal(missing.status, 404);
});
