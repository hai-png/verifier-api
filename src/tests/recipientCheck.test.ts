// The OCR receipt path is the one place where "verified" used to mean only "we
// read some text off a picture". Twenty-one providers have no public API, so the
// image was the verification, and the response carried a note telling the caller
// to check the payer themselves — a warning label, not a control.
//
// Supplying a payout account makes that check enforceable. The cases below are
// the ones that would each be a way to cash a receipt that is not yours:
//
//   - a receipt naming a different account            -> RECIPIENT_MISMATCH
//   - an account number Mistral failed to read         -> RECIPIENT_UNREADABLE
//   - a payout account that cannot receive the provider -> PROVIDER_NOT_ALLOWED
//
// The unreadable case is the subtle one. accountMatches() deliberately returns
// true for a null verified account, because a provider that omits the field
// (Dashen) is not evidence of a mismatch. In OCR that reasoning inverts: a
// missing field means the number was never read, not that nothing was wrong, so
// this module never inherits the skip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkReceiptRecipient, payoutAccountAllowsProvider } from '../utils/recipientCheck';

test('a receipt naming another account is rejected', () => {
  const result = checkReceiptRecipient({ foundAccount: '9999999999', expectedAccount: '0911223344' });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'RECIPIENT_MISMATCH');
  assert.equal(result.foundAccount, '9999999999');
  assert.equal(result.expectedAccount, '0911223344');
});

test('an account OCR could not read is rejected, not waved through', () => {
  // This is the regression that matters: accountMatches() returns true here.
  for (const found of [null, undefined, '', '   ']) {
    const result = checkReceiptRecipient({ foundAccount: found, expectedAccount: '0911223344' });

    assert.equal(result.ok, false, `found=${JSON.stringify(found)} must not pass`);
    assert.equal(result.reason, 'RECIPIENT_UNREADABLE');
    assert.equal(result.foundAccount, null);
  }
});

test('a matching account passes', () => {
  assert.equal(checkReceiptRecipient({ foundAccount: '0911223344', expectedAccount: '0911223344' }).ok, true);
});

test('phone numbers match across the forms a receipt prints them in', () => {
  const expected = '251911223344';
  // Local format, canonical format, and the masked form Telebirr returns
  // (payerTelebirrNo arrives as "2519****8453").
  assert.equal(checkReceiptRecipient({ foundAccount: '0911223344', expectedAccount: expected }).ok, true);
  assert.equal(checkReceiptRecipient({ foundAccount: '251911223344', expectedAccount: expected }).ok, true);
  assert.equal(checkReceiptRecipient({ foundAccount: '2519****3344', expectedAccount: expected }).ok, true);
});

test('a masked number is only accepted when prefix and suffix both line up', () => {
  // The masked branch of accountMatches() matches on 251 + one digit + the
  // trailing four, so the shared digits in the middle are not compared. Both
  // ends must agree or the receipt belongs to someone else.
  const ok = checkReceiptRecipient({ foundAccount: '2519****3344', expectedAccount: '251911223344' });
  assert.equal(ok.ok, true);

  for (const found of ['2519****3345', '2511****3344', '2518****3344']) {
    const result = checkReceiptRecipient({ foundAccount: found, expectedAccount: '251911223344' });
    assert.equal(result.ok, false, `${found} must not match`);
    assert.equal(result.reason, 'RECIPIENT_MISMATCH');
  }
});

test('CBE accounts are compared as a mask, first character plus last four', () => {
  // Documented rather than assumed: cbeAccountMatches() canonicalises both sides
  // to "<first>***<last4>". It does not compare leading zeros, so '00001…' and
  // '1…' are different accounts as far as this matcher is concerned.
  assert.equal(
    checkReceiptRecipient({ foundAccount: '1000123456789', expectedAccount: '1000123456789', useCbeAccountRule: true }).ok,
    true,
  );
  assert.equal(
    checkReceiptRecipient({ foundAccount: '1000123456789', expectedAccount: '1000123456788', useCbeAccountRule: true }).ok,
    false,
  );

  // Different leading character, same trailing four: still a different account.
  assert.equal(
    checkReceiptRecipient({ foundAccount: '2000123456789', expectedAccount: '1000123456789', useCbeAccountRule: true }).ok,
    false,
  );
});

test('without the CBE rule the comparison is exact, which is strictly stricter', () => {
  // Proves the flag is actually threaded through: this pair matches under the
  // mask rule only when the masks agree, and here the full strings differ.
  assert.equal(
    checkReceiptRecipient({ foundAccount: '0000123456789', expectedAccount: '123456789' }).ok,
    false,
  );
});

test('providersAllowed is read defensively, because it is a Json column', () => {
  assert.equal(payoutAccountAllowsProvider(['telebirr', 'mpesa'], 'telebirr'), true);
  assert.equal(payoutAccountAllowsProvider(['Telebirr'], 'telebirr'), true, 'case must not matter');
  assert.equal(payoutAccountAllowsProvider(['telebirr'], 'dashen'), false);

  // Anything that is not a string array is "no", never a crash and never a yes.
  for (const junk of [null, undefined, 'telebirr', 42, {}, [['telebirr']]]) {
    assert.equal(payoutAccountAllowsProvider(junk, 'telebirr'), false, `junk=${JSON.stringify(junk)}`);
  }
});