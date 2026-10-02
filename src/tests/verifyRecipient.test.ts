// The recipient check on ordinary reference verification.
//
// Two properties here are easy to get wrong and expensive to get wrong later:
//
//   - it runs AFTER the result cache, so a receipt already verified for one
//     customer can be re-checked against another payout account without a second
//     call to the provider, and the cache is not fragmented per account;
//   - an id from another workspace is treated as absent, not honoured, so an
//     attacker cannot point a key at someone else's account or use the response
//     to discover whether an id exists.
//
// A mismatch is deliberately not an error. The provider did confirm the receipt,
// so the answer stays 200 with verified:false and a reason; turning it into a 422
// would change the status of a request whose lookup actually succeeded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../utils/prisma';
import { applyRecipientCheck, resolveRecipientPayoutAccount } from '../utils/verifyRecipient';

const WORKSPACE_ID = 'ws-recipient';

function mockPrisma(t: any, state: {
  payoutAccounts: any[];
  keys: any[];
}) {
  const originals: Array<() => void> = [];
  const replace = (model: any, key: string, value: any) => {
    const original = model[key];
    model[key] = value;
    originals.push(() => { model[key] = original; });
  };

  replace(prisma.payoutAccount, 'findFirst', async ({ where }: any) => {
    return state.payoutAccounts.find(a => a.id === where.id && a.workspaceId === where.workspaceId && a.active) ?? null;
  });
  replace(prisma.apiKey, 'findFirst', async ({ where }: any) => {
    return state.keys.find(k => k.id === where.id && k.workspaceId === where.workspaceId) ?? null;
  });
  t.after(() => originals.reverse().forEach(r => r()));
}

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pay-1',
    workspaceId: WORKSPACE_ID,
    label: 'Main',
    account: '5155104739011',
    accountHolderName: 'CRRSA AKAKI KALITY WOREDA 07',
    providersAllowed: ['telebirr', 'dashen', 'cbe'],
    active: true,
    ...overrides,
  };
}

function request(opts: { workspaceId?: string | null; apiKeyId?: string | null } = {}) {
  const req: any = { headers: {} };
  if (opts.workspaceId !== null) {
    req.workspaceContext = { workspace: { id: opts.workspaceId ?? WORKSPACE_ID }, source: 'api_key' };
  }
  if (opts.apiKeyId) req.apiKeyData = { id: opts.apiKeyId };
  return req;
}

// ─── Resolution order and tenant isolation ───────────────────────────────────

test('a request id wins over the key bound default', async (t) => {
  const bound = account({ id: 'pay-bound', account: '0911223344', providersAllowed: ['telebirr'] });
  const perRequest = account({ id: 'pay-request' });
  mockPrisma(t, { payoutAccounts: [bound, perRequest], keys: [{ id: 'key-1', workspaceId: WORKSPACE_ID, defaultPayoutAccountId: 'pay-bound' }] });

  const resolved = await resolveRecipientPayoutAccount(request({ apiKeyId: 'key-1' }), 'pay-request');
  assert.equal(resolved?.id, 'pay-request');
});

test('with no request id the key bound account is used', async (t) => {
  mockPrisma(t, {
    payoutAccounts: [account({ id: 'pay-bound' })],
    keys: [{ id: 'key-1', workspaceId: WORKSPACE_ID, defaultPayoutAccountId: 'pay-bound' }],
  });

  const resolved = await resolveRecipientPayoutAccount(request({ apiKeyId: 'key-1' }), undefined);
  assert.equal(resolved?.id, 'pay-bound');
});

test("another workspace's account id is ignored, not honoured", async (t) => {
  // The id exists, in a different workspace. Honouring it would check this
  // tenant's receipts against another tenant's account.
  const foreign = account({ id: 'pay-foreign', workspaceId: 'ws-someone-else' });
  mockPrisma(t, { payoutAccounts: [foreign], keys: [{ id: 'key-1', workspaceId: WORKSPACE_ID, defaultPayoutAccountId: null }] });

  const resolved = await resolveRecipientPayoutAccount(request({ apiKeyId: 'key-1' }), 'pay-foreign');
  assert.equal(resolved, null, 'a cross-tenant id must resolve to nothing');
});

test('an inactive account is not used even if it is the key default', async (t) => {
  mockPrisma(t, {
    payoutAccounts: [account({ id: 'pay-old', active: false })],
    keys: [{ id: 'key-1', workspaceId: WORKSPACE_ID, defaultPayoutAccountId: 'pay-old' }],
  });

  const resolved = await resolveRecipientPayoutAccount(request({ apiKeyId: 'key-1' }), undefined);
  assert.equal(resolved, null);
});

test('a dashboard session with no request id checks nothing', async (t) => {
  mockPrisma(t, { payoutAccounts: [], keys: [] });
  const resolved = await resolveRecipientPayoutAccount(request(), undefined);
  assert.equal(resolved, null);
});

test('the public route has no workspace and therefore no check', async (t) => {
  mockPrisma(t, { payoutAccounts: [account()], keys: [] });
  const resolved = await resolveRecipientPayoutAccount(request({ workspaceId: null }), 'pay-1');
  assert.equal(resolved, null);
});

