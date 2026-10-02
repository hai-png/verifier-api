// Two things the recipient check cannot do for itself.
//
// AMOUNT: knowing who was paid says nothing about how much. A receipt for 100
// into the right account satisfies a recipient check exactly as well as 5,000.
//
// REPLAY: a receipt that has already been used arrives looking identical — same
// payer, same receiver, same amount. Neither check can tell it from a
// legitimate second look-up, so it is recorded and reported rather than refused:
// support re-checking after a customer query must not start failing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../utils/prisma';
import { checkAmount, noteSuccessfulVerification } from '../utils/verificationGuards';

const telebirr = (settledAmount: string) => ({
  success: true,
  data: { settledAmount, creditedPartyAccountNo: '251906422230' },
});

// ─── Amount ──────────────────────────────────────────────────────────────────

test('a matching amount is confirmed and reported', () => {
  // Telebirr returns "200 Birr" as a string; the parser has to cope with both
  // the currency and the decimal.
  const result = checkAmount({ result: telebirr('200 Birr'), expectedAmount: 200, provider: 'telebirr' });

  assert.equal(result.ok, true);
  assert.equal(result.checked, true);
  assert.equal(result.foundAmount, 200);
});

test('a wrong amount is refused and says both figures', () => {
  const result = checkAmount({ result: telebirr('100 Birr'), expectedAmount: 200, provider: 'telebirr' });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'AMOUNT_MISMATCH');
  assert.equal(result.expectedAmount, 200);
  assert.equal(result.foundAmount, 100);
  assert.match(result.error!, /100/);
});

test('decimal noise does not fail a whole-birr amount', () => {
  const result = checkAmount({ result: telebirr('200.00'), expectedAmount: 200, provider: 'telebirr' });
  assert.equal(result.ok, true);
});

test('no expected amount means no check, and says so', () => {
  // Deliberately not a pass: a caller who asked for nothing gets checked:false,
  // so a silent verification is never mistaken for a verified amount.
  for (const expected of [undefined, null, 0, '', 'abc', NaN]) {
    const result = checkAmount({ result: telebirr('100 Birr'), expectedAmount: expected, provider: 'telebirr' });
    assert.equal(result.checked, false, `expected=${JSON.stringify(expected)}`);
    assert.equal(result.ok, true);
  }
});

