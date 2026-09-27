// extractPaymentDetails used to return `{ account: null, amount: null }` for
// mpesa, awash and zemen — three of the eight providers this service verifies.
// Downstream, `accountMatches(null, ...)` failed *open*, so a payment to any
// recipient was treated as a payment to the merchant's own account. The amount
// parser also stripped no thousands separators, so parseFloat("1,234.56 Birr")
// returned 1 and every Telebirr payment over 999 ETB failed its amount check.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPaymentDetails,
  recipientMatches,
  accountMatches,
  normalisePhone,
} from '../utils/paymentMatch';

test('mpesa details are extracted instead of coming back empty', () => {
  const details = extractPaymentDetails(
    { amount: '1,500.00', receiverAccount: '251911000000' },
    'mpesa',
  );
  assert.equal(details.amount, 1500);
  assert.equal(details.account, '251911000000');
  assert.equal(details.accountNotReportedByProvider, false);
});

test('the m-pesa alias resolves to the same extractor', () => {
  const details = extractPaymentDetails({ amount: '250' }, 'm-pesa');
  assert.equal(details.amount, 250);
});

test('awash details are extracted instead of coming back empty', () => {
  const details = extractPaymentDetails(
    { amount: '299.00', beneficiaryAccount: '1000123456789' },
    'awash',
  );
  assert.equal(details.amount, 299);
  assert.equal(details.account, '1000123456789');
});

test('zemen details are extracted instead of coming back empty', () => {
  const details = extractPaymentDetails(
    { amount: 450, recipientAccount: '9999000011112222' },
    'zemen',
  );
  assert.equal(details.amount, 450);
  assert.equal(details.account, '9999000011112222');

  const viaTotal = extractPaymentDetails({ totalAmount: '450.00 ETB' }, 'zemen');
  assert.equal(viaTotal.amount, 450);
});

test('only dashen is declared as reporting no credited account', () => {
  const dashen = extractPaymentDetails({ transactionAmount: '300' }, 'dashen');
  assert.equal(dashen.account, null);
  assert.equal(dashen.accountNotReportedByProvider, true);

  // Telebirr does report one, so an empty extraction must not masquerade as
  // "this provider has no such field" — that is the fail-open that let a buyer
  // pay any account they liked.
  const telebirr = extractPaymentDetails({ settledAmount: '300' }, 'telebirr');
  assert.equal(telebirr.account, null);
  assert.equal(telebirr.accountNotReportedByProvider, false);
});

test('thousands separators do not truncate the amount to its first group', () => {
  const details = extractPaymentDetails({ settledAmount: '1,234.56 Birr' }, 'telebirr');
  assert.equal(details.amount, 1234.56);
  assert.notEqual(details.amount, 1, 'parseFloat("1,234.56 Birr") === 1 was the bug');
});

test('recipientMatches fails closed on a differing account', () => {
  assert.equal(
    recipientMatches('awash', { account: '1000999988887', accountNotReportedByProvider: false }, '1000123456789'),
    false,
  );
  assert.equal(
    recipientMatches('awash', { account: '1000123456789', accountNotReportedByProvider: false }, '1000123456789'),
    true,
  );
});

test('recipientMatches passes only when the provider genuinely reports no account', () => {
  assert.equal(
    recipientMatches('dashen', { account: null, accountNotReportedByProvider: true }, '1000123456789'),
    true,
  );
  // An account that is present and wrong is still wrong.
  assert.equal(
    recipientMatches('telebirr', { account: '1', accountNotReportedByProvider: false }, '1000123456789'),
    false,
  );
  // And a missing account that is NOT flagged as unreported fails closed.
  assert.equal(
    recipientMatches('telebirr', { account: null, accountNotReportedByProvider: false }, '1000123456789'),
    false,
  );
});

test('CBE receipts match through the masking rule, not an exact string compare', () => {
  // CBE prints a masked account, so `===` against the merchant's full number can
  // never succeed — which is why /admin/verify-payment rejected real CBE payments
  // while /payment-links/:id/confirm, which special-cased CBE, accepted them.
  const masked = extractPaymentDetails({ amount: '500', receiverAccount: '1000*****6789' }, 'cbe');
  assert.equal(recipientMatches('cbe', masked, '1000123456789'), true);
  assert.equal(recipientMatches('awash', masked, '1000123456789'), false, 'other providers use the strict matcher');
});

test('accountMatches treats a null account as a refusal, never a pass', () => {
  assert.equal(accountMatches(null, '1000123456789'), false);
  assert.equal(accountMatches('', '1000123456789'), false);
  assert.equal(accountMatches('1000123456789', ''), false);
});

test('phone recipients match across the 09/251 conventions and masked forms', () => {
  assert.equal(accountMatches('0911000000', '251911000000'), true);
  assert.equal(accountMatches('2519***0000', '251911000000'), true);
  assert.equal(accountMatches('2519***1111', '251911000000'), false);
  assert.equal(normalisePhone('0911223344'), '251911223344');
});
