import test from 'node:test';
import assert from 'node:assert/strict';
process.env.BILLING_CONFIG_CACHE_TTL_MS = '50';
process.env.BILLING_CONFIG_MAX_STALE_MS = '10000';
import { prisma } from '../utils/prisma';
import { getBillingConfig, invalidateBillingConfigCache, DEFAULT_BILLING_CONFIG } from '../config/billingConfig';
import { coerceScalar, findActiveApiKeyWithWorkspace } from '../utils/apiKeyLookup';
import { redactUrl } from '../middleware/requestLogger';
import { resolveDatasourceUrl, connectionLimitOf } from '../utils/prisma';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function stubPricing(impl: () => Promise<unknown>) {
  let calls = 0;
  Object.defineProperty(prisma, 'planPricingConfig', {
    configurable: true,
    value: { findUnique: async () => { calls++; return impl(); } },
  });
  return () => calls;
}

test('expired billing config is served stale while one background refresh runs', async () => {
  invalidateBillingConfigCache();
  let rate = 10;
  let release!: () => void;
  let gate: Promise<void> = Promise.resolve();
  const calls = stubPricing(async () => { await gate; return { ...DEFAULT_BILLING_CONFIG, freeRateLimit: rate }; });

  assert.equal((await getBillingConfig()).freeRateLimit, 10); // cold: waits
  assert.equal(calls(), 1);
  await sleep(70); // expire
  rate = 99;
  gate = new Promise((r) => { release = r; });
  const started = Date.now();
  const results = await Promise.all(Array.from({ length: 20 }, () => getBillingConfig()));
  assert.ok(Date.now() - started < 20, 'stale reads must not wait on the database');
  assert.ok(results.every((c) => c.freeRateLimit === 10));
  assert.equal(calls(), 2, 'concurrent stale reads share one refresh');
  release();
  await sleep(5);
  assert.equal((await getBillingConfig()).freeRateLimit, 99);
});

test('failed background refresh keeps serving the cached value', async () => {
  invalidateBillingConfigCache();
  stubPricing(async () => ({ ...DEFAULT_BILLING_CONFIG, freeRateLimit: 7 }));
  await getBillingConfig();
  await sleep(70);
  stubPricing(async () => { throw new Error('db down'); });
  assert.equal((await getBillingConfig()).freeRateLimit, 7);
  await sleep(5);
  assert.equal((await getBillingConfig()).freeRateLimit, 7);
});

test('invalidation during a refresh prevents a stale overwrite', async () => {
  invalidateBillingConfigCache();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  stubPricing(async () => { await gate; return { ...DEFAULT_BILLING_CONFIG, freeRateLimit: 1 }; });
  const pending = getBillingConfig();
  invalidateBillingConfigCache();
  stubPricing(async () => ({ ...DEFAULT_BILLING_CONFIG, freeRateLimit: 2 }));
  release();
  await pending;
  assert.equal((await getBillingConfig()).freeRateLimit, 2);
});

test('raw scalar coercion matches Prisma types', () => {
  assert.equal(coerceScalar('Boolean', 1), true);
  assert.equal(coerceScalar('Boolean', 0n), false);
  assert.equal(coerceScalar('Int', 5n), 5);
  assert.ok(coerceScalar('DateTime', '2026-01-01T00:00:00Z') instanceof Date);
  assert.deepEqual(coerceScalar('Json', '["verify"]'), ['verify']);
  assert.equal(coerceScalar('String', null), null);
});

test('api key lookup maps a single joined row into key + workspace', async () => {
  let queries = 0;
  const db: any = {
    $queryRaw: async (strings: TemplateStringsArray) => {
      queries++;
      const sql = strings.join('?');
      assert.match(sql, /JOIN/);
      return [{ k__id: 'k1', k__isActive: 1, k__permissions: '["verify"]', k__workspaceId: 'w1', w__id: 'w1', w__tier: 'FREE', w__grandfathered: 0, w__paidUntil: null }];
    },
    apiKey: { findFirst: async () => { throw new Error('fallback must not run'); } },
  };
  const row: any = await findActiveApiKeyWithWorkspace(db, 'hash', 'raw');
  assert.equal(queries, 1);
  assert.equal(row.isActive, true);
  assert.deepEqual(row.permissions, ['verify']);
  assert.equal(row.workspace.id, 'w1');
  assert.equal(row.workspace.grandfathered, false);
});

test('api key lookup falls back to Prisma include when raw SQL fails', async () => {
  const db: any = {
    $queryRaw: async () => { throw new Error('dialect'); },
    apiKey: { findFirst: async () => ({ id: 'k2', workspace: { id: 'w2' } }) },
  };
  const row: any = await findActiveApiKeyWithWorkspace(db, 'h', 'r');
  assert.equal(row.id, 'k2');
});

test('secrets in query strings are redacted from logged URLs', () => {
  assert.equal(redactUrl('/verify-cbe?apiKey=sk_live_abc&x=1'), '/verify-cbe?apiKey=[redacted]&x=1');
  assert.equal(redactUrl('/health'), '/health');
});

test('pool size: default when absent, explicit URL kept, env override wins', () => {
  const base = 'mysql://u:p@h:4000/db?sslaccept=strict';
  assert.equal(connectionLimitOf(resolveDatasourceUrl(base, '')), 10);
  assert.equal(resolveDatasourceUrl(base + '&connection_limit=5', ''), base + '&connection_limit=5');
  assert.equal(connectionLimitOf(resolveDatasourceUrl(base + '&connection_limit=5', '12')), 12);
  assert.equal(resolveDatasourceUrl(base + '&connection_limit=5', 'abc'), base + '&connection_limit=5');
  assert.equal(resolveDatasourceUrl(undefined, '12'), undefined);
  assert.equal(resolveDatasourceUrl('not a url', '12'), 'not a url');
});
