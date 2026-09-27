// Shared secrets (ADMIN_SECRET, DASHBOARD_SECRET) must fail closed. Both once
// fell back to a literal published in this repository, which made /admin/* and
// every session token forgeable whenever the variable was missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { AddressInfo } from 'node:net';
import { safeSecretEquals } from '../utils/secretCompare';

test('safeSecretEquals never accepts an unset or empty expected secret', () => {
  assert.equal(safeSecretEquals('anything', undefined), false);
  assert.equal(safeSecretEquals('anything', ''), false);
  // The trap: with `expected === ''`, a plain `===` would let a request that
  // sends an empty credential header authenticate.
  assert.equal(safeSecretEquals('', ''), false);
  assert.equal(safeSecretEquals(undefined, ''), false);
  assert.equal(safeSecretEquals(null, 'secret'), false);
  assert.equal(safeSecretEquals(123, '123'), false);
});

test('safeSecretEquals accepts only the exact secret', () => {
  const secret = 'a'.repeat(64);
  assert.equal(safeSecretEquals(secret, secret), true);
  assert.equal(safeSecretEquals(secret.slice(0, -1), secret), false);
  assert.equal(safeSecretEquals(`${secret}x`, secret), false);
  assert.equal(safeSecretEquals(secret.toUpperCase(), secret), false);
});

test('an unconfigured secret cannot authenticate the admin API', async (t) => {
  // Simulates ADMIN_SECRET being absent at module load, which is what happens
  // on a fresh Render service where the variable is `sync: false`.
  const previous = process.env.ADMIN_SECRET;
  delete process.env.ADMIN_SECRET;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  t.after(() => {
    if (previous === undefined) delete process.env.ADMIN_SECRET; else process.env.ADMIN_SECRET = previous;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
  });

  // Imported after the variable is cleared so the module-level constant is empty.
  const { default: adminRouter } = await import('../routes/adminRoute');
  const app = express();
  app.use(express.json());
  app.use('/admin', adminRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => setImmediate(r));
  });

  // Including the previously published literal and the empty-header trick.
  for (const headers of [
    { 'x-admin-key': 'change-this-secret-key' },
    { 'x-admin-key': '' },
    {} as Record<string, string>,
  ]) {
    const response = await fetch(`${url}/admin/api-keys`, { headers });
    assert.equal(response.status, 403, `expected 403 for ${JSON.stringify(headers)}`);
  }

  // The query-string transport is rejected for the same reason.
  const viaQuery = await fetch(`${url}/admin/api-keys?adminKey=change-this-secret-key`);
  assert.equal(viaQuery.status, 403);
});
