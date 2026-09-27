// getRequestIp used to return the leftmost X-Forwarded-For entry — a value the
// caller fully controls. Every IP-based throttle keyed off it, so prepending
// entries produced an unlimited number of fresh buckets: the anonymous
// POST /verify/public cap (10/hour) and the anonymous rateLimiter cap (6/hour)
// were both defeated with one header, and the per-IP stats map grew per request.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { AddressInfo } from 'node:net';
import { getRequestIp } from '../utils/requestIp';

async function serve(t: any) {
  const app = express();
  app.get('/ip', (req, res) => res.json({ ip: getRequestIp(req) }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ip`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => setImmediate(r));
  });
  return async (headers: Record<string, string>) => {
    const response = await fetch(url, { headers });
    return (await response.json() as { ip: string }).ip;
  };
}

test('prepending entries to X-Forwarded-For cannot mint a new identity', async (t) => {
  const ip = await serve(t);
  // The nearest trusted proxy appends the real peer address, so it is the
  // rightmost entry. A caller can add entries ahead of it but never change it.
  const real = '198.51.100.4';
  const first = await ip({ 'x-forwarded-for': `203.0.113.7, ${real}`, 'x-real-ip': '203.0.113.7' });
  const second = await ip({ 'x-forwarded-for': `192.0.2.99, ${real}`, 'x-real-ip': '192.0.2.99' });
  const padded = await ip({ 'x-forwarded-for': `192.0.2.1, 192.0.2.2, 192.0.2.3, ${real}` });

  assert.equal(first, real);
  assert.equal(second, first, 'a different forged entry changed the resolved client IP');
  assert.equal(padded, first, 'padding X-Forwarded-For changed the resolved client IP');
  // X-Real-IP is client-supplied too and must not be consulted at all.
  assert.doesNotMatch(first, /^203\.0\.113\./);
  assert.doesNotMatch(first, /^192\.0\.2\./);
});

test('CF-Connecting-IP wins because Cloudflare overwrites it at the edge', async (t) => {
  const ip = await serve(t);
  assert.equal(await ip({ 'cf-connecting-ip': '198.51.100.77', 'x-forwarded-for': '203.0.113.7' }), '198.51.100.77');
});

test('with no forwarded headers the socket address is used', async (t) => {
  const ip = await serve(t);
  const resolved = await ip({});
  assert.ok(resolved && resolved !== 'unknown', `expected a resolved IP, got ${resolved}`);
  assert.match(resolved, /^::ffff:127\.0\.0\.1$|^127\.0\.0\.1$/);
});

// Documented limitation, not an assertion of safety: the rightmost-entry rule is
// only sound because a proxy in front of this process appends to
// X-Forwarded-For. If the app were ever reached with no appending proxy, a
// caller's own header would be the only value present. On Render the proxy
// always appends, and Cloudflare supplies CF-Connecting-IP, so this cannot occur
// in the deployed topology. Kept as a reminder if the deployment changes.
