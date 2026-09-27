import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareVerification, executeVerification, providerVerifiers, ProviderVerifiers } from '../services/verifyUniversal';

const prepare = (input: unknown) => {
  const result = prepareVerification(input);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error('not prepared');
  return result.plan;
};
test('aliases, explicit provider and auto routing converge on the same plan', () => {
  const a = prepare({ reference: '1234567890123456' });
  const b = prepare({ reference: ' 1234567890123456 ', provider: 'dashen' });
  assert.deepEqual(a, b);
  assert.deepEqual(prepare({ reference: 'CE12345678' }), prepare({ receiptNumber: 'CE12345678', provider: 'telebirr' }));
  assert.deepEqual(prepare({ reference: 'FT2513001V2G', accountSuffix: '39003377' }),
    prepare({ provider: 'cbe', reference: 'https://apps.cbe.com.et:100/?id=FT2513001V2G39003377' }));
});
test('explicit new CBE token does not require a legacy suffix and preserves case', () => {
  const token = 'Abcdef1234567890xyz';
  assert.deepEqual(prepare({ provider: 'cbe', reference: token }),
    prepare({ provider: 'cbe', reference: `https://mbreciept.cbe.com.et/${token}` }));
  assert.equal(prepare({ provider: 'cbe', reference: token }).reference, token);
});
test('invalid inputs and conflicting aliases fail without provider work', () => {
  for (const input of [null, [], {}, { reference: 7 }, { reference: ['a'] },
    { reference: 'FT2513001V2G', suffix: 'abcdefgh' },
    { reference: 'FT2513001V2G', suffix: '39003377', accountSuffix: '12345678' },
    { reference: 'ABC', receiptNumber: 'OTHER', provider: 'telebirr' },
    { reference: 'CE12345678', provider: 'constructor' },
    { reference: 'CE12345678', provider: '__proto__' },
    { reference: 'CE12345678', provider: 'cbebirr', phoneNumber: '251123' },
    { reference: 'CE12345678', provider: 'telebirr', phoneNumber: '251911111111' },
  ]) assert.equal(prepareVerification(input).ok, false, JSON.stringify(input));
});
test('explicit Telebirr and Dashen use exactly one dispatch and preserve provider failures', async () => {
  const calls: string[] = [];
  const fake = Object.fromEntries(Object.keys(providerVerifiers).map((provider) => [provider, async () => {
    calls.push(provider); return { success: provider === 'TELEBIRR', error: 'missing', amount: 123 };
  }])) as unknown as ProviderVerifiers;
  assert.equal((await executeVerification(prepare({ reference: 'CE2513001XYT', provider: 'telebirr' }), fake)).success, true);
  assert.equal((await executeVerification(prepare({ reference: '1234567890123456', provider: 'dashen' }), fake)).httpStatus, 422);
  assert.deepEqual(calls, ['TELEBIRR', 'DASHEN']);
});
