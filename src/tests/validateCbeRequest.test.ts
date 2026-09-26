import test from 'node:test';
import assert from 'node:assert/strict';
import { cbeRequestError, validateCbeRequest } from '../middleware/validateCbeRequest';

test('CBE malformed inputs fail before credit reservation', () => {
  for (const input of [undefined, null, {}, { reference: 42 }, { reference: 'NOT-A-REAL-REFERENCE' },
    { reference: 'FT2513001V2G' }, { reference: 'FT2513001V2G', accountSuffix: '123' }]) {
    assert.equal(typeof cbeRequestError(input), 'string');
  }
});
test('legacy, embedded suffix and new CBE references preserve acceptance', () => {
  for (const input of [
    { reference: ' FT2513001V2G ', accountSuffix: ' 39003377 ' },
    { reference: 'https://apps.cbe.com.et:100/?id=FT2513001V2G39003377' },
    { reference: 'https://mbreciept.cbe.com.et/abcdef-123456789' },
    { reference: 'abcdefghijk123456789' },
  ]) assert.equal(cbeRequestError(input), null);
});
test('early validation blocks downstream billing for GET, HEAD and POST only on root', () => {
  for (const method of ['GET', 'HEAD', 'POST']) {
    let status = 0; let nextCalls = 0;
    const res = { status(code: number) { status = code; return this; }, json() {} };
    validateCbeRequest({ method, path: '/', body: {}, query: {} } as any, res as any, () => { nextCalls++; });
    assert.equal(status, 400);
    assert.equal(nextCalls, 0);
    validateCbeRequest({ method, path: '/other' } as any, res as any, () => { nextCalls++; });
    assert.equal(nextCalls, 1);
  }
});
