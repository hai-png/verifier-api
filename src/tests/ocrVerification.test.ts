// /verify-image answered `verified: true` for 21 of its 23 provider types on the
// strength of a vision model reading a picture. A picture can be made by anyone,
// so that response certified a payment that never happened, with the amount and
// the payer both chosen by whoever produced the image. Six of those types have a
// real provider adapter in this repo that was never called.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_OCR_TYPES,
  compareAgainstExpectations,
  namesEquivalent,
  normaliseAmount,
  ocrOnlyTypes,
  ocrTrustEnabled,
  phonesEquivalent,
  providerForOcrType,
} from '../utils/ocrVerification';

test('every provider type with a real adapter is routed to it', () => {
  for (const type of ['cbe-birr', 'dashen', 'abyssinia', 'awash', 'zemen', 'mpesa']) {
    const adapter = providerForOcrType(type);
    assert.ok(adapter, `${type} must map to an adapter — it has one in verifyUniversal`);
    assert.equal(typeof adapter.provider, 'string');
  }
  assert.equal(providerForOcrType('mpesa')?.provider, 'mpesa');
  assert.equal(providerForOcrType('cbe-birr')?.needsPhone, true);
  assert.equal(providerForOcrType('abyssinia')?.needsSuffix, true);
  assert.equal(providerForOcrType('awash')?.needsPhone, false);
});

test('provider types with no upstream API are exactly the OCR-only set', () => {
  const ocrOnly = ocrOnlyTypes();
  assert.ok(!ocrOnly.includes('mpesa'), 'mpesa has an adapter and must not be OCR-only');
  assert.ok(!ocrOnly.includes('awash'), 'awash has an adapter and must not be OCR-only');
  assert.ok(!ocrOnly.includes('zemen'));
  assert.ok(!ocrOnly.includes('dashen'));
  assert.ok(!ocrOnly.includes('abyssinia'));
  assert.ok(!ocrOnly.includes('cbe-birr'));
  // telebirr/cbe are handled by their own branches in the handler, not here.
  assert.ok(!ocrOnly.includes('telebirr'));
  assert.ok(!ocrOnly.includes('cbe'));
  // The genuinely API-less banks remain OCR-only.
  for (const type of ['coop-oromia', 'hijra', 'wegagen', 'sinqee', 'gadaa']) {
    assert.ok(ocrOnly.includes(type), `${type} has no adapter and must be OCR-only`);
  }
  // Nothing fell through the cracks: every recognised type is accounted for.
  assert.equal(
    ALL_OCR_TYPES.length,
    ocrOnly.length + 6 + 2,
    'every OCR type must be either adapter-backed, ocr-only, or one of telebirr/cbe',
  );
});

test('unknown types map to no adapter', () => {
  assert.equal(providerForOcrType('unknown'), undefined);
  assert.equal(providerForOcrType(''), undefined);
  assert.equal(providerForOcrType(undefined as any), undefined);
});

test('normaliseAmount reads amounts the way receipts print them', () => {
  assert.equal(normaliseAmount('1,234.56 Birr'), 1234.56);
  assert.equal(normaliseAmount('299'), 299);
  assert.equal(normaliseAmount(299.0), 299);
  assert.equal(normaliseAmount('ETB 450.00'), 450);
  assert.equal(normaliseAmount('unreadable'), null);
  assert.equal(normaliseAmount(undefined), null);
  assert.equal(normaliseAmount(Number.NaN), null);
});

test('an OCR-only receipt with no expectations supplied is not reported as satisfied', () => {
  const comparison = compareAgainstExpectations(
    { amount: '299.00', payer_name: 'Abel Tesfaye' },
    {},
  );
  assert.equal(comparison.expectationsProvided, false);
  assert.equal(comparison.satisfied, false, 'nothing was checked, so nothing matched');
  assert.equal(comparison.checks.amount, null);
  assert.equal(comparison.checks.payerName, null);
});