// ─── Applying the check to provider results ──────────────────────────────────

test('a matching credited account verifies and reports what it checked', () => {
  const outcome = applyRecipientCheck({
    result: { success: true, data: { creditedPartyAccountNo: '5155104739011' }, provider: 'TELEBIRR' },
    payoutAccount: account(),
    provider: 'TELEBIRR',
  });

  assert.equal(outcome.checked, true);
  assert.equal(outcome.result.success, true);
  assert.equal(outcome.result.recipientChecked, true);
  assert.equal(outcome.result.matchedOn, 'account');
  assert.equal(outcome.result.amountChecked, false, 'the amount is never checked and must say so');
});

test('a receipt paid elsewhere is verified:false with a reason, not an error', () => {
  const outcome = applyRecipientCheck({
    result: { success: true, data: { creditedPartyAccountNo: '9999999999' }, provider: 'TELEBIRR' },
    payoutAccount: account(),
    provider: 'TELEBIRR',
  });

  assert.equal(outcome.checked, true);
  assert.equal(outcome.result.success, false);
  assert.equal(outcome.result.verified, false);
  assert.equal(outcome.result.reason, 'RECIPIENT_MISMATCH');
  assert.equal(outcome.result.expectedAccount, '5155104739011');
  // The provider data survives so an operator can adjudicate.
  assert.ok(outcome.result.data, 'the provider data must remain for review');
});

test('Dashen has no account, so the receiver name decides', () => {
  const dashen = account({ providersAllowed: ['dashen'], accountHolderName: 'CRRSA AKAKI KALITY WOREDA 07' });

  const ok = applyRecipientCheck({
    result: { success: true, data: { receiverName: 'CRRSA Akaki Kality Woreda 07', transactionAmount: 200 }, provider: 'DASHEN' },
    payoutAccount: dashen,
    provider: 'DASHEN',
  });
  assert.equal(ok.result.success, true);
  assert.equal(ok.result.matchedOn, 'receiverName');

  const bad = applyRecipientCheck({
    result: { success: true, data: { receiverName: 'SOMEONE ELSE PLC', transactionAmount: 200 }, provider: 'DASHEN' },
    payoutAccount: dashen,
    provider: 'DASHEN',
  });
  assert.equal(bad.result.success, false);
  assert.equal(bad.result.reason, 'RECIPIENT_MISMATCH');
});

test('a provider with neither an account nor a name is not verifiable', () => {
  const outcome = applyRecipientCheck({
    result: { success: true, data: { transactionAmount: 200 }, provider: 'AWASH' },
    payoutAccount: account({ providersAllowed: ['awash'] }),
    provider: 'AWASH',
  });

  assert.equal(outcome.result.success, false);
  assert.equal(outcome.result.reason, 'RECIPIENT_NOT_VERIFIABLE');
});

test('an account that cannot receive the provider is refused before any comparison', () => {
  const outcome = applyRecipientCheck({
    result: { success: true, data: { creditedPartyAccountNo: '5155104739011' }, provider: 'CBE' },
    payoutAccount: account({ providersAllowed: ['telebirr'] }),
    provider: 'CBE',
  });

  assert.equal(outcome.result.success, false);
  assert.equal(outcome.result.reason, 'PROVIDER_NOT_ALLOWED');
});

test('CBE Birr is spelled cbebirr in the payout vocabulary', () => {
  const outcome = applyRecipientCheck({
    result: { success: true, data: { creditAccount: '5155104739011' }, provider: 'CBE_BIRR' },
    payoutAccount: account({ providersAllowed: ['cbebirr'] }),
    provider: 'CBE_BIRR',
  });

  assert.equal(outcome.result.success, true, 'the vocabulary difference must not read as not-allowed');
});

test('a failed provider verification is left alone', () => {
  // Nothing was confirmed, so there is no recipient to disagree with.
  const original = { success: false, error: 'Receipt not found.', httpStatus: 404 };
  const outcome = applyRecipientCheck({ result: original, payoutAccount: account(), provider: 'TELEBIRR' });

  assert.equal(outcome.checked, false);
  assert.deepEqual(outcome.result, original);
});

test('no payout account means no check and no extra fields', () => {
  const original = { success: true, data: { creditedPartyAccountNo: '9999999999' }, provider: 'TELEBIRR' };
  const outcome = applyRecipientCheck({ result: original, payoutAccount: null, provider: 'TELEBIRR' });

  assert.equal(outcome.checked, false);
  assert.deepEqual(outcome.result, original, 'an unrelated receipt must still verify when nothing is bound');
});

test('the result is not mutated in place', () => {
  // The pipeline also stores the result in res.locals for webhooks; mutating it
  // would make a failed recipient check look like a failed verification there.
  const original = { success: true, data: { creditedPartyAccountNo: '9999999999' }, provider: 'TELEBIRR' };
  applyRecipientCheck({ result: original, payoutAccount: account(), provider: 'TELEBIRR' });

  assert.equal(original.success, true, 'the input object must be untouched');
});