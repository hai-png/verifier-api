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
import { prepareVerification } from '../services/verifyUniversal';
import {
  checkReceiptRecipient,
  maskedAccountMatches,
  payoutAccountAllowsProvider,
  receiverNameMatches,
} from '../utils/recipientCheck';

// ─── Optional-field shape ────────────────────────────────────────────────────
// A client building the body from nullable columns sends `suffix: null` for
// every provider that does not use one, and Telebirr was rejected for it with
// "suffix must be a string" — a complaint about a field the caller believed they
// had not sent. null means "not supplied" in JSON, so it is treated as absent.

test('null optional fields are treated as absent', () => {
  const result = prepareVerification({
    reference: 'DI10CLDXTM',
    suffix: null,
    phoneNumber: null,
    provider: null,
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.plan.provider, 'TELEBIRR');
    assert.equal(result.plan.suffix, undefined);
  }
});

test('a null reference is still rejected, as missing rather than mistyped', () => {
  // The required field must not slip through, but the message should point at
  // the field the caller actually has to fix.
  const result = prepareVerification({ reference: null });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.result.httpStatus, 400);
    assert.match(result.result.error!, /Missing or invalid reference/);
  }
});

test('a genuinely mistyped field names the type that arrived', () => {
  const result = prepareVerification({ reference: 'DI10CLDXTM', suffix: 123 });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.result.error!, /suffix must be a string \(received number\)/);
  }

  const array = prepareVerification({ reference: 'DI10CLDXTM', suffix: ['1'] });
  assert.equal(array.ok, false);
  if (!array.ok) assert.match(array.result.error!, /received array/);
});

test('conflicting aliases are still refused', () => {
  const result = prepareVerification({ reference: 'DI10CLDXTM', suffix: '111', accountSuffix: '222' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.result.error!, /Conflicting suffix aliases/);
});

test('a receipt naming another account is rejected', () => {
  const result = checkReceiptRecipient({ foundAccount: '9999999999', expectedAccount: '0911223344' });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'RECIPIENT_MISMATCH');
  assert.equal(result.foundAccount, '9999999999');
  assert.equal(result.expectedAccount, '0911223344');
  assert.equal(result.matchedOn, 'account');
});

