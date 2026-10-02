// CBE has two receipt generations with opposite suffix rules, and the failures
// were both unhelpful and — in one case — silent.
//
// Legacy receipts are FT + 10 characters plus the payer's 8-digit account tail.
// New receipts are a 15-40 character token and must NOT be sent a suffix. The
// 20- and 17-character combined strings (reference and tail printed together) are
// real receipt shapes and were already described by a regex, but only reachable
// through a receipt URL's `id` parameter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareVerification } from '../services/verifyUniversal';
import { splitLegacyCbeCombinedId } from '../utils/cbeReference';

const plan = (input: unknown) => {
  const result = prepareVerification(input);
  assert.equal(result.ok, true, result.ok ? '' : `expected ok, got: ${result.result.error}`);
  if (!result.ok) throw new Error('unreachable');
  return result.plan;
};

const failure = (input: unknown) => {
  const result = prepareVerification(input);
  assert.equal(result.ok, false, 'expected a failure');
  if (result.ok) throw new Error('unreachable');
  return result.result;
};

test('a legacy reference with its 8-digit tail verifies as CBE', () => {
  const p = plan({ reference: 'FT1234567890', suffix: '12345678', provider: 'cbe' });
  assert.equal(p.provider, 'CBE');
  assert.equal(p.reference, 'FT1234567890');
  assert.equal(p.suffix, '12345678');
});

test('a reference and tail pasted as one string are split, not rejected', () => {
  // Previously "Invalid CBE reference format" with an explicit provider, and
  // silently routed to AWASH_ZEMEN under auto-detection — a CBE payment looked
  // up against the wrong bank.
  const explicit = plan({ reference: 'FT123456789012345678', provider: 'cbe' });
  assert.equal(explicit.provider, 'CBE');
  assert.equal(explicit.reference, 'FT1234567890');
  assert.equal(explicit.suffix, '12345678');

  const auto = plan({ reference: 'FT123456789012345678' });
  assert.equal(auto.provider, 'CBE', 'must not fall through to AWASH_ZEMEN');
  assert.equal(auto.suffix, '12345678');
});

test('the 17-character Abyssinia shape is split too', () => {
  const combined = splitLegacyCbeCombinedId('FT123456789012345');
  assert.deepEqual(combined, { reference: 'FT1234567890', suffix: '12345', provider: 'abyssinia' });

  assert.equal(plan({ reference: 'FT123456789012345' }).provider, 'ABYSSINIA');
});

test('a combined reference plus a matching suffix is fine, a conflicting one is refused', () => {
  assert.equal(plan({ reference: 'FT123456789012345678', suffix: '12345678' }).suffix, '12345678');

  // Verifying one receipt against another tail must not be possible.
  const conflict = failure({ reference: 'FT123456789012345678', suffix: '99999999' });
  assert.match(conflict.error ?? '', /does not match the suffix you supplied/);
});

test('a missing suffix explains what one is, and offers the alternatives', () => {
  const missing = failure({ reference: 'FT1234567890', provider: 'cbe' });
  assert.match(missing.error ?? '', /8-digit account suffix/);
  assert.match(missing.error ?? '', /after 1000/, 'must say where the digits come from');
  assert.match(missing.error ?? '', /receipt URL/, 'must offer the easier route');
});

test('a 5-digit tail is recognised as Abyssinia rather than a mistyped CBE', () => {
  const result = failure({ reference: 'FT1234567890', suffix: '12345', provider: 'cbe' });
  assert.match(result.error ?? '', /Abyssinia/);
});

test('new-format receipts still take no suffix', () => {
  assert.equal(plan({ reference: 'AbCdEf123456789XyZ', provider: 'cbe' }).provider, 'CBE');
  assert.match(
    failure({ reference: 'AbCdEf123456789XyZ', suffix: '12345678', provider: 'cbe' }).error ?? '',
    /does not use a suffix/,
  );
});

test('a full legacy receipt URL is still read, and a conflicting suffix still refused', () => {
  const url = 'https://apps.cbe.com.et:100/ft?id=FT123456789012345678';
  assert.equal(plan({ reference: url, provider: 'cbe' }).suffix, '12345678');
  assert.match(failure({ reference: url, suffix: '99999999', provider: 'cbe' }).error ?? '', /conflicts with the CBE receipt URL/);
});

test('auto-detection is unchanged for the shapes that already worked', () => {
  // Guard against the normalisation changing anything it should not touch.
  assert.equal(plan({ reference: 'DI10CLDXTM' }).provider, 'TELEBIRR');
  assert.equal(plan({ reference: 'FT1234567890', suffix: '12345' }).provider, 'ABYSSINIA');
  assert.equal(plan({ reference: 'FT1234567890', suffix: '12345678' }).provider, 'CBE');
});

test('the combined split does not swallow genuinely long non-CBE references', () => {
  // Longer than NEW_CBE_TOKEN_REGEX's 40-character ceiling, so it cannot be
  // mistaken for a new CBE token and falls through to Awash/Zemen.
  assert.equal(plan({ reference: 'X'.repeat(45) }).provider, 'AWASH_ZEMEN');
});