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
const SECOND_WORKSPACE_ID = 'ws-plan-grant-2';

async function serve(t: any) {
  const previous = process.env.ADMIN_SECRET;
  process.env.ADMIN_SECRET = ADMIN_SECRET;
  t.after(() => {
    if (previous === undefined) delete process.env.ADMIN_SECRET; else process.env.ADMIN_SECRET = previous;
  });

  const rows: any[] = [
    {
      id: WORKSPACE_ID, name: 'Acme', tier: 'FREE',
      verificationCredits: 100, verificationCreditsMonthly: 100,
      verificationCreditsUnlimited: false,
      imageCredits: 5, imageCreditsMonthly: 5,
      imageCreditsUnlimited: false,
      paidUntil: null, planTermMonths: null,
    },
    {
      id: SECOND_WORKSPACE_ID, name: 'Beta', tier: 'FREE',
      verificationCredits: 0, verificationCreditsMonthly: 0,
      verificationCreditsUnlimited: false,
      imageCredits: 0, imageCreditsMonthly: 0,
      imageCreditsUnlimited: false,
      paidUntil: null, planTermMonths: null,
    },
  ];
  const writes: any[] = [];
  const originals: Array<() => void> = [];
  function replace(object: any, key: string, value: any) {
    const original = object[key];
    object[key] = value;
    originals.push(() => { object[key] = original; });
  }

  // The endpoint grants to a list of workspaces and reports per-workspace results,
  // so it uses updateMany rather than update: one unknown id must not roll back
  // the workspaces that do exist.
  const idsIn = (where: any): string[] | null => where?.id?.in ?? null;
  const matches = (row: any, where: any) => {
    const ids = idsIn(where);
    return ids ? ids.includes(row.id) : where?.id === row.id;
  };
  function apply(data: any) {
    if (data.verificationCredits?.increment) {
      for (const row of rows) row.verificationCredits += data.verificationCredits.increment;
    }
    if (data.imageCredits?.increment) {
      for (const row of rows) row.imageCredits += data.imageCredits.increment;
    }
    for (const row of rows) {
      for (const [key, value] of Object.entries(data)) {
        if (key === 'verificationCredits' || key === 'imageCredits') continue;
        row[key] = value;
      }
    }
  }

  replace(prisma.workspace, 'findMany', async ({ where }: any) => rows.filter(r => matches(r, where)).map(r => ({ ...r })));
  replace(prisma.workspace, 'updateMany', async ({ where, data }: any) => {
    writes.push(data);
    apply(data);
    return { count: rows.filter(r => matches(r, where)).length };
  });
  // Still used by the api-key credits endpoint.
  replace(prisma.workspace, 'update', async ({ where, data }: any) => {
    writes.push(data);
    apply(data);
    const row = rows.find(r => matches(r, where));
    return row ? { ...row } : null;
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
    rows,
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
  assert.equal(granted.body.workspaces[0].tier, 'BUSINESS');
  assert.ok(granted.body.workspaces[0].paidUntil, 'a term must set paidUntil for the auto-downgrade');

  // Credits are additive and the reset window is pushed out so the very next
  // request cannot trigger the period reset and erase the grant.
  const write = writes.at(-1);
  assert.deepEqual(write.verificationCredits, { increment: 5000 });
  assert.ok(write.verificationCreditsResetAt instanceof Date);
  assert.ok(write.verificationCreditsResetAt.getTime() > Date.now(), 'reset must be in the future');
});

test('an admin can grant unlimited credits to one workspace', async (t) => {
  const { post, rows } = await serve(t);

  const granted = await post({
    workspaceId: WORKSPACE_ID,
    unlimitedVerifications: true,
    unlimitedImages: true,
    note: 'own account, unlimited',
  });

  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  assert.equal(granted.body.granted, 1);

  const row = rows.find(r => r.id === WORKSPACE_ID)!;
  assert.equal(row.verificationCreditsUnlimited, true);
  assert.equal(row.imageCreditsUnlimited, true);
  // A grant is a flag, not a balance: the counters must be left alone so
  // nothing reads back a misleading "credits remaining".
  assert.equal(row.imageCredits, 5);
  assert.equal(row.verificationCredits, 100);
});

test('the same grant applies to several workspaces in one call', async (t) => {
  const { post, rows } = await serve(t);

  const granted = await post({
    workspaceIds: [WORKSPACE_ID, SECOND_WORKSPACE_ID, 'ws-does-not-exist'],
    unlimitedVerifications: true,
    unlimitedImages: true,
    note: 'batch unlimited',
  });

  // One unknown id must not roll back the two that exist, and must be named.
  assert.equal(granted.body.granted, 2, JSON.stringify(granted.body));
  assert.deepEqual(granted.body.missing, ['ws-does-not-exist']);
  assert.equal(granted.body.success, false, 'a partial grant must not report success');

  for (const id of [WORKSPACE_ID, SECOND_WORKSPACE_ID]) {
    const row = rows.find(r => r.id === id)!;
    assert.equal(row.imageCreditsUnlimited, true, `${id} must be unlimited`);
  }
});

test('unlimited can be revoked, and omitting it changes nothing', async (t) => {
  const { post, rows } = await serve(t);

  await post({ workspaceId: WORKSPACE_ID, unlimitedImages: true, note: 'grant' });
  assert.equal(rows[0].imageCreditsUnlimited, true);

  // Explicit false revokes...
  const revoked = await post({ workspaceId: WORKSPACE_ID, unlimitedImages: false, note: 'revoke' });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  assert.equal(rows[0].imageCreditsUnlimited, false);

  // ...and leaving it out must not silently revoke, since a plan-only grant
  // should not turn unlimited off by accident.
  await post({ workspaceId: WORKSPACE_ID, unlimitedImages: true, note: 'grant again' });
  await post({ workspaceId: WORKSPACE_ID, tier: 'PRO', note: 'tier change only' });
  assert.equal(rows[0].imageCreditsUnlimited, true, 'an unrelated grant must not revoke unlimited');
});

test('non-boolean unlimited values are rejected', async (t) => {
  const { post } = await serve(t);

  for (const body of [
    { workspaceId: WORKSPACE_ID, unlimitedImages: 'yes', note: 'string' },
    { workspaceId: WORKSPACE_ID, unlimitedVerifications: 1, note: 'number' },
  ]) {
    const response = await post(body);
    assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(body)}, got ${response.status}`);
  }
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
