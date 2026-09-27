// executeVerification treated "not literally `success === false`" as a confirmed
// payment. An adapter that lost its status field, returned `{}`, returned
// `{ error: 'not found' }`, or was refactored onto a different envelope would all
// have been reported to a paying customer as a successful verification — and the
// caller would have been billed for it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { executeVerification, prepareVerification, type VerificationPlan } from '../services/verifyUniversal';

const plan: VerificationPlan = { provider: 'DASHEN', reference: '1234567890123456' };

test('prepareVerification still accepts a well-formed dashen reference', () => {
  const prepared = prepareVerification({ reference: '1234567890123456' });
  assert.equal(prepared.ok, true);
  if (prepared.ok) assert.equal(prepared.plan.provider, 'DASHEN');
});

test('an explicit success: true is the only shape that verifies', async () => {
  const result = await executeVerification(plan, {
    ...stubVerifiers({ success: true, amount: 299 }),
  });
  assert.equal(result.success, true);
  assert.equal(result.httpStatus, 200);
});

test('success: false is reported as a failure', async () => {
  const result = await executeVerification(plan, stubVerifiers({ success: false, error: 'Receipt not found.' }));
  assert.equal(result.success, false);
  assert.equal(result.error, 'Receipt not found.');
});

test('a payload with no success field at all does not verify', async () => {
  // This was the fail-open: verifyCBEBirr and verifyTelebirr used to return a
  // bare receipt object, so "absent" had to mean "success". Both adapters now
  // normalise their envelope, and absence means refusal.
  const result = await executeVerification(plan, stubVerifiers({ amount: 299, receiptNumber: 'ABC1234567' }));
  assert.equal(result.success, false);
  assert.equal(result.httpStatus, 502);
  assert.match(result.error ?? '', /could not confirm/i);
});

test('an empty object does not verify', async () => {
  const result = await executeVerification(plan, stubVerifiers({}));
  assert.equal(result.success, false);
});

test('an error-only payload is a failure even without success: false', async () => {
  const result = await executeVerification(plan, stubVerifiers({ error: 'Receipt not found.' }));
  assert.equal(result.success, false);
  assert.equal(result.error, 'Receipt not found.');
});

test('a null or undefined payload is a 404, not a success', async () => {
  assert.equal((await executeVerification(plan, stubVerifiers(null))).success, false);
  assert.equal((await executeVerification(plan, stubVerifiers(null))).httpStatus, 404);
  assert.equal((await executeVerification(plan, stubVerifiers(undefined))).success, false);
});

test('a verifier that throws is a failure carrying the provider name', async () => {
  const verifiers = stubVerifiers({ success: true });
  verifiers.DASHEN = async () => { throw new Error('upstream timeout'); };
  const result = await executeVerification(plan, verifiers);
  assert.equal(result.success, false);
  assert.equal(result.provider, 'DASHEN');
  assert.equal(result.error, 'upstream timeout');
  assert.equal(result.httpStatus, 500);
});

test('a provider-supplied statusCode is honoured on the refusal path', async () => {
  const result = await executeVerification(plan, stubVerifiers({ statusCode: 400, error: 'bad reference' }));
  assert.equal(result.success, false);
  assert.equal(result.httpStatus, 400);
});

test('the automatic awash/zemen fallback only accepts a real success', async () => {
  const fallbackPlan: VerificationPlan = { provider: 'AWASH_ZEMEN', reference: 'ABCDEFGH12345' };

  const awashFails = await executeVerification(fallbackPlan, {
    ...stubVerifiers({ success: false, error: 'not found' }),
    ZEMEN: async () => ({ success: true, amount: 100 }),
  });
  assert.equal(awashFails.success, true);
  assert.equal(awashFails.provider, 'ZEMEN');

  // Neither confirming is a 404 — and crucially, an unrecognised payload from
  // either one does not become a success by falling through.
  const neither = await executeVerification(fallbackPlan, stubVerifiers({ amount: 100 }));
  assert.equal(neither.success, false);
  assert.equal(neither.httpStatus, 404);
});

/** Every provider key must be present; only the one under test is exercised. */
function stubVerifiers(payload: unknown) {
  const stub = async () => payload;
  return {
    CBE: stub, CBE_BIRR: stub, TELEBIRR: stub, DASHEN: stub,
    ABYSSINIA: stub, MPESA: stub, AWASH: stub, ZEMEN: stub,
  };
}