test('with nothing to compare against the result is "not verifiable", never a pass', () => {
  // This is the regression that matters: accountMatches() returns true here. An
  // unreadable field and a provider that never printed one look identical from
  // the outside, so the answer says so rather than guessing which it was.
  for (const found of [null, undefined, '', '   ']) {
    const result = checkReceiptRecipient({ foundAccount: found, expectedAccount: '0911223344' });

    assert.equal(result.ok, false, `found=${JSON.stringify(found)} must not pass`);
    assert.equal(result.reason, 'RECIPIENT_NOT_VERIFIABLE');
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

// ─── Masked account numbers ──────────────────────────────────────────────────
// Dashen prints no full account number at all, and other banks print only part
// of one. When digits are visible they are real evidence and are checked; the
// hidden middle is the bank's choice, not something to guess at.

test('a masked account passes when its visible digits line up', () => {
  const expected = '5155104739011';
  for (const printed of ['5155*******11', '5155***9011', '****4739011', '5155104739***']) {
    assert.equal(maskedAccountMatches(printed, expected), true, `${printed} should match`);
  }
});

test('a masked account is rejected when a visible digit disagrees', () => {
  const expected = '5155104739011';
  for (const printed of ['5155*******12', '9999*******11', '1234*******11']) {
    assert.equal(maskedAccountMatches(printed, expected), false, `${printed} should not match`);
  }
});

test('a lone visible run must sit at one end, not merely somewhere', () => {
  // 4739 is in the middle of 5155104739011 but matches neither end. Accepting a
  // middle run would let far too much through.
  assert.equal(maskedAccountMatches('****4739****', '5155104739011'), false);
  assert.equal(maskedAccountMatches('****9011', '5155104739011'), true);
  assert.equal(maskedAccountMatches('5155****', '5155104739011'), true);
});

test('a masked receipt account is matched through the main entry point', () => {
  const ok = checkReceiptRecipient({ foundAccount: '5155*******11', expectedAccount: '5155104739011' });
  assert.equal(ok.ok, true);
  assert.equal(ok.matchedOn, 'maskedAccount');

  const bad = checkReceiptRecipient({ foundAccount: '5155*******12', expectedAccount: '5155104739011' });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'RECIPIENT_MISMATCH');
});

// ─── Receiver name fallback ──────────────────────────────────────────────────
// The step that makes Dashen work at all: it identifies the beneficiary by name
// only, so the name is compared against the payout account's holder name.

test('a matching receiver name carries the check when no account is printed', () => {
  const result = checkReceiptRecipient({
    foundAccount: null,
    foundName: 'CRRSA AKAKI KALITY WOREDA 07',
    expectedAccount: '5155104739011',
    expectedHolderName: 'CRRSA Akaki Kality Woreda 07',
  });

  assert.equal(result.ok, true);
  assert.equal(result.matchedOn, 'receiverName');
});

test('a different receiver name is rejected even when nothing else is readable', () => {
  const result = checkReceiptRecipient({
    foundAccount: null,
    foundName: 'SOMEONE ELSE PLC',
    expectedAccount: '5155104739011',
    expectedHolderName: 'CRRSA Akaki Kality Woreda 07',
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'RECIPIENT_MISMATCH');
  assert.match(result.error!, /SOMEONE ELSE PLC/);
});

test('the name fallback needs both sides; a missing holder name is not a pass', () => {
  // The merchant never filled in accountHolderName, so there is nothing to
  // compare against and the check must not quietly succeed.
  for (const expectedHolderName of [null, undefined, '', '   ']) {
    const result = checkReceiptRecipient({
      foundAccount: null,
      foundName: 'CRRSA AKAKI KALITY WOREDA 07',
      expectedAccount: '5155104739011',
      expectedHolderName,
    });
    assert.equal(result.ok, false, `holder=${JSON.stringify(expectedHolderName)} must not pass`);
    assert.equal(result.reason, 'RECIPIENT_NOT_VERIFIABLE');
  }
});

test('names are compared exactly after normalisation, not fuzzily', () => {
  // Punctuation, case and spacing are noise; a truncation is a real difference
  // and must fail closed, because accepting it would start approving receipts
  // for similarly-named payees.
  assert.equal(receiverNameMatches('crrsa-akaki, kality woreda 07', 'CRRSA AKAKI KALITY WOREDA 07'), true);
  assert.equal(receiverNameMatches('CRRSA AKAKI KALITY', 'CRRSA AKAKI KALITY WOREDA 07'), false);
  assert.equal(receiverNameMatches('AKAKI KALITY WOREDA 07', 'CRRSA AKAKI KALITY WOREDA 07'), false);
  assert.equal(receiverNameMatches('', 'CRRSA'), false);
});

test('a matching account number does not also require the name', () => {
  // Requiring both would reject correct receipts whose name the bank truncated.
  const result = checkReceiptRecipient({
    foundAccount: '5155104739011',
    foundName: 'A DIFFERENT NAME',
    expectedAccount: '5155104739011',
    expectedHolderName: 'CRRSA Akaki Kality Woreda 07',
  });

  assert.equal(result.ok, true);
  assert.equal(result.matchedOn, 'account');
});

// ─── Separators ──────────────────────────────────────────────────────────────
// Banks print account numbers in groups. The exact comparison does no
// normalisation, so without this every grouped receipt read as a mismatch — and
// grouping is the normal way an account is printed.

test('an account printed in groups is recognised as the same account', () => {
  const expected = '5155104739011';
  for (const printed of [
    '5155 1047 39011',
    '5155-1047-39011',
    '5155.1047.39011',
    '5155/1047/39011',
    '5155 1047 39011',
    '  5155104739011  ',
  ]) {
    const result = checkReceiptRecipient({ foundAccount: printed, expectedAccount: expected });
    assert.equal(result.ok, true, `${printed} should match`);
    assert.equal(result.matchedOn, 'account');
  }
});

test('grouping does not make two different accounts match', () => {
  const result = checkReceiptRecipient({ foundAccount: '5155 1047 39012', expectedAccount: '5155104739011' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'RECIPIENT_MISMATCH');
});

// ─── Mask glyphs ─────────────────────────────────────────────────────────────
// A mask character we fail to recognise is worse than none: it sends the value
// down the exact-comparison path and reports a mismatch on a correct receipt.

test('every common mask glyph is treated as masking, not as a digit', () => {
  const expected = '5155104739011';
  for (const printed of ['5155*******11', '5155xxxxxxx11', '5155#######11', '5155•••••••11', '5155 – 11', '5155 — 11', '5155 ······· 11']) {
    const result = checkReceiptRecipient({ foundAccount: printed, expectedAccount: expected });
    assert.equal(result.ok, true, `${printed} should match`);
    assert.equal(result.matchedOn, 'maskedAccount');
  }
});

test('a fully masked account is not verifiable, not a mismatch', () => {
  // The bank printed nothing, so nothing contradicts anything. Reporting a
  // mismatch would send an operator looking for the wrong problem.
  for (const printed of ['************', 'xxxxxxxxxxxxxx', '***-***-****', '••••••••']) {
    const result = checkReceiptRecipient({ foundAccount: printed, expectedAccount: '5155104739011' });
    assert.equal(result.reason, 'RECIPIENT_NOT_VERIFIABLE', `${printed} should be unverifiable`);
  }
});

// ─── Non-Latin scripts ───────────────────────────────────────────────────────
// The severe one. Normalising to [a-z0-9] reduced three unrelated Amharic
// business names to the same "07" and all three passed each other's check.

test('Amharic names are compared on their own script, not reduced to digits', () => {
  const businessA = 'ክርሳ አካኪ ካሊቲ ወረዳ 07';
  const businessB = 'ብርታ ሶንብ ኢንተርፓይዘሽ 07';
  const businessC = 'አዲስ አበባ ንግድ 07';

  assert.equal(receiverNameMatches(businessA, businessA), true);
  for (const other of [businessB, businessC]) {
    assert.equal(receiverNameMatches(other, businessA), false, `${other} must not match ${businessA}`);
  }
});

test('a receipt for a different Amharic business fails the full check', () => {
  const mine = 'ክርሳ አካኪ ካሊቲ ወረዳ 07';
  for (const theirs of ['ብርታ ሶንብ ኢንተርፓይዘሽ 07', 'አዲስ አበባ ንግድ 07']) {
    const result = checkReceiptRecipient({
      foundAccount: null,
      foundName: theirs,
      expectedAccount: '5155104739011',
      expectedHolderName: mine,
    });
    assert.equal(result.ok, false, `${theirs} must not verify`);
    assert.equal(result.reason, 'RECIPIENT_MISMATCH');
  }
});

test('names in different scripts do not collide', () => {
  // Same trailing digits, one Latin and one Amharic.
  assert.equal(receiverNameMatches('Akaki Kality 07', 'አካኪ ካሊቲ 07'), false);
  assert.equal(receiverNameMatches('AKAKI KALITY 07', 'Akaki  Kality-07'), true);
});

test('a name that normalises to almost nothing is refused rather than guessed', () => {
  // Below the length floor the comparison is not evidence of anything, so it
  // must not return true.
  assert.equal(receiverNameMatches('07', '07'), false);
  assert.equal(receiverNameMatches('', 'anything'), false);
  assert.equal(receiverNameMatches('ab', 'ab'), false);
});