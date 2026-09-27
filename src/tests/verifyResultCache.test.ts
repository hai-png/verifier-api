import test from 'node:test';
import assert from 'node:assert/strict';
import { createVerificationCache } from '../middleware/verifyResultCache';
import type { SmartVerifyResult, VerificationPlan } from '../services/verifyUniversal';
const plan: VerificationPlan = { provider: 'DASHEN', reference: '1234567890123456' };
const good = (): SmartVerifyResult => ({ success: true, provider: 'DASHEN', httpStatus: 200, data: { success: true, amount: 100 } });

test('concurrent identical work coalesces and subsequent reads hit', async () => {
  const cache = createVerificationCache(); let calls = 0;
  const execute = async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return good(); };
  const results = await Promise.all(Array.from({ length: 10 }, () => cache.run('a', plan, execute)));
  assert.equal(calls, 1);
  assert.equal(results.filter((r) => r.cache === 'coalesced').length, 9);
  assert.equal((await cache.run('a', plan, execute)).cache, 'hit');
  assert.equal(cache.stats().inFlight, 0);
});
test('workspace, provider, suffix, phone and case-sensitive token isolate cache entries', async () => {
  const cache = createVerificationCache(); let calls = 0;
  const execute = async () => { calls++; return good(); };
  await cache.run('a', plan, execute);
  await cache.run('b', plan, execute);
  await cache.run('a', { ...plan, provider: 'TELEBIRR' }, execute);
  await cache.run('a', { ...plan, suffix: '12345' }, execute);
  await cache.run('a', { ...plan, phoneNumber: '251911111111' }, execute);
  await cache.run('a', { provider: 'CBE', reference: 'abcdefghijklmno' }, execute);
  await cache.run('a', { provider: 'CBE', reference: 'Abcdefghijklmno' }, execute);
  assert.equal(calls, 7);
});
test('expired success re-fetches; failures and exceptions are not retained', async () => {
  let now = 0; let calls = 0;
  const cache = createVerificationCache({ ttlMs: 10, now: () => now });
  const execute = async () => { calls++; return good(); };
  await cache.run('a', plan, execute); now = 11;
  assert.equal((await cache.run('a', plan, execute)).cache, 'miss');
  assert.equal(calls, 2);
  const bad = async (): Promise<SmartVerifyResult> => ({ success: false, httpStatus: 404 });
  await cache.run('b', plan, bad);
  assert.equal((await cache.run('b', plan, execute)).cache, 'miss');
  await assert.rejects(cache.run('c', plan, async () => { throw new Error('upstream'); }));
  assert.equal(cache.stats().inFlight, 0);
  assert.equal((await cache.run('c', plan, execute)).cache, 'miss');
});
test('returned results cannot mutate another caller’s cached data', async () => {
  const cache = createVerificationCache();
  const first = await cache.run('a', plan, async () => good());
  (first.result.data as any).amount = 999;
  const second = await cache.run('a', plan, async () => good());
  assert.equal((second.result.data as any).amount, 100);
});
test('cache and outstanding leader maps are bounded', async () => {
  const cache = createVerificationCache({ maxEntries: 1, maxInFlight: 1 });
  let release!: () => void;
  const first = cache.run('a', plan, async () => { await new Promise<void>((r) => { release = r; }); return good(); });
  await Promise.resolve();
  const second = await cache.run('b', plan, async () => good());
  assert.equal(second.result.httpStatus, 503);
  release(); await first;
  await cache.run('b', plan, async () => good());
  assert.equal(cache.stats().entries, 1);
  assert.equal(cache.stats().inFlight, 0);
});
test('public callers and explicitly disabled caches never share results', async () => {
  let calls = 0;
  const execute = async () => { calls++; return good(); };
  const cache = createVerificationCache();
  for (let i = 0; i < 2; i++) assert.equal((await cache.run(undefined, plan, execute)).cache, 'bypass');
  const disabled = createVerificationCache({ ttlMs: 0 });
  for (let i = 0; i < 2; i++) assert.equal((await disabled.run('a', plan, execute)).cache, 'bypass');
  assert.equal(calls, 4);
});
test('non-final transaction statuses are not replayed as final successes', async () => {
  const cache = createVerificationCache();
  const pending = async (): Promise<SmartVerifyResult> => ({ success: true, httpStatus: 200, data: { transactionStatus: 'Pending' } });
  await cache.run('a', plan, pending);
  assert.equal((await cache.run('a', plan, pending)).cache, 'miss');
  assert.equal(cache.stats().stored, 0);
});
