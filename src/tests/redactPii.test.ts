// The provider adapters logged the receipt verbatim at INFO: the full extracted
// PDF text, the parsed record with the payer's name and phone, the raw OCR output
// of an uploaded screenshot. Winston writes those to files and to whatever
// shipper is attached, which turned the log directory into an unencrypted copy
// of customer banking data with none of the access controls the database has.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  maskDigits,
  maskEmail,
  maskName,
  receiptTextDigest,
  redactReceiptRecord,
} from '../utils/redactPii';

test('names are masked but stay recognisable enough to spot a bad parse', () => {
  assert.equal(maskName('Abel Tesfaye'), 'A*** T******');
  assert.equal(maskName('  abel   tesfaye  '), 'A*** T******');
  assert.equal(maskName('Li'), 'L**');
  assert.ok(!maskName('Abel Tesfaye').includes('bel'), 'the masked form must not contain the original');
});

test('digits are masked keeping only the carrier prefix and last two', () => {
  const masked = maskDigits('251911223344');
  assert.ok(masked.startsWith('2519'));
  assert.ok(masked.endsWith('44'));
  assert.ok(!masked.includes('112233'), 'the middle of the number must not survive');
  assert.ok(masked.includes('*'));
  // Too short to mask meaningfully → all stars, never the value.
  assert.equal(maskDigits('12345'), '*****');
});

test('emails keep the domain but not the local part', () => {
  const masked = maskEmail('abel.tesfaye@example.com');
  assert.ok(masked.endsWith('@example.com'));
  assert.ok(!masked.includes('abel.tesfaye'));
});

test('a parsed receipt keeps its amounts and references and loses its PII', () => {
  const redacted = redactReceiptRecord({
    success: true,
    receiptNumber: 'ABC1234567',
    amount: 1299,
    paidAmount: '1299.00',
    serviceCharge: 12.5,
    transactionDate: '2026-09-27',
    paymentChannel: 'CBE Birr',
    customerName: 'Abel Tesfaye',
    payerPhone: '251911223344',
    payerEmail: 'abel@example.com',
    payerAccount: '1000123456789',
    creditAccount: '1000999988887',
  }) as Record<string, any>;

  // Everything an operator needs to diagnose a verification stays.
  assert.equal(redacted.success, true);
  assert.equal(redacted.receiptNumber, 'ABC1234567');
  assert.equal(redacted.amount, 1299);
  assert.equal(redacted.paidAmount, '1299.00');
  assert.equal(redacted.transactionDate, '2026-09-27');

  // Everything that identifies a person does not.
  assert.ok(!JSON.stringify(redacted).includes('Abel Tesfaye'));
  assert.ok(!JSON.stringify(redacted).includes('251911223344'));
  assert.ok(!JSON.stringify(redacted).includes('abel@example.com'));
  assert.ok(!JSON.stringify(redacted).includes('1000123456789'));
  assert.equal(redacted.customerName, 'A*** T******');
});

test('a key nobody anticipated is dropped rather than passed through', () => {
  // Safe-listing, not deny-listing: an adapter that starts returning a field this
  // module has never heard of must not silently begin logging it.
  const redacted = redactReceiptRecord({
    amount: 10,
    internalNote: 'customer called twice about this',
    deviceId: 'a1b2c3d4',
  }) as Record<string, any>;
  assert.equal(redacted.amount, 10);
  assert.equal(redacted.internalNote, '[omitted]');
  assert.ok(!JSON.stringify(redacted).includes('customer called twice'));
});

test('a PII-looking key nobody anticipated is still masked, not passed through', () => {
  // `payerAddress` matches the name pattern, so it is masked. The point is that
  // the value never reaches the log in either case.
  const redacted = redactReceiptRecord({ payerAddress: 'Bole, Addis Ababa' }) as Record<string, any>;
  assert.ok(!JSON.stringify(redacted).includes('Bole'));
});

test('nested objects and arrays are redacted too', () => {
  const redacted = redactReceiptRecord({
    details: { receiverName: 'FitLife Hub PLC', amount: 500 },
    parties: [{ payerName: 'Abel Tesfaye' }, { payerName: 'Sara Kebede' }],
  }) as Record<string, any>;
  const serialised = JSON.stringify(redacted);
  assert.ok(!serialised.includes('Abel Tesfaye'));
  assert.ok(!serialised.includes('Sara Kebede'));
  assert.equal(redacted.details.amount, 500);
  assert.equal(Array.isArray(redacted.parties), true);
});

test('nulls and booleans survive untouched', () => {
  const redacted = redactReceiptRecord({
    customerName: null,
    payerPhone: undefined,
    success: false,
    amount: 0,
  }) as Record<string, any>;
  assert.equal(redacted.customerName, null);
  assert.equal(redacted.success, false);
  assert.equal(redacted.amount, 0);
});

test('the receipt digest carries no field values', () => {
  const text = [
    'COMMERCIAL BANK OF ETHIOPIA',
    'Receipt No: ABC1234567',
    'Date: 27/09/2026  Time: 14:03',
    'Customer Name: Abel Tesfaye',
    'Phone: 251911223344',
    'Amount: 1,299.00 ETB',
    'Total Paid: 1,311.50 ETB',
    'Payment Reason: Gym subscription',
  ].join('\n');

  const digest = receiptTextDigest(text);
  assert.equal(digest.characters, text.length);
  assert.equal(digest.lines, 8);
  assert.equal(digest.looksLikeHtml, false);
  assert.ok(digest.labelsPresent.includes('Receipt'));
  assert.ok(digest.labelsPresent.includes('Amount'));
  assert.ok(digest.labelsPresent.includes('Phone'));

  const serialised = JSON.stringify(digest);
  assert.ok(!serialised.includes('Abel Tesfaye'), 'the digest must not carry the payer name');
  assert.ok(!serialised.includes('251911223344'), 'the digest must not carry the phone number');
  assert.ok(!serialised.includes('1,299.00'), 'the digest must not carry the amount');
});

test('the digest identifies an HTML error page without echoing it', () => {
  const digest = receiptTextDigest('<!DOCTYPE html><html><body>Not Found</body></html>');
  assert.equal(digest.looksLikeHtml, true);
  assert.ok(digest.characters > 0);
  assert.ok(!JSON.stringify(digest).includes('Not Found'));
});

test('the digest handles empty and non-string input', () => {
  assert.equal(receiptTextDigest('').characters, 0);
  assert.deepEqual(receiptTextDigest('').labelsPresent, []);
  assert.equal(receiptTextDigest(undefined as any).characters, 0);
});