test('a receipt that matches the order expectations says so', () => {
  const comparison = compareAgainstExpectations(
    { amount: '1,299.00', payer_name: 'Abel Tesfaye', payer_phone: '251911223344' },
    { amount: 1299, payerName: 'abel tesfaye', payerPhone: '0911223344' },
  );
  assert.equal(comparison.expectationsProvided, true);
  assert.equal(comparison.satisfied, true);
  assert.deepEqual(comparison.checks, {
    amount: true,
    payerName: true,
    payerPhone: true,
    receiverName: null,
    receiverAccount: null,
    reference: null,
  });
});

test('a forged amount or payer fails the expectation check', () => {
  const wrongAmount = compareAgainstExpectations({ amount: '1.00' }, { amount: 1299 });
  assert.equal(wrongAmount.satisfied, false);
  assert.equal(wrongAmount.checks.amount, false);

  const wrongPayer = compareAgainstExpectations(
    { amount: 1299, payer_name: 'Someone Else' },
    { amount: 1299, payerName: 'Abel Tesfaye' },
  );
  assert.equal(wrongPayer.satisfied, false);
  assert.equal(wrongPayer.checks.amount, true);
  assert.equal(wrongPayer.checks.payerName, false);

  // One failing field must fail the whole comparison even if others pass.
  assert.equal(
    compareAgainstExpectations(
      { amount: 1299, payer_name: 'Abel Tesfaye' },
      { amount: 1299, payerName: 'Abel Tesfaye', receiverName: 'FitLife Hub' },
    ).satisfied,
    false,
  );
});

test('an illegible amount fails rather than passing by omission', () => {
  const comparison = compareAgainstExpectations({ amount: 'unreadable' }, { amount: 1299 });
  assert.equal(comparison.checks.amount, false);
  assert.equal(comparison.satisfied, false);
});

test('name comparison ignores order, case, punctuation and company suffixes', () => {
  assert.equal(namesEquivalent('Abel Tesfaye', 'tesfaye abel'), true);
  assert.equal(namesEquivalent('FitLife Hub PLC', 'fitlife hub'), true);
  assert.equal(namesEquivalent('Abel Tesfaye', 'Abel Bekele'), false);
  assert.equal(namesEquivalent('', ''), false, 'two empty names are not a match');
  assert.equal(namesEquivalent(undefined, 'Abel'), false);
});

test('phone comparison ignores the 0/251 prefix and formatting', () => {
  assert.equal(phonesEquivalent('0911223344', '+251 911 223 344'), true);
  assert.equal(phonesEquivalent('251911223344', '251911223344'), true);
  assert.equal(phonesEquivalent('0911223344', '0911223345'), false);
  assert.equal(phonesEquivalent('', ''), false, 'too short to be a phone number');
});

test('receiver account comparison accepts suffix forms but not a different account', () => {
  assert.equal(
    compareAgainstExpectations({ receiver_account: '1000123456789' }, { receiverAccount: '123456789' }).satisfied,
    true,
  );
  assert.equal(
    compareAgainstExpectations({ receiver_account: '1000999988887' }, { receiverAccount: '1000123456789' }).satisfied,
    false,
  );
});

test('the legacy verified:true shorthand is opt-in only', () => {
  assert.equal(ocrTrustEnabled({ query: {}, env: {} }), false, 'default must be off');
  assert.equal(ocrTrustEnabled({ query: { trustOcr: 'true' }, env: {} }), true);
  assert.equal(ocrTrustEnabled({ query: { trustOcr: 'TRUE' }, env: {} }), true);
  assert.equal(ocrTrustEnabled({ query: { trustOcr: 'yes' }, env: {} }), false);
  assert.equal(ocrTrustEnabled({ query: {}, env: { OCR_TRUST_IMAGES: 'true' } }), true);
  assert.equal(ocrTrustEnabled({ query: {}, env: { OCR_TRUST_IMAGES: 'false' } }), false);
});
