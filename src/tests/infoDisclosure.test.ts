// Two information-disclosure / injection-hygiene items:
//  - five provider fetchers interpolated the caller's reference straight into a
//    bank URL. The host was fixed, so this was never cross-host SSRF, but it
//    allowed path traversal and query-parameter injection within the bank
//    origin, plus log injection (the raw reference is also logged).
//  - GET /status/summary published host memory, PID, node version, cache sizes
//    and real SQL statement text to anonymous callers.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { AddressInfo } from 'node:net';
import publicStatusRouter from '../routes/publicStatus';

const MONITOR_SECRET = 'status-monitor-gating-test-secret';

test('provider URLs encode the caller-supplied reference', async (t) => {
  const axios = (await import('axios')).default;
  // A reference that traverses paths and injects a query parameter when
  // interpolated raw.
  const hostile = '../../admin?x=1&PH=251900000000';
  const seen: string[] = [];
  const originals: Array<() => void> = [];
  function replace(object: any, key: string, value: any) {
    const original = object[key];
    object[key] = value;
    originals.push(() => { object[key] = original; });
  }
  // Capture the URL each fetcher builds, then fail so we never hit a bank.
  replace(axios, 'get', async (url: string) => {
    seen.push(url);
    throw new Error('intercepted');
  });
  t.after(() => originals.reverse().forEach((restore) => restore()));

  const { verifyAwash } = await import('../services/verifyAwash');
  const { verifyZemen } = await import('../services/verifyZemen');
  const { verifyDashen } = await import('../services/verifyDashen');

  await verifyAwash(hostile).catch(() => undefined);
  await verifyZemen(hostile).catch(() => undefined);
  await verifyDashen(hostile).catch(() => undefined);

  // Awash and Zemen retry up to 3x and Dashen 2x, so several attempts are
  // expected; every distinct URL must still be safely encoded.
  const urls = [...new Set(seen)];
  assert.ok(urls.length >= 3, `expected URLs from all three fetchers, saw ${urls.length}`);
  for (const url of urls) {
    // The host is fixed, so this was never cross-host SSRF; the risk was
    // traversal and parameter injection *within* the bank origin.
    assert.ok(/^https:\/\//.test(url), `unexpected scheme in ${url}`);
    assert.ok(!url.includes('../'), `path traversal survived in ${url}`);
    assert.ok(!url.includes('?x=1'), `query injection survived in ${url}`);
    assert.ok(!url.includes('&PH='), `parameter injection survived in ${url}`);
    assert.ok(url.includes(encodeURIComponent(hostile)), `reference was not encoded in ${url}`);
  }
});

test('status diagnostics are withheld from anonymous callers', async (t) => {
  const previous = process.env.STATUS_MONITOR_SECRET;
  process.env.STATUS_MONITOR_SECRET = MONITOR_SECRET;
  t.after(() => {
    if (previous === undefined) delete process.env.STATUS_MONITOR_SECRET;
    else process.env.STATUS_MONITOR_SECRET = previous;
  });

  const app = express();
  app.use('/status', publicStatusRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/status/summary`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => setImmediate(r));
  });

  const anonymous = await (await fetch(url)).json() as any;
  assert.equal(anonymous.status, 'operational');
  assert.equal(anonymous.diagnostics, null, 'host internals must not be public');
  // Liveness and the capability surface stay public on purpose.
  assert.ok(Array.isArray(anonymous.providers));
  assert.ok(anonymous.capabilities);

  // With the secret, the operator gets the full picture back.
  const authorised = await (await fetch(url, { headers: { 'x-status-secret': MONITOR_SECRET } })).json() as any;
  assert.ok(authorised.diagnostics, 'the secret holder must still see diagnostics');
  assert.equal(typeof authorised.diagnostics.process.pid, 'number');

  // A wrong secret changes nothing.
  const wrong = await (await fetch(url, { headers: { 'x-status-secret': 'nope' } })).json() as any;
  assert.equal(wrong.diagnostics, null);
});
