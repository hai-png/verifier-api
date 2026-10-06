import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveAmounts,
  resolveAmountBasis,
  resolveComparableAmount,
  describeAmountUnresolvable,
} from '../utils/amountBasis';
import { checkAmount } from '../utils/verificationGuards';

// The transaction this module was written for, taken from a live receipt:
// the payer was debited 801 Birr, itemised as service fee 3.48 + VAT 0.52, and
// 797 Birr reached the merchant's account. 801 - 4.00 = 797.
const TELEBIRR_RECEIPT = {
  settledAmount: '797.00 Birr',
  totalPaidAmount: '801.00 Birr',
  serviceFee: '3.48 Birr',
  creditedPartyAccountNo: '251906422230',
};

test('telebirr net comes from the provider-reported settled amount, not gross minus fee', () => {
  const r = resolveAmounts('telebirr', TELEBIRR_RECEIPT);
  assert.equal(r.source, 'providerNet');
  assert.equal(r.net, 797);
  assert.equal(r.gross, 801);
  assert.equal(r.fee, 3.48);
});

test('telebirr expectedAmount 797 passes and 801 fails under the net basis', () => {
  const { amount } = resolveComparableAmount('telebirr', TELEBIRR_RECEIPT, 'net');
  const ok = checkAmount({
    result: { success: true, data: TELEBIRR_RECEIPT },
    expectedAmount: 797,
    provider: 'telebirr',
    foundAmount: amount,
    basis: 'net',
  });
  assert.equal(ok.ok, true, 'the merchant received 797 and expects 797');
  assert.equal(ok.checked, true);

  const wrong = checkAmount({
    result: { success: true, data: TELEBIRR_RECEIPT },
    expectedAmount: 801,
    provider: 'telebirr',
    foundAmount: amount,
    basis: 'net',
  });
  assert.equal(wrong.ok, false, '801 is what the payer was charged, not what landed');
  assert.equal(wrong.reason, 'AMOUNT_MISMATCH');
  assert.equal(wrong.foundAmount, 797);
});

test('gross basis restores the pre-existing comparison', () => {
  const { amount } = resolveComparableAmount('telebirr', TELEBIRR_RECEIPT, 'gross');
  assert.equal(amount, 801);
  const r = checkAmount({
    result: { success: true, data: TELEBIRR_RECEIPT },
    expectedAmount: 801,
    provider: 'telebirr',
    foundAmount: amount,
    basis: 'gross',
  });
  assert.equal(r.ok, true);
});

test('a provider fee that is genuinely zero yields net === gross', () => {
  // The user reported that some transactions carry no fee. That is not an edge
  // case: it must produce the correct answer rather than a special case.
  const r = resolveAmounts('dashen', { transactionAmount: '500.00', serviceCharge: '0.00' });
  assert.equal(r.fee, 0);
  assert.equal(r.source, 'grossMinusFee');
  assert.equal(r.net, 500);
  assert.equal(r.gross, 500);
});

test('a changed fee rate needs no code change: it is read, never computed', () => {
  const before = resolveAmounts('mpesa', { amount: '1000.00', serviceFee: '5.00' });
  const after = resolveAmounts('mpesa', { amount: '1000.00', serviceFee: '2.50' });
  assert.equal(before.net, 995);
  assert.equal(after.net, 997.5);
});

test('a declared fee that is absent means zero, because that is how a fee-free receipt looks', () => {
  // verifyMpesa builds `serviceFee` from a regex match and leaves it undefined
  // when the receipt shows no service fee. Treating absence as an extraction
  // failure made every fee-free M-Pesa, Dashen and CBE-Birr payment
  // unverifiable — the exact case the user reported as normal.
  for (const provider of ['mpesa', 'dashen', 'cbe-birr', 'abyssinia']) {
    const field = provider === 'mpesa' ? 'serviceFee' : 'serviceCharge';
    const r = resolveAmounts(provider, { amount: '500.00' });
    assert.equal(r.feeAssumedZero, true, `${provider} treats an absent fee as zero`);
    assert.equal(r.net, 500, `${provider} net must equal gross when no fee was charged`);
  }
});

test('a fee that is present but unparseable fails closed instead of becoming zero', () => {
  // The distinction that matters: absent means "no fee was charged", garbage
  // means "we could not read it". Collapsing the two either rejects valid
  // payments or, in the other direction, silently overstates the net.
  for (const unreadable of ['n/a', 'not-a-number', '--']) {
    const r = resolveAmounts('mpesa', { amount: '1000.00', serviceFee: unreadable });
    assert.equal(r.feeDeclared, true, 'mpesa is known to report a fee');
    assert.equal(r.feeAssumedZero, false, `"${unreadable}" is not an absent fee`);
    assert.equal(r.source, 'unresolved');
    assert.equal(r.net, null, 'net must stay unknown rather than falling back to gross');
  }
});

