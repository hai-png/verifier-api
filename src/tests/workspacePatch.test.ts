// Guards the self-service workspace PATCH. Plan tier, monthly allowances and
// credit balances are settlement state: only the paid billing path and /admin
// may write them. Accepting them from a client body let any workspace OWNER
// mint unlimited paid verifications with a single request.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { AddressInfo } from 'node:net';
import { prisma } from '../utils/prisma';
import workspacesRouter from '../routes/workspaces';

const TEST_SECRET = 'workspace-patch-regression-secret';
const USER_ID = 'user-owner';
const WORKSPACE_ID = 'ws-owner';

function sessionToken(userId: string): string {
  const payload = `${userId}.${crypto.randomBytes(8).toString('hex')}`;
  const hmac = crypto.createHmac('sha256', TEST_SECRET).update(payload).digest('hex');
  return `nvd_sess_${payload}.${hmac}`;
}

test('workspace PATCH is limited to the display name', async (t) => {
  const previousSecret = process.env.DASHBOARD_SECRET;
  process.env.DASHBOARD_SECRET = TEST_SECRET;
  const token = sessionToken(USER_ID);

  const workspace = {
    id: WORKSPACE_ID, name: 'Original', tier: 'FREE', verificationCredits: 100,
    imageCredits: 5, grandfathered: false,
  };
  const updates: any[] = [];
  let role: string = 'OWNER';
  const originals: Array<() => void> = [];
  function replace(object: any, key: string, value: any) {
    const original = object[key];
    object[key] = value;
    originals.push(() => { object[key] = original; });
  }
  replace(prisma.session, 'findUnique', async () => ({ userId: USER_ID, expires: new Date('2099-01-01') }));
  replace(prisma.membership, 'findUnique', async () => ({ role }));
  replace(prisma.workspace, 'update', async ({ data }: any) => {
    updates.push(data);
    Object.assign(workspace, data);
    return { ...workspace };
  });
  t.after(() => {
    originals.reverse().forEach((restore) => restore());
    if (previousSecret === undefined) delete process.env.DASHBOARD_SECRET;
    else process.env.DASHBOARD_SECRET = previousSecret;
  });

  const app = express();
  app.use(express.json());
  app.use('/workspaces', workspacesRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => setImmediate(r));
  });

  const patch = (body: unknown) => fetch(`${url}/workspaces/${WORKSPACE_ID}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

  // A rename still works, and writes nothing but the name.
  const renamed = await patch({ name: '  Renamed  ' });
  assert.equal(renamed.status, 200);
  assert.deepEqual(updates.at(-1), { name: 'Renamed' });

  // Plan tier and credit balances are ignored even when sent by an OWNER.
  for (const attempt of [
    { name: 'Escalate', tier: 'BUSINESS' },
    { name: 'Escalate', verificationCredits: 999_999_999 },
    { name: 'Escalate', imageCredits: 999_999_999 },
    { name: 'Escalate', grandfathered: true },
    { name: 'Escalate', verificationCreditsMonthly: 50_000, paidUntil: '2099-01-01T00:00:00.000Z' },
  ]) {
    const response = await patch(attempt);
    assert.equal(response.status, 200);
    assert.deepEqual(updates.at(-1), { name: 'Escalate' }, `leaked privilege fields: ${JSON.stringify(attempt)}`);
  }
  assert.equal(workspace.tier, 'FREE');
  assert.equal(workspace.verificationCredits, 100);
  assert.equal(workspace.imageCredits, 5);
  assert.equal(workspace.grandfathered, false);

  // A name is required and must be a plausible string.
  for (const body of [{}, { name: 'x' }, { name: '   ' }, { name: 123 }, { name: 'y'.repeat(121) }]) {
    const response = await patch(body);
    assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }

  // Plain members cannot rename at all.
  role = 'MEMBER';
  const denied = await patch({ name: 'Renamed by member' });
  assert.equal(denied.status, 403);
});
