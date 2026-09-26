import test from 'node:test';
import assert from 'node:assert/strict';
import { singleFlight } from '../utils/singleFlight';

test('100 concurrent readiness checks share one operation, not its completed result', async () => {
  let calls = 0;
  const run = singleFlight(async () => ++calls);
  const results = await Promise.all(Array.from({ length: 100 }, () => run()));
  assert.equal(calls, 1);
  assert.ok(results.every((n) => n === 1));
  assert.equal(await run(), 2);
});
test('failure is shared, then a fresh check can recover', async () => {
  let calls = 0;
  const run = singleFlight(async () => {
    if (++calls === 1) throw new Error('database unavailable');
    return true;
  });
  const results = await Promise.allSettled([run(), run()]);
  assert.ok(results.every((r) => r.status === 'rejected'));
  assert.equal(calls, 1);
  assert.equal(await run(), true);
});
