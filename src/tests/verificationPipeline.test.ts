import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { AddressInfo } from 'node:net';
import { prisma } from '../utils/prisma';
import { apiKeyAuth } from '../middleware/apiKeyAuth';
import dashboardRouter from '../routes/dashboard';
import universalRouter from '../routes/verifyUniversalRoute';
import dashenRouter from '../routes/verifyDashenRoute';
import telebirrRouter from '../routes/verifyTelebirrRoute';
import cbebirrRouter from '../routes/verifyCBEBirrRoute';
import cbeRouter from '../routes/verifyCBERoute';
import batchRouter from '../routes/verifyBatch';
import { providerVerifiers } from '../services/verifyUniversal';
import { DEFAULT_BILLING_CONFIG, invalidateBillingConfigCache } from '../config/billingConfig';
import { clearVerifyCache } from '../middleware/verifyResultCache';
import { quotaRefundHook } from '../utils/quotaCharge';

// Exercise the production routers, authentication, rate/quota middleware and
// provider dispatch, replacing only DB I/O and upstream providers. No banks.
test('dashboard and API execute one tenant-safe, billable verification pipeline', async (t) => {
  const workspaces = new Map<string, any>();
  const denied = new Set(['forbidden']);
  const revokedKeys = new Set<string>();
  const deniedVerifyPermission = new Set<string>();
  function workspace(id: string, credits = 100) {
    const value = { id, tier: 'FREE', grandfathered: false, verificationCredits: credits,
      verificationCreditsMonthly: 100, verificationCreditsResetAt: new Date('2099-01-01'),
      imageCredits: 0, imageCreditsMonthly: 0, imageCreditsResetAt: new Date('2099-01-01'),
      paidUntil: null, planTermMonths: null };
    workspaces.set(id, value); return value;
  }
  let limit = 1000, providerCalls = 0, charges = 0, accessQueries = 0;
  let fail = false;
  const originals: Array<() => void> = [];
  function replace(object: any, key: string, value: any) {
    const original = object[key]; object[key] = value; originals.push(() => { object[key] = original; });
  }
  replace(prisma.workspace, 'findFirst', async (args: any) => {
    accessQueries++;
    assert.equal(args.where.memberships.some.userId, 'user-test');
    return denied.has(args.where.id) ? null : { ...workspaces.get(args.where.id) };
  });
  replace(prisma.workspace, 'updateMany', async ({ where, data }: any) => {
    const ws = workspaces.get(where.id);
    if (data.verificationCredits?.decrement) {
      if (!ws || ws.verificationCredits < where.verificationCredits.gte) return { count: 0 };
      ws.verificationCredits -= data.verificationCredits.decrement; charges++;
    } else if (data.verificationCredits?.increment) ws.verificationCredits += data.verificationCredits.increment;
    return { count: 1 };
  });
  replace(prisma.apiKey, 'findFirst', async (args: any) => {
    const id = args.where.OR[1].key;
    const ws = workspaces.get(id);
    return ws && !revokedKeys.has(id) ? { id: `key-${id}`, workspace: { ...ws }, permissions: deniedVerifyPermission.has(id) ? ['webhooks'] : id === 'batch' ? ['verify', 'verify-batch'] : ['verify'], isActive: true } : null;
  });
  replace(prisma.usageLog, 'createMany', async () => ({ count: 1 }));
  replace(prisma.webhook, 'findMany', async () => []);
  replace(prisma.notificationChannel, 'findMany', async () => []);
  replace(prisma.apiKey, 'update', () => Promise.resolve({}));
  replace(prisma, '$transaction', async () => []);
  replace(prisma.planPricingConfig, 'findUnique', async () => ({ ...DEFAULT_BILLING_CONFIG, freeRateLimit: limit, freeBatchMaxReferences: 5 }));
  const upstream = async () => {
    providerCalls++;
    await new Promise((r) => setTimeout(r, 30));
    return fail ? { success: false, error: 'not found' } : { success: true, amount: 100, transactionStatus: 'Completed' };
  };
  replace(providerVerifiers, 'DASHEN', upstream);
  replace(providerVerifiers, 'TELEBIRR', upstream);
  replace(providerVerifiers, 'CBE_BIRR', upstream);
  clearVerifyCache(); invalidateBillingConfigCache();
  const app = express(); app.use(express.json()); app.use(quotaRefundHook);
  app.use('/dashboard', dashboardRouter);
  app.use(apiKeyAuth as express.RequestHandler);
  app.use('/verify', universalRouter);
  app.use('/verify-dashen', dashenRouter);
  app.use('/verify-telebirr', telebirrRouter);
  app.use('/verify-cbebirr', cbebirrRouter);
  app.use('/verify-cbe', cbeRouter);
  app.use('/verify-batch', batchRouter);
  app.use((err: unknown, _req: any, res: any, _next: any) => res.status(500).json({ error: String(err) }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => setImmediate(r));
    originals.reverse().forEach((restore) => restore()); clearVerifyCache(); invalidateBillingConfigCache();
  });
  const payload = 'user-test.random';
  const token = `nvd_sess_${payload}.${crypto.createHmac('sha256', process.env.DASHBOARD_SECRET || 'fallback-secret').update(payload).digest('hex')}`;
  async function post(path: string, body: unknown, ws = 'a', dashboard = false) {
    const response = await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json',
      ...(dashboard ? { Authorization: `Bearer ${token}` } : { 'x-api-key': ws }) }, body: JSON.stringify(body) });
    const data: any = await response.json(); return { response, data };
  }
  const ref = '1234567890123456';
  workspace('a'); workspace('b');
  await t.test('dashboard miss then legacy/universal hits share one provider call but charge each request', async () => {
    const first = await post('/dashboard/a/verify', { reference: ref, provider: 'dashen' }, 'a', true);
    assert.equal(first.response.status, 200);
    assert.equal(first.data.provider, 'DASHEN');
    assert.equal(first.response.headers.get('x-verify-cache'), 'miss');
    assert.match(first.response.headers.get('server-timing')!, /access;dur=.*quota;dur=.*provider;dur=/);
    assert.equal(first.response.headers.get('cache-control'), 'no-store');
    const second = await post('/verify-dashen', { reference: ref });
    assert.equal(second.response.headers.get('x-verify-cache'), 'hit');
    assert.equal(second.data.amount, 100); // Legacy envelope stays flat.
    const third = await post('/verify', { reference: ref });
    assert.equal(third.response.headers.get('x-verify-cache'), 'hit');
    assert.equal(providerCalls, 1); assert.equal(charges, 3); assert.equal(accessQueries, 1);
  });
  await t.test('cross-workspace requests cannot reuse another workspace’s result', async () => {
    const result = await post('/dashboard/b/verify', { reference: ref, provider: 'dashen' }, 'b', true);
    assert.equal(result.response.headers.get('x-verify-cache'), 'miss'); assert.equal(providerCalls, 2);
  });
  await t.test('repeated Telebirr succeeds across dashboard and legacy adapter', async () => {
    const before = providerCalls;
    await post('/dashboard/a/verify', { reference: 'CE12345678', provider: 'telebirr' }, 'a', true);
    const result = await post('/verify-telebirr', { reference: 'CE12345678' });
    assert.equal(result.response.headers.get('x-verify-cache'), 'hit');
    assert.equal(result.data.data.amount, 100); assert.equal(providerCalls, before + 1);
  });
  await t.test('denied membership, revoked API key and missing auth do not hit cache or charge', async () => {
    const before = charges;
    denied.add('a'); revokedKeys.add('a');
    assert.equal((await post('/dashboard/a/verify', { reference: ref }, 'a', true)).response.status, 403);
    assert.equal((await post('/verify-dashen', { reference: ref }, 'a')).response.status, 403);
    denied.delete('a'); revokedKeys.delete('a');
    deniedVerifyPermission.add('a');
    assert.equal((await post('/verify-dashen', { reference: ref }, 'a')).response.status, 403);
    deniedVerifyPermission.delete('a');
    assert.equal((await post('/dashboard/forbidden/verify', { reference: ref }, 'a', true)).response.status, 403);
    assert.equal((await post('/verify-dashen', { reference: ref }, 'revoked')).response.status, 403);
    const response = await fetch(url + '/dashboard/a/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reference: ref }) });
    assert.equal(response.status, 401); await response.text(); assert.equal(charges, before);
  });
  await t.test('malformed inputs reject before any quota writes, for both entry points', async () => {
    const before = charges;
    for (const path of ['/dashboard/a/verify', '/verify-cbe']) {
      const result = await post(path, { reference: 'not-a-cbe-reference', provider: 'cbe' }, 'a', path.startsWith('/dashboard'));
      assert.equal(result.response.status, 400);
    }
    assert.equal(charges, before);
  });
  await t.test('quota and rate limits still block cached dashboard hits', async () => {
    const ws = workspaces.get('a'); ws.verificationCredits = 0;
    assert.equal((await post('/dashboard/a/verify', { reference: ref, provider: 'dashen' }, 'a', true)).response.status, 402);
    ws.verificationCredits = 100;
    workspace('rate'); limit = 1; invalidateBillingConfigCache();
    const first = await post('/dashboard/rate/verify', { reference: ref, provider: 'dashen' }, 'rate', true);
    assert.equal(first.response.status, 200);
    assert.equal((await post('/dashboard/rate/verify', { reference: ref, provider: 'dashen' }, 'rate', true)).response.status, 429);
    limit = 1000; invalidateBillingConfigCache();
  });
  await t.test('concurrent dashboard/API requests coalesce yet deduct independently', async () => {
    const before = providerCalls, billed = charges;
    const input = { reference: '9994567890123456', provider: 'dashen' };
    const results = await Promise.all([post('/dashboard/a/verify', input, 'a', true), post('/verify-dashen', input)]);
    assert.ok(results.every((r) => r.response.status === 200));
    assert.equal(providerCalls, before + 1); assert.equal(charges, billed + 2);
    assert.ok(results.some((r) => r.response.headers.get('x-verify-cache') === 'coalesced'));
  });
  await t.test('GET receiptNumber aliases are validated and charged', async () => {
    const before = charges;
    const response = await fetch(url + '/verify-cbebirr?receiptNumber=CB12345678&phoneNumber=251911111111', { headers: { 'x-api-key': 'a' } });
    assert.equal(response.status, 200); await response.json(); assert.equal(charges, before + 1);
  });
  await t.test('concurrent cached requests cannot spend the last credit twice', async () => {
    const ws = workspace('last', 2);
    await post('/dashboard/last/verify', { reference: ref, provider: 'dashen' }, 'last', true);
    ws.verificationCredits = 1;
    const before = charges, calls = providerCalls;
    const outcomes = await Promise.all([
      post('/dashboard/last/verify', { reference: ref, provider: 'dashen' }, 'last', true),
      post('/verify-dashen', { reference: ref }, 'last'),
    ]);
    assert.deepEqual(outcomes.map((r) => r.response.status).sort(), [200, 402]);
    assert.equal(ws.verificationCredits, 0);
    assert.equal(charges, before + 1); assert.equal(providerCalls, calls);
  });
  await t.test('batch validates all items before bulk charging and shares provider planning', async () => {
    workspace('batch');
    const before = charges;
    const invalid = await post('/verify-batch', { references: [{ provider: 'cbe', reference: 'invalid' }] }, 'batch');
    assert.equal(invalid.response.status, 400); assert.equal(charges, before);
    const valid = await post('/verify-batch', { references: [
      { provider: 'telebirr', reference: 'CE12345678' }, { provider: 'dashen', reference: ref },
    ] }, 'batch');
    assert.equal(valid.response.status, 200); assert.equal(valid.data.succeeded, 2);
    assert.equal(workspaces.get('batch').verificationCredits, 98);
  });
  await t.test('provider failures are not cached, and dashboard reports failures consistently', async () => {
    fail = true; const before = providerCalls;
    for (let i = 0; i < 2; i++) {
      const result = await post('/dashboard/a/verify', { reference: '8884567890123456', provider: 'dashen' }, 'a', true);
      assert.equal(result.response.status, 422); assert.equal(result.data.success, false);
    }
    assert.equal(providerCalls, before + 2); fail = false;
  });
});

test('public pipeline never charges or emits tenant events even with an attached context', async (t) => {
  const { createVerificationPipeline } = await import('../middleware/verificationPipeline');
  const { createVerificationCache } = await import('../middleware/verifyResultCache');
  let providerCalls = 0;
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as any).workspaceContext = { workspace: { id: 'a' }, source: 'dashboard' }; next(); });
  app.post('/public', ...createVerificationPipeline({ public: true }, {
    rateLimit: () => assert.fail('public entry point owns its own throttle'),
    quota: () => assert.fail('no public quota mutation'),
    webhook: () => assert.fail('no public tenant events'),
    cache: createVerificationCache(),
    execute: async () => { providerCalls++; return { success: true, httpStatus: 200, data: { success: true } }; },
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  for (let i = 0; i < 2; i++) {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/public`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reference: 'CE12345678' }),
    });
    assert.equal(res.status, 200); await res.json(); assert.equal(res.headers.get('x-verify-cache'), 'bypass');
  }
  assert.equal(providerCalls, 2);
});
