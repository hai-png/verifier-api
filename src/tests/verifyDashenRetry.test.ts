import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { verifyDashen } from '../services/verifyDashen';

test('Dashen never retries permanent 4xx and bounds transient retries', async (t) => {
  const original = axios.get;
  const budget = process.env.DASHEN_TOTAL_TIMEOUT_MS;
  t.after(() => { axios.get = original; if (budget === undefined) delete process.env.DASHEN_TOTAL_TIMEOUT_MS; else process.env.DASHEN_TOTAL_TIMEOUT_MS = budget; });
  for (const status of [400, 401, 403, 404, 429]) {
    let calls = 0;
    axios.get = (async () => { calls++; throw Object.assign(new Error('upstream'), { response: { status } }); }) as typeof axios.get;
    assert.equal((await verifyDashen('test')).success, false);
    assert.equal(calls, 1);
  }
  let calls = 0;
  process.env.DASHEN_TOTAL_TIMEOUT_MS = '1000';
  axios.get = (async (_url: unknown, config: any) => { calls++; assert.ok(config.timeout <= 1000); throw new Error('network'); }) as typeof axios.get;
  assert.equal((await verifyDashen('test')).success, false);
  assert.equal(calls, 2);
  process.env.DASHEN_TOTAL_TIMEOUT_MS = '100'; calls = 0;
  await verifyDashen('test'); assert.equal(calls, 1);
});