test('a provider that reports no amount is not treated as a match', () => {
  // M-Pesa, Awash and Zemen land here. "We cannot see how much" is not evidence
  // that the right amount arrived.
  const result = checkAmount({
    result: { success: true, data: { transactionId: 'X1' } },
    expectedAmount: 200,
    provider: 'mpesa',
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'AMOUNT_NOT_VERIFIABLE');
  assert.equal(result.foundAmount, null);
});

test('a failed verification is not amount-checked', () => {
  const result = checkAmount({
    result: { success: false, error: 'Receipt not found.' },
    expectedAmount: 200,
    provider: 'telebirr',
  });

  assert.equal(result.checked, false);
  assert.equal(result.ok, true);
});

test('each provider amount field is read', () => {
  const cases: Array<[string, Record<string, unknown>, number]> = [
    ['telebirr', { settledAmount: '200 Birr' }, 200],
    ['cbe', { amount: 250 }, 250],
    ['dashen', { transactionAmount: 300 }, 300],
    ['abyssinia', { amount: 150 }, 150],
    ['cbebirr', { paidAmount: '199.50' }, 199.5],
  ];
  for (const [provider, data, expected] of cases) {
    const result = checkAmount({ result: { success: true, data }, expectedAmount: expected, provider });
    assert.equal(result.ok, true, `${provider} should read ${expected}`);
    assert.equal(result.foundAmount, expected);
  }
});

// ─── Replay ──────────────────────────────────────────────────────────────────

function mockReplayStore(t: any) {
  const rows: any[] = [];
  const originals: Array<() => void> = [];
  const replace = (key: string, value: any) => {
    const original = (prisma.verifiedTransaction as any)[key];
    (prisma.verifiedTransaction as any)[key] = value;
    originals.push(() => { (prisma.verifiedTransaction as any)[key] = original; });
  };
  replace('findUnique', async ({ where }: any) => {
    const { workspaceId, provider, reference } = where.workspaceId_provider_reference;
    const row = rows.find(r => r.workspaceId === workspaceId && r.provider === provider && r.reference === reference);
    return row ? { ...row } : null;
  });
  replace('create', async ({ data }: any) => {
    const row = { id: `row-${rows.length + 1}`, firstSeenAt: new Date(), lastSeenAt: new Date(), seenCount: 1, ...data };
    rows.push(row);
    return { ...row };
  });
  replace('update', async ({ where, data }: any) => {
    const { workspaceId, provider, reference } = where.workspaceId_provider_reference;
    const row = rows.find(r => r.workspaceId === workspaceId && r.provider === provider && r.reference === reference);
    row.seenCount += data.seenCount?.increment ?? 0;
    row.lastSeenAt = data.lastSeenAt;
    return { ...row };
  });
  t.after(() => originals.reverse().forEach(r => r()));
  return rows;
}

test('the first sighting is not a replay', async (t) => {
  mockReplayStore(t);
  const info = await noteSuccessfulVerification({
    workspaceId: 'ws-1', provider: 'telebirr', reference: 'DI10CLDXTM', amount: 200,
  });

  assert.equal(info.replayed, false);
  assert.equal(info.seenCount, 1);
});

test('showing the same receipt again is flagged, with when it was first seen', async (t) => {
  mockReplayStore(t);
  await noteSuccessfulVerification({ workspaceId: 'ws-1', provider: 'telebirr', reference: 'DI10CLDXTM', amount: 200 });

  const second = await noteSuccessfulVerification({
    workspaceId: 'ws-1', provider: 'telebirr', reference: 'DI10CLDXTM', amount: 200,
  });

  assert.equal(second.replayed, true, 'a used receipt must be recognisable');
  assert.ok(second.firstSeenAt instanceof Date);
  assert.equal(second.seenCount, 2);
});

test('the flag is per workspace, per provider and per reference', async (t) => {
  mockReplayStore(t);
  await noteSuccessfulVerification({ workspaceId: 'ws-1', provider: 'telebirr', reference: 'DI1' });

  // Same reference, different tenant.
  assert.equal((await noteSuccessfulVerification({ workspaceId: 'ws-2', provider: 'telebirr', reference: 'DI1' })).replayed, false);
  // Same tenant, different provider.
  assert.equal((await noteSuccessfulVerification({ workspaceId: 'ws-1', provider: 'dashen', reference: 'DI1' })).replayed, false);
  // Same tenant and provider, different receipt.
  assert.equal((await noteSuccessfulVerification({ workspaceId: 'ws-1', provider: 'telebirr', reference: 'DI2' })).replayed, false);
  // The original again is still a replay.
  assert.equal((await noteSuccessfulVerification({ workspaceId: 'ws-1', provider: 'telebirr', reference: 'DI1' })).replayed, true);
});

test('an anonymous verification records nothing', async (t) => {
  const rows = mockReplayStore(t);
  // The public route has no workspace, so there is nothing to attribute the
  // sighting to and nothing to compare against later.
  const info = await noteSuccessfulVerification({ workspaceId: undefined, provider: 'telebirr', reference: 'DI1' });

  assert.equal(info.replayed, false);
  assert.equal(rows.length, 0);
});

test('a database failure degrades to no flag rather than failing the request', async (t) => {
  const originals: Array<() => void> = [];
  const original = prisma.verifiedTransaction.findUnique;
  (prisma.verifiedTransaction as any).findUnique = async () => { throw new Error('database down'); };
  originals.push(() => { (prisma.verifiedTransaction as any).findUnique = original; });
  t.after(() => originals.forEach(r => r()));

  // A replay flag is a diagnostic. Turning a valid verification into a 500
  // because the bookkeeping table is unavailable would be a bad trade.
  const info = await noteSuccessfulVerification({ workspaceId: 'ws-1', provider: 'telebirr', reference: 'DI1' });
  assert.equal(info.replayed, false);
});
