// requireSession used to accept any correctly-signed token forever: no database
// lookup and no expiry check. It also looked the row up by the raw bearer token,
// which meant Session.sessionToken stored live credentials in plaintext. Logout deleted the row but the token kept working
// on every /dashboard and /workspaces route, and a token signed with the old
// 'fallback-secret' constant was accepted whenever DASHBOARD_SECRET was unset.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { AddressInfo } from 'node:net';
import { prisma } from '../utils/prisma';
import workspacesRouter from '../routes/workspaces';
import { hashSessionToken } from '../routes/auth';

const SECRET = 'session-revocation-test-secret-value';
const USER_ID = 'user-revocation';

function sign(payload: string, secret = SECRET): string {
  return `nvd_sess_${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`;
}

test('a session token is only valid while its row exists and is unexpired', async (t) => {
  const previousSecret = process.env.DASHBOARD_SECRET;
  process.env.DASHBOARD_SECRET = SECRET;
  const payload = `${USER_ID}.randomnonce`;
  const token = sign(payload);

  // Mutable stand-in for the Session table.
  let row: { userId: string; expires: Date } | null = { userId: USER_ID, expires: new Date('2099-01-01') };
  const originals: Array<() => void> = [];
  function replace(object: any, key: string, value: any) {
    const original = object[key];
    object[key] = value;
    originals.push(() => { object[key] = original; });
  }
  let authedLookups = 0;
  const lookedUpWith: string[] = [];
  replace(prisma.session, 'findUnique', async ({ where }: any) => {
    lookedUpWith.push(String(where.sessionToken));
    // Sessions are stored as SHA-256 of the token; the raw value must never be
    // the lookup key, because then it is also what sits in the column.
    if (where.sessionToken !== hashSessionToken(token)) return null;
    return row ? { ...row } : null;
  });
  replace(prisma.membership, 'findMany', async () => { authedLookups++; return []; });
  t.after(() => {
    originals.reverse().forEach((restore) => restore());
    if (previousSecret === undefined) delete process.env.DASHBOARD_SECRET; else process.env.DASHBOARD_SECRET = previousSecret;
  });

  const app = express();
  app.use(express.json());
  app.use('/workspaces', workspacesRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/workspaces`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => setImmediate(r));
  });

  const get = (bearer: string) => fetch(url, { headers: { Authorization: `Bearer ${bearer}` } });

  // A live session works.
  assert.equal((await get(token)).status, 200);
  assert.equal(authedLookups, 1);

  // The bearer token itself is never used as a database key.
  assert.ok(lookedUpWith.length > 0);
  assert.ok(
    lookedUpWith.every((key) => /^[a-f0-9]{64}$/.test(key)),
    `session lookups must use a sha256, saw: ${lookedUpWith[0]?.slice(0, 32)}`,
  );
  assert.ok(!lookedUpWith.includes(token), 'the raw token must not be queried or stored');

  // Logout deletes the row; the same token must stop working immediately.
  row = null;
  const afterLogout = await get(token);
  assert.equal(afterLogout.status, 401);
  assert.equal(authedLookups, 1, 'must not reach the handler once revoked');

  // An expired row is rejected even though the signature is still valid.
  row = { userId: USER_ID, expires: new Date('2000-01-01') };
  assert.equal((await get(token)).status, 401);

  // The row must belong to the user encoded in the token.
  row = { userId: 'someone-else', expires: new Date('2099-01-01') };
  assert.equal((await get(token)).status, 401);

  // Wrong secret, the old published fallback, and malformed tokens are rejected.
  row = { userId: USER_ID, expires: new Date('2099-01-01') };
  for (const bad of [
    sign(payload, 'a-different-secret'),
    sign(payload, 'fallback-secret'),
    'nvd_sess_bogus',
    'not-a-session-token',
  ]) {
    assert.equal((await get(bad)).status, 401, `expected 401 for ${bad.slice(0, 24)}`);
  }
  assert.equal(authedLookups, 1, 'no rejected token may reach the handler');
});
