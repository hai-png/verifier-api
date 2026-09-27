// There was no way to grant verification credits or a monthly allowance
// anywhere in the codebase: PATCH /admin/api-keys/:id could set `tier` (keyed
// off an API key id) and the credits endpoint adjusted image credits only. A
// customer could therefore pay and receive nothing. Upgrades are an operator
// action and now live on a workspace-scoped endpoint behind the admin secret.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { AddressInfo } from 'node:net';
import { prisma } from '../utils/prisma';
import adminRouter from '../routes/adminRoute';

const ADMIN_SECRET = 'admin-plan-grant-test-secret-value';
const WORKSPACE_ID = 'ws-plan-grant';

async function serve(t: any) {
  const previous = process.env.ADMIN_SECRET;
  process.env.ADMIN_SECRET = ADMIN_SECRET;
  t.after(() => {
    if (previous === undefined) delete process.env.ADMIN_SECRET; else process.env.ADMIN_SECRET = previous;
  });

  const workspace: any = {
    id: WORKSPACE_ID, name: 'Acme', tier: 'FREE',
    verificationCredits: 100, verificationCreditsMonthly: 100,
    imageCredits: 5, imageCreditsMonthly: 5,
    paidUntil: null, planTermMonths: null,
  };
  const writes: any[] = [];
  const originals: Array<() => void> = [];
  function replace(object: any, key: string, value: any) {
    const original = object[key];
    object[key] = value;
    originals.push(() => { object[key] = original; });
  }
  replace(prisma.workspace, 'update', async ({ data }: any) => {
    writes.push(data);
    if (data.verificationCredits?.increment) workspace.verificationCredits += data.verificationCredits.increment;
    if (data.imageCredits?.increment) workspace.imageCredits += data.imageCredits.increment;
    Object.assign(workspace, {
      ...(data.tier !== undefined ? { tier: data.tier } : {}),
      ...(data.paidUntil !== undefined ? { paidUntil: data.paidUntil } : {}),
      ...(data.planTermMonths !== undefined ? { planTermMonths: data.planTermMonths } : {}),
    });
    return { ...workspace };
  });
  t.after(() => originals.reverse().forEach((restore) => restore()));

  // The router captured ADMIN_SECRET at import time in some module layouts;
  // import after the variable is set so the constant is populated.
  const { default: router } = await import('../routes/adminRoute');
  const app = express();
  app.use(express.json());
  app.use('/admin', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/admin`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => setImmediate(r));
  });

  return {
    writes,
    post: async (body: unknown, key = ADMIN_SECRET) => {
      const response = await fetch(`${url}/workspaces/plan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-admin-key': key },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json().catch(() => ({})) as any };
    },
  };
}

test('an admin can grant a paid plan and credits', async (t) => {
  const { post, writes } = await serve(t);

  const granted = await post({
    workspaceId: WORKSPACE_ID, tier: 'BUSINESS',
    addVerificationCredits: 5000, planTermMonths: 3, note: 'invoice #1042',
  });
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  assert.equal(granted.body.data.tier, 'BUSINESS');
  assert.ok(granted.body.data.paidUntil, 'a term must set paidUntil for the auto-downgrade');

  // Credits are additive and the reset window is pushed out so the very next
  // request cannot trigger the period reset and erase the grant.
  const write = writes.at(-1);
  assert.deepEqual(write.verificationCredits, { increment: 5000 });
  assert.ok(write.verificationCreditsResetAt instanceof Date);
  assert.ok(write.verificationCreditsResetAt.getTime() > Date.now(), 'reset must be in the future');
});

test('the grant endpoint refuses unauthenticated and malformed requests', async (t) => {
  const { post } = await serve(t);

  assert.equal((await post({ workspaceId: WORKSPACE_ID, tier: 'PRO', note: 'x' }, 'wrong-secret')).status, 403);
  for (const body of [
    { tier: 'PRO', note: 'no workspace' },
    { workspaceId: WORKSPACE_ID, tier: 'ENTERPRISE', note: 'bad tier' },
    { workspaceId: WORKSPACE_ID, tier: 'PRO' },
    { workspaceId: WORKSPACE_ID, tier: 'PRO', note: 'x' },
    { workspaceId: WORKSPACE_ID, tier: 'PRO', addVerificationCredits: 0, note: 'zero grant' },
    { workspaceId: WORKSPACE_ID, tier: 'PRO', addVerificationCredits: 1.5, note: 'fractional' },
    { workspaceId: WORKSPACE_ID, tier: 'PRO', addVerificationCredits: 99_999_999, note: 'too large' },
    { workspaceId: WORKSPACE_ID, tier: 'PRO', planTermMonths: -3, note: 'negative term' },
  ]) {
    const response = await post(body);
    assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(body)}, got ${response.status}`);
  }
});
