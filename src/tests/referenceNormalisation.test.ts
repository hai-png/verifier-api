// References are copied out of PDFs, spreadsheets and messaging apps, so they
// arrive with newlines, runs of spaces, zero-width characters and full-width
// digits — none of which are part of the reference, all of which break a length
// check. Case is deliberately preserved: new-format CBE tokens are
// case-sensitive.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseReference } from '../utils/cbeReference';
import { prepareVerification } from '../services/verifyUniversal';

test('surrounding and repeated whitespace collapses to a single space', () => {
  assert.equal(normaliseReference('  FT1234567890  '), 'FT1234567890');
  assert.equal(normaliseReference('a    b'), 'a b');
});

test('a newline inside a reference is collapsed, not left to break length checks', () => {
  // A pasted PDF line break would otherwise make a 12-character reference read
  // as 13 and fail every format test.
  assert.equal(normaliseReference('FT12345678\n90'), 'FT12345678 90');
  assert.equal(normaliseReference('DI10\tCLDXTM'), 'DI10 CLDXTM');
});

test('full-width characters fold to their ASCII equivalents', () => {
  // A non-Latin keyboard produces these and they look identical to the eye.
  assert.equal(normaliseReference('ＦＴ１２３４５６７８９０'), 'FT1234567890');
});

test('zero-width and BOM characters are removed', () => {
  assert.equal(normaliseReference('DI10CLDXTM'), 'DI10CLDXTM');
  assert.equal(normaliseReference('﻿DI10CLDXTM'), 'DI10CLDXTM');
});

test('case is preserved because new-format CBE tokens are case-sensitive', () => {
  assert.equal(normaliseReference('AbCdEf123456789XyZ'), 'AbCdEf123456789XyZ');
});

test('a non-string normalises to empty rather than throwing', () => {
  assert.equal(normaliseReference(null), '');
  assert.equal(normaliseReference(undefined), '');
  assert.equal(normaliseReference(42), '');
});

test('a reference pasted with paste noise still verifies', () => {
  const result = prepareVerification({ reference: '  DI10CLDXTM  ' });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.plan.reference, 'DI10CLDXTM');
    assert.equal(result.plan.provider, 'TELEBIRR');
  }
});

test('normalising does not change what a reference identifies', () => {
  const clean = prepareVerification({ reference: 'FT123456789012345678' });
  const noisy = prepareVerification({ reference: '  FT123456789012345678\n ' });
  assert.equal(clean.ok && noisy.ok, true);
  if (clean.ok && noisy.ok) {
    assert.equal(noisy.plan.reference, clean.plan.reference);
    assert.equal(noisy.plan.provider, clean.plan.provider);
    assert.equal(noisy.plan.suffix, clean.plan.suffix);
  }
});
