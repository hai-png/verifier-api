// getBillingConfig() sits on every authenticated request. Its 30s cache used to
// make one request in every 30s window pay a full cross-region round trip
// (~300ms measured on the deployed API, inside `rate_limit`). With
// stale-while-revalidate, an expired row is served immediately and refreshed in
// the background, so no request waits on it.
//
// The three properties that matter, in order of how badly a regression would
// hurt: the caller never waits on a refresh; a refresh that keeps failing does
// not lose the last good row or wedge the cache; and past the stale window the
// service blocks on a real read again rather than serving ancient pricing
// forever. The third is what stops this from becoming a correctness bug.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getBillingConfig, invalidateBillingConfigCache } from '../config/billingConfig';
import { prisma } from '../utils/prisma';

// The TTL is read at module load from BILLING_CONFIG_CACHE_TTL_MS (30s by
// default). These tests do not wait that long: they move the clock instead.
function withClock(t: any) {
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  t.after(() => { Date.now = realNow; });
  return { advance: (ms: number) => { offset += ms; } };
}

test('an expired billing config is served stale and refreshed in the background', async (t) => {
  const clock = withClock(t);
  const original = prisma.planPricingConfig.findUnique;
  let calls = 0;
  let release: (() => void) | null = null;
  (prisma.planPricingConfig as any).findUnique = async () => {
    calls += 1;
    if (calls === 1) return { freeRateLimit: 11 } as any;
    // Second load: hold it open so we can prove the caller did not wait on it.
    //
    // The hold is bounded, and that bound is the point. With the hold open
    // forever, a regression that made the caller await the refresh would
    // deadlock this test rather than fail it, and CI would sit on it until the
    // job timeout with no diagnostic. Racing a timer means the same regression
    // fails here in 2s with a message that says what happened.
    await new Promise<void>((resolve, reject) => {
      release = resolve;
      setTimeout(() => reject(new Error(
        'the refresh did not land: the caller was waiting on it, so stale-while-revalidate is not working'
      )), 2000).unref?.();
    });
    return { freeRateLimit: 22 } as any;
  };
  t.after(() => { (prisma.planPricingConfig as any).findUnique = original; invalidateBillingConfigCache(); });
  invalidateBillingConfigCache();

  const first = await getBillingConfig();
  assert.equal(first.freeRateLimit, 11);
  assert.equal(calls, 1);

  clock.advance(31_000); // past the 30s TTL, inside the stale window

  const started = process.hrtime.bigint();
  const stale = await getBillingConfig();
  const waitedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(stale.freeRateLimit, 11, 'the expired row is served as-is');
  assert.equal(calls, 2, 'a background refresh was started');
  assert.ok(waitedMs < 50, `the caller must not wait on the refresh (waited ${waitedMs.toFixed(1)}ms)`);

  // While the refresh is in flight, further callers still get the stale row
  // instead of queueing behind it.
  const during = await getBillingConfig();
  assert.equal(during.freeRateLimit, 11);
  assert.equal(calls, 2, 'no second refresh is fanned out');

  release!();
  await new Promise((r) => setImmediate(r));
  const fresh = await getBillingConfig();
  assert.equal(fresh.freeRateLimit, 22, 'the refreshed row is used once it lands');
  assert.equal(calls, 2);
});

test('a failed background refresh keeps the stale row and is retried by the next caller', async (t) => {
  const clock = withClock(t);
  const original = prisma.planPricingConfig.findUnique;
  let calls = 0;
  (prisma.planPricingConfig as any).findUnique = async () => {
    calls += 1;
    if (calls === 1) return { freeRateLimit: 11 } as any;
    if (calls === 2) throw new Error('database unreachable');
    return { freeRateLimit: 33 } as any;
  };
  t.after(() => { (prisma.planPricingConfig as any).findUnique = original; invalidateBillingConfigCache(); });
  invalidateBillingConfigCache();

  assert.equal((await getBillingConfig()).freeRateLimit, 11);
  clock.advance(31_000);
  assert.equal((await getBillingConfig()).freeRateLimit, 11, 'stale served; refresh #2 fails quietly');
  await new Promise((r) => setImmediate(r));
  assert.equal((await getBillingConfig()).freeRateLimit, 11, 'still stale; refresh #3 started');
  await new Promise((r) => setImmediate(r));
  assert.equal((await getBillingConfig()).freeRateLimit, 33);
  assert.equal(calls, 3);
});

test('beyond the stale window a caller blocks on a fresh read again', async (t) => {
  const clock = withClock(t);
  const original = prisma.planPricingConfig.findUnique;
  let calls = 0;
  (prisma.planPricingConfig as any).findUnique = async () => {
    calls += 1;
    return { freeRateLimit: calls === 1 ? 11 : 44 } as any;
  };
  t.after(() => { (prisma.planPricingConfig as any).findUnique = original; invalidateBillingConfigCache(); });
  invalidateBillingConfigCache();

  assert.equal((await getBillingConfig()).freeRateLimit, 11);
  clock.advance(30_000 + 10 * 60_000 + 1); // past TTL and the 10 min stale window
  assert.equal((await getBillingConfig()).freeRateLimit, 44, 'too stale to serve: a real read happens');
});