test('an unparseable fee is reported as unverifiable, not as a missing amount', () => {
  const r = checkAmount({
    result: { success: true, data: { amount: '1000.00', serviceFee: 'garbage' } },
    expectedAmount: 995,
    provider: 'mpesa',
    basis: 'net',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'AMOUNT_NOT_VERIFIABLE');
  assert.ok(r.error);
  assert.match(r.error, /service fee could not be read/i);
});

test('cbe reports amountCredited, so its primary figure is already net', () => {
  // verifyCBE maps the provider's `amountCredited` onto `amount`. Treating that as
  // gross and subtracting a service charge would report less than was credited.
  const r = resolveAmounts('cbe', { amount: '250.00' });
  assert.equal(r.source, 'providerNet');
  assert.equal(r.net, 250);
  assert.equal(r.feeDeclared, false);
});

test('an unstudied provider is not assumed to charge a fee', () => {
  // The regression this guards: declaring a fee by default made every provider
  // without an entry fail closed, and CBE stopped verifying entirely.
  const r = resolveAmounts('some-new-bank', { amount: '250.00' });
  assert.equal(r.source, 'grossIsNet');
  assert.equal(r.net, 250);
});

test('an unstudied provider reporting a fee field is still read as gross-is-net', () => {
  // No audited entry means no declared fee, so a fee-shaped field is ignored
  // rather than silently changing the net for a provider nobody has studied.
  const r = resolveAmounts('some-new-bank', { amount: '42.00', serviceCharge: '1.00' });
  assert.equal(r.feeDeclared, false);
  assert.equal(r.net, 42);
});

test('a provider that charges no fee treats gross as net', () => {
  const r = resolveAmounts('awash', { amount: '750.00' });
  assert.equal(r.feeDeclared, false);
  assert.equal(r.source, 'grossIsNet');
  assert.equal(r.net, 750);
});

test('zemen leads with a settled figure already', () => {
  const r = resolveAmounts('zemen', { amount: '250.00', serviceCharge: '1.25' });
  assert.equal(r.source, 'providerNet');
  assert.equal(r.net, 250);
});

test('float residue in gross minus fee cannot fail the tolerance', () => {
  // 3.48 + 0.52 style arithmetic leaves residue that a 0.01 tolerance would
  // otherwise reject.
  const r = resolveAmounts('cbe-birr', { paidAmount: '100.10', serviceCharge: '0.10' });
  assert.equal(r.net, 100);
  const check = checkAmount({
    result: { success: true, data: { paidAmount: '100.10', serviceCharge: '0.10' } },
    expectedAmount: 100,
    provider: 'cbe-birr',
    basis: 'net',
  });
  assert.equal(check.ok, true);
});

test('amounts arriving as numbers and as numeric strings agree', () => {
  const asNumber = resolveAmounts('dashen', { transactionAmount: 500, serviceCharge: 5 });
  const asString = resolveAmounts('dashen', { transactionAmount: '500', serviceCharge: '5' });
  assert.equal(asNumber.net, 495);
  assert.equal(asString.net, 495);
});

test('basis defaults to net and honours an explicit gross override', () => {
  const previous = process.env.VERIFY_AMOUNT_BASIS;
  delete process.env.VERIFY_AMOUNT_BASIS;
  assert.equal(resolveAmountBasis(), 'net');
  process.env.VERIFY_AMOUNT_BASIS = 'gross';
  assert.equal(resolveAmountBasis(), 'gross');
  process.env.VERIFY_AMOUNT_BASIS = 'GROSS';
  assert.equal(resolveAmountBasis(), 'gross', 'the value is case-insensitive');
  process.env.VERIFY_AMOUNT_BASIS = 'anything-else';
  assert.equal(resolveAmountBasis(), 'net', 'an unrecognised value must not silently become gross');
  if (previous === undefined) delete process.env.VERIFY_AMOUNT_BASIS;
  else process.env.VERIFY_AMOUNT_BASIS = previous;
});

test('a provider with nothing usable resolves to null, never to zero', () => {
  const r = resolveAmounts('telebirr', {});
  assert.equal(r.net, null);
  assert.equal(r.gross, null);
  assert.equal(r.source, 'unresolved');
});

test('an unknown provider still resolves from the generic field set', () => {
  const r = resolveAmounts('some-new-bank', { settledAmount: '42.00' });
  assert.equal(r.gross, 42);
});

test('the unverifiable message names the provider', () => {
  const resolved = resolveAmounts('awash', {});
  assert.match(describeAmountUnresolvable(resolved, 'net'), /awash/);
});