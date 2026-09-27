// Two anonymous DoS levers on a 512 MB instance:
//  - /auth/login and /auth/signup each cost a bcrypt operation at cost 10
//    (~100 ms CPU) and had no limit at all.
//  - the request-logger stats maps and the forgot-password throttle were
//    unbounded Maps keyed partly on caller-supplied values.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { AddressInfo } from 'node:net';
import { prisma } from '../utils/prisma';
import authRouter from '../routes/auth';

// Read by the request logger at module load, so it has to be set before the
// dynamic import below. A deliberately tiny cap makes eviction observable.
process.env.STATS_MAX_KEYS = '50';

function serve(t: any, router: express.Router, mount: string) {
  const app = express();
  app.use(express.json());
  app.use(mount, router);
  const server = app.listen(0, '127.0.0.1');
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    server.once('listening', () => {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${mount}`;
      resolve({
        url,
        close: async () => {
          server.closeAllConnections();
          await new Promise<void>((r) => server.close(() => r()));
          await new Promise<void>((r) => setImmediate(r));
        },
      });
    });
  });
}

test('login is throttled per account and per client', async (t) => {
  const originals: Array<() => void> = [];
  function replace(object: any, key: string, value: any) {
    const original = object[key];
    object[key] = value;
    originals.push(() => { object[key] = original; });
  }
  // No user matches, so the handler takes the cheap "invalid credentials" path
  // after the limiter has already run.
  replace(prisma.user, 'findUnique', async () => null);
  t.after(() => originals.reverse().forEach((restore) => restore()));

  const { url, close } = await serve(t, authRouter, '/auth');
  t.after(close);

  const attempt = (email: string) => fetch(`${url}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.10' },
    body: JSON.stringify({ email, password: 'wrong-password' }),
  });

  const statuses: number[] = [];
  for (let i = 0; i < 14; i++) statuses.push((await attempt('victim@example.com')).status);
  assert.ok(statuses.includes(429), `expected a 429 after repeated attempts, got ${statuses.join(',')}`);

  // A malformed address is rejected without spending bcrypt, and with the same
  // response as a wrong password so it cannot enumerate accounts.
  const malformed = await fetch(`${url}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.11' },
    body: JSON.stringify({ email: 'not-an-email', password: 'x' }),
  });
  assert.equal(malformed.status, 401);
  assert.match((await malformed.json() as any).error, /invalid email or password/i);
});

test('signup is capped per client', async (t) => {
  const originals: Array<() => void> = [];
  function replace(object: any, key: string, value: any) {
    const original = object[key];
    object[key] = value;
    originals.push(() => { object[key] = original; });
  }
  replace(prisma.user, 'findUnique', async () => null);
  t.after(() => originals.reverse().forEach((restore) => restore()));

  const { url, close } = await serve(t, authRouter, '/auth');
  t.after(close);

  const statuses: number[] = [];
  for (let i = 0; i < 8; i++) {
    const response = await fetch(`${url}/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.20' },
      body: JSON.stringify({ email: `user${i}@example.com`, password: 'correct-horse-battery' }),
    });
    statuses.push(response.status);
  }
  assert.ok(statuses.includes(429), `expected a 429 signup to be throttled, got ${statuses.join(',')}`);
});

test('the stats maps stay bounded under path and header fuzzing', async (t) => {
  const { requestLogger, statsCacheState } = await import('../middleware/requestLogger');
  const app = express();
  app.use(requestLogger);
  app.get('/fuzz/:id', (_req, res) => { res.json({ ok: true }); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => setImmediate(r));
  });

  // 300 distinct paths and 300 distinct client identities against a 50-key cap.
  for (let i = 0; i < 300; i++) {
    await fetch(`${base}/fuzz/${i}-${'x'.repeat(i % 17)}`, {
      headers: { 'x-forwarded-for': `10.0.${Math.floor(i / 250)}.${i % 250}, 198.51.100.${i % 250}` },
    });
  }

  const state = statsCacheState();
  assert.equal(state.maxKeys, 50, 'the small test cap should be in effect');
  assert.ok(state.endpointKeys <= 50, `endpointStats grew past the cap: ${state.endpointKeys}`);
  assert.ok(state.ipKeys <= 50, `ipStats grew past the cap: ${state.ipKeys}`);
  // Eviction happens while requests are in flight, so the 'finish' handler must
  // tolerate a missing entry rather than dereferencing undefined.
  assert.ok(state.totalRequests >= 300, `expected the requests to be counted, got ${state.totalRequests}`);
});
