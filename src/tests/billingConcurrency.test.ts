// Three availability/billing-correctness defects:
//  - the plan rate limit was keyed only on the API key id, so a tenant could
//    multiply their contracted requests-per-minute by minting extra keys;
//  - the image-credit period initialisation was an unguarded
//    read-modify-write, so N concurrent requests on a workspace with a NULL
//    imageCreditsResetAt all granted the monthly allowance;
//  - a provider call that never settled stranded its in-flight cache slot, and
//    once maxInFlight was reached every later request short-circuited to 503.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createVerificationCache } from '../middleware/verifyResultCache';
import { rateLimiter } from '../middleware/rateLimiter';
import { invalidateBillingConfigCache } from '../config/billingConfig';
import { getSyncedPlanState } from '../middleware/tierGate';
import { prisma } from '../utils/prisma';
import type { SmartVerifyResult, VerificationPlan } from '../services/verifyUniversal';

const PLAN = { reference: 'FT2513001V2G', provider: 'CBE' } as unknown as VerificationPlan;
const OK: SmartVerifyResult = { success: true, httpStatus: 200, data: { transactionStatus: 'Completed' } } as SmartVerifyResult;

test('a provider call that never settles releases its in-flight slot', async () => {
  const cache = createVerificationCache({ ttlMs: 60_000, maxInFlight: 1, executeTimeoutMs: 40 });
  // Never resolves: this is the hang that previously leaked a slot forever.
  const outcome = await cache.run('ws-1', PLAN, () => new Promise<SmartVerifyResult>(() => { }));
  assert.equal(outcome.cache, 'bypass');
  assert.equal(outcome.result.httpStatus, 503, 'a hang is retryable, not an internal error');
  assert.equal(cache.stats().inFlight, 0, 'the slot must be released after the timeout');
  assert.equal(cache.stats().timeouts, 1);

  // Capacity is genuinely available again, rather than every call 503-ing.
  const after = await cache.run('ws-1', { ...PLAN, reference: 'FT2513002V2G' } as VerificationPlan, async () => OK);
  assert.equal(after.result.success, true);
  assert.equal(after.cache, 'miss');
});

test('a slow-but-finishing call is not cut off early', async () => {
  const cache = createVerificationCache({ ttlMs: 60_000, maxInFlight: 4, executeTimeoutMs: 5_000 });
  const outcome = await cache.run('ws-1', PLAN, async () => {
    await new Promise((r) => setTimeout(r, 60));
    return OK;
  });
  assert.equal(outcome.result.success, true);
  assert.equal(cache.stats().inFlight, 0);
});

test('the plan rate limit is enforced per workspace, not only per key', async (t) => {
  const originals: Array<() => void> = [];
  function replace(object: any, key: string, value: any) {
    const original = object[key];
    object[key] = value;
    originals.push(() => { object[key] = original; });
  }
  // 20 requests/min for the tier; each from a *different* key in one workspace.
  replace(prisma.planPricingConfig, 'findUnique', async () => ({
    freeRateLimit: 20, proRateLimit: 20, businessRateLimit: 20,
    businessUnlimitedVerifications: false,
  } as any));
  // getBillingConfig caches for 30s, so each test must start from a clean slate.
  invalidateBillingConfigCache();

  const workspace = {
    id: 'ws-multi', tier: 'PRO', grandfathered: false, verificationCredits: 1000,
    verificationCreditsMonthly: 1000, verificationCreditsResetAt: new Date('2099-01-01'),
    imageCredits: 0, imageCreditsMonthly: 0, imageCreditsResetAt: new Date('2099-01-01'),
    paidUntil: null, planTermMonths: null,
  };
  replace(prisma.workspace, 'updateMany', async () => ({ count: 0 }));

  const statuses: number[] = [];
  for (let i = 0; i < 25; i++) {
    const req: any = {
      method: 'POST', headers: {}, path: '/verify', query: {},
      get: () => 'test', socket: { remoteAddress: '127.0.0.1' },
      // A fresh key every time: per-key counting alone would allow all 25.
      apiKeyData: { id: `key-${i}`, workspaceId: 'ws-multi' },
      workspaceContext: { workspace: { ...workspace }, source: 'api_key' },
    };
    statuses.push(await new Promise<number>((resolve) => {
      const res: any = { statusCode: 200, status(c: number) { this.statusCode = c; return this; },
        json() { resolve(this.statusCode); return this; } };
      rateLimiter(req, res, () => resolve(200));
    }));
  }
  t.after(() => { originals.reverse().forEach((restore) => restore()); invalidateBillingConfigCache(); });

  assert.ok(statuses.includes(429),
    `the workspace limit should trip even with a distinct key per request, got ${statuses.join(',')}`);
  const allowed = statuses.filter((s) => s === 200).length;
  assert.ok(allowed <= 20, `expected at most the 20/min plan limit, got ${allowed}`);
});

