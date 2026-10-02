// "Unlimited" as a big number in the credit columns would be wiped on the very
// next period reset: tierGate overwrites imageCredits with the plan allowance
// when imageCreditsResetAt passes, and an expired plan downgrades the workspace
// and does the same. So it is a boolean on the workspace, and these tests pin
// the two properties that a sentinel value cannot have — the gates are skipped
// outright, and the flag survives the reset that would erase a number.
import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../utils/prisma';
import { getSyncedPlanState, verifyImageGate, verifyQuotaGate } from '../middleware/tierGate';
import { invalidateBillingConfigCache } from '../config/billingConfig';

const PAST = new Date('2020-01-01T00:00:00Z');
const FUTURE = new Date('2099-01-01T00:00:00Z');

function fakeWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ws-unlimited', name: 'Test', tier: 'FREE', grandfathered: false,
    verificationCredits: 0, verificationCreditsMonthly: 0, verificationCreditsResetAt: FUTURE,
    paidUntil: null, planTermMonths: null,
    imageCredits: 0, imageCreditsMonthly: 0, imageCreditsResetAt: FUTURE,
    verificationCreditsUnlimited: false, imageCreditsUnlimited: false,
    ...overrides,
  };
}

function mockPrisma(t: any, workspace: Record<string, unknown>) {
  const originals: Array<() => void> = [];
  const replace = (key: string, value: any) => {
    const original = (prisma.workspace as any)[key];
    (prisma.workspace as any)[key] = value;
    originals.push(() => { (prisma.workspace as any)[key] = original; });
  };
  const replaceConfig = (key: string, value: any) => {
    const original = (prisma.planPricingConfig as any)[key];
    (prisma.planPricingConfig as any)[key] = value;
    originals.push(() => { (prisma.planPricingConfig as any)[key] = original; });
  };
  // getSyncedPlanState reads the plan limits through getBillingConfig, which
  // goes to the database. No database here, so answer it directly — with the
  // real field names. Guessing these produced NaN quotas that silently made the
  // gates pass, which is exactly the kind of false green worth guarding.
  replaceConfig('findUnique', async () => ({
    freeRateLimit: 20, proRateLimit: 60, businessRateLimit: 300,
    businessUnlimitedVerifications: false,
    freeQuotaNewMonthly: 100, freeQuotaLegacyMonthly: 250,
    proQuotaMonthly: 2000, businessQuotaMonthly: 50000,
    freeImageCredits: 0, proImageCredits: 100, businessImageCredits: 300,
    freeBatchMaxReferences: 0, proBatchMaxReferences: 20, businessBatchMaxReferences: 100,
  } as any));

  const applyData = (data: Record<string, any>) => {
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === 'object') {
        const delta = value as { increment?: number; decrement?: number };
        if (typeof delta.increment === 'number') {
          workspace[key] = (workspace[key] as number) + delta.increment;
          continue;
        }
        if (typeof delta.decrement === 'number') {
          workspace[key] = (workspace[key] as number) - delta.decrement;
          continue;
        }
      }
      workspace[key] = value;
    }
  };

  replace('findFirst', async () => ({ ...workspace }));
  replace('findUnique', async () => ({ ...workspace }));
  replace('findMany', async () => [{ ...workspace }]);
  replace('update', async ({ data }: any) => { applyData(data); return { ...workspace }; });
  replace('updateMany', async ({ data }: any) => { applyData(data); return { count: 1 }; });
  t.after(() => originals.reverse().forEach(restore => restore()));
}

function fakeRequest(workspace: Record<string, unknown>): any {
  return {
    body: {},
    query: {},
    path: '/verify-telebirr',
    baseUrl: '',
    method: 'POST',
    headers: {},
    workspaceContext: { workspace, source: 'dashboard' },
  };
}

function fakeResponse() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  return res;
}

// ─── The flags survive a period reset ────────────────────────────────────────

test('the monthly reset does not clear an unlimited grant', async (t) => {
  const workspace = fakeWorkspace({
    imageCreditsUnlimited: true,
    verificationCreditsUnlimited: true,
    // Both periods already expired, so getSyncedPlanState takes the reset branch
    // on both meters. Image credits reset to the FREE allowance of 0.
    imageCreditsResetAt: PAST,
    verificationCreditsResetAt: PAST,
  });
  mockPrisma(t, workspace);
  invalidateBillingConfigCache();

  const req = fakeRequest(workspace);
  await getSyncedPlanState(req);

  // The counters were reset to the FREE allowance (0 for images)...
  assert.equal(workspace.imageCredits, 0, 'the reset still runs');
  // ...and the grant is untouched, which a sentinel number could not survive.
  assert.equal(workspace.imageCreditsUnlimited, true);
  assert.equal(workspace.verificationCreditsUnlimited, true);
});

// ─── The gates are skipped, not merely satisfied ─────────────────────────────

test('a metered workspace with no credits is blocked at the image gate', async (t) => {
  const workspace = fakeWorkspace();
  mockPrisma(t, workspace);
  invalidateBillingConfigCache();

  const req = fakeRequest(workspace);
  const res = fakeResponse();
  await verifyImageGate(req, res, () => {});
  assert.equal(res.statusCode, 402, 'the ceiling check must still fire');
});

test('an image-unlimited workspace passes the gate with a zero balance', async (t) => {
  const workspace = fakeWorkspace({ imageCreditsUnlimited: true });
  mockPrisma(t, workspace);
  invalidateBillingConfigCache();

  const req = fakeRequest(workspace);
  const res = fakeResponse();
  let passed = false;
  await verifyImageGate(req, res, () => { passed = true; });

  assert.equal(passed, true, `expected the gate to pass, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body, undefined, 'no 402 body should have been written');
  assert.equal(req.resolvedAccount.imageCreditsUnlimited, true,
    'the handler must be able to see the flag so it can skip the decrement');
});

test('image-unlimited does not accidentally unblock verifications', async (t) => {
  const workspace = fakeWorkspace({ imageCreditsUnlimited: true });
  mockPrisma(t, workspace);
  invalidateBillingConfigCache();

  const req = fakeRequest(workspace);
  req.body = { reference: 'X' };
  const res = fakeResponse();
  await verifyQuotaGate(req, res, () => {});

  assert.equal(res.statusCode, 402, 'the two flags are independent');
});

test('a verification-unlimited workspace passes the quota gate with a zero balance', async (t) => {
  const workspace = fakeWorkspace({ verificationCreditsUnlimited: true });
  mockPrisma(t, workspace);
  invalidateBillingConfigCache();

  const req = fakeRequest(workspace);
  req.body = { reference: 'X' };
  const res = fakeResponse();
  let passed = false;
  await verifyQuotaGate(req, res, () => { passed = true; });

  assert.equal(passed, true, `expected the quota gate to pass, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
});

test('an unlimited quota is never decremented', async (t) => {
  const workspace = fakeWorkspace({ verificationCreditsUnlimited: true });
  mockPrisma(t, workspace);
  invalidateBillingConfigCache();

  const req = fakeRequest(workspace);
  req.body = { reference: 'X' };
  const before = workspace.verificationCredits;
  await verifyQuotaGate(req, fakeResponse(), () => {});

  assert.equal(workspace.verificationCredits, before,
    'skipping the gate must also skip the decrement, or the balance drains to nothing');
});