test('the image-credit period is initialised exactly once under concurrency', async (t) => {
  const originals: Array<() => void> = [];
  function replace(object: any, key: string, value: any) {
    const original = object[key];
    object[key] = value;
    originals.push(() => { object[key] = original; });
  }
  // One shared row, still uninitialised, so every caller believes it must grant.
  const row: any = {
    id: 'ws-img', tier: 'PRO', grandfathered: false,
    verificationCredits: 1000, verificationCreditsMonthly: 1000, verificationCreditsResetAt: new Date('2099-01-01'),
    imageCredits: 0, imageCreditsMonthly: 100, imageCreditsResetAt: null,
    paidUntil: null, planTermMonths: null,
  };
  let grants = 0;
  replace(prisma.workspace, 'update', async ({ data }: any) => {
    // Covers the verification-credit branches, which we skip by giving the row a
    // resetAt in the future.
    Object.assign(row, data);
    return { ...row };
  });
  replace(prisma.workspace, 'updateMany', async ({ where, data }: any) => {
    // Emulate the database, not the caller: the WHERE is evaluated against the
    // row's *current* state at execution time, so once one statement sets
    // imageCreditsResetAt the rest match nothing. Checking the argument
    // instead would let every concurrent caller "win".
    if (where.imageCreditsResetAt === null && row.imageCreditsResetAt === null) {
      grants += 1;
      row.imageCredits += data.imageCredits.increment;
      row.imageCreditsResetAt = data.imageCreditsResetAt;
      return { count: 1 };
    }
    return { count: 0 };
  });
  replace(prisma.workspace, 'findUnique', async () => ({ ...row }));
  replace(prisma.planPricingConfig, 'findUnique', async () => ({
    proImageCredits: 100, freeImageCredits: 0, businessImageCredits: 300,
    proRateLimit: 60, freeRateLimit: 10, businessRateLimit: 300,
    proQuotaMonthly: 2000, freeQuotaNewMonthly: 100, businessQuotaMonthly: 50000,
    businessUnlimitedVerifications: false,
  } as any));
  invalidateBillingConfigCache();
  t.after(() => { originals.reverse().forEach((restore) => restore()); invalidateBillingConfigCache(); });

  // A distinct request per call, because getSyncedPlanState memoises per request.
  const makeReq = () => ({
    method: 'POST', headers: {}, path: '/verify', query: {}, get: () => 'test',
    socket: { remoteAddress: '127.0.0.1' },
    apiKeyData: { id: 'k', workspaceId: 'ws-img' },
    workspaceContext: { workspace: { ...row }, source: 'api_key' },
  } as any);

  await Promise.all(Array.from({ length: 20 }, () => getSyncedPlanState(makeReq())));

  assert.equal(grants, 1, 'the period must be claimed by exactly one caller');
  assert.equal(row.imageCredits, 100, 'the monthly allowance must be granted once, not 20 times');
});
