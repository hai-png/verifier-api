// The payout account could be created and deleted from the dashboard but never
// edited, and the dashboard's own create route validated nothing at all — so a
// malformed phone number could be saved there, then be offered as the expected
// recipient and quietly never match a receipt. The API-key route validated, the
// dashboard route did not, because the validators were private to payouts.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseAccount,
  normaliseOptionalLabel,
  normaliseProviders,
  resolvePayoutState,
  validatePayoutEdit,
  validatePayoutInput,
} from '../utils/payoutInput';

test('a malformed phone number is refused', () => {
  for (const bad of ['123', '0906422230x', '25190642223', '']) {
    const problem = validatePayoutInput('PHONE', normaliseAccount(bad), ['telebirr']);
    assert.ok(problem, `${JSON.stringify(bad)} should be refused`);
  }
  assert.equal(validatePayoutInput('PHONE', normaliseAccount('0906422230'), ['telebirr']), null);
  assert.equal(validatePayoutInput('PHONE', normaliseAccount('251906422230'), ['telebirr']), null);
});

test('a bank account needs 13-16 digits and exactly one bank provider', () => {
  assert.ok(validatePayoutInput('BANK', normaliseAccount('12345'), ['cbe']));
  assert.equal(validatePayoutInput('BANK', normaliseAccount('1000123456789012'), ['cbe']), null);

  // Two banks on one account is the ambiguous case that would make
  // pickPayoutAccountForProvider refuse to choose at all.
  assert.match(
    validatePayoutInput('BANK', normaliseAccount('1000123456789012'), ['cbe', 'dashen']) ?? '',
    /exactly one bank provider/,
  );
});

test('a phone account cannot accept a bank provider', () => {
  assert.match(
    validatePayoutInput('PHONE', normaliseAccount('0906422230'), ['cbe']) ?? '',
    /Phone accounts cannot accept: cbe/,
  );
});

test('providers are deduped and canonicalised to the one spelling used everywhere else', () => {
  // The old assertion expected ['telebirr', 'm-pesa'] and locked the bug in.
  // normaliseProviders lower-cased but did not canonicalise, so 'M-Pesa' was
  // stored verbatim — where validatePayoutInput's allow-list rejected it and
  // ensureProviderCoverage, which matches on 'mpesa', could not see it. The
  // account then existed, was accepted by nothing, and matched no receipt.
  assert.deepEqual(normaliseProviders(['Telebirr', 'telebirr', ' M-Pesa ']), ['telebirr', 'mpesa']);
  assert.deepEqual(normaliseProviders('nope'), []);

  // Every alias the verification engine accepts (verifyUniversal.ts) must
  // canonicalise to the same value the payout vocabulary uses.
  for (const alias of ['mpesa', 'M-Pesa', 'm-pesa', 'M PESA', '  m-pesa  ']) {
    assert.deepEqual(normaliseProviders([alias]), ['mpesa'], `${alias} must become mpesa`);
  }
  for (const alias of ['cbebirr', 'CBE-Birr', 'cbe_birr', 'CBE Birr']) {
    assert.deepEqual(normaliseProviders([alias]), ['cbebirr'], `${alias} must become cbebirr`);
  }
});

test('a canonicalised alias passes validation that the alias itself failed', () => {
  // End of the chain: a merchant sending the spelling they read off the API docs
  // must end up with a working account.
  assert.equal(validatePayoutInput('PHONE', normaliseAccount('0906422230'), normaliseProviders(['M-Pesa'])), null);
  assert.equal(validatePayoutInput('PHONE', normaliseAccount('0906422230'), normaliseProviders(['CBE-Birr'])), null);
});

test('a label of only whitespace is treated as absent, not as a string to store', () => {
  assert.equal(normaliseOptionalLabel(undefined), null);
  assert.equal(normaliseOptionalLabel('   '), null);
  assert.equal(normaliseOptionalLabel(' Main '), 'Main');
  assert.equal(normaliseOptionalLabel(42), 'invalid');
});

test('an edit can change the label, holder name, account and providers', () => {
  const result = validatePayoutEdit(
    { type: 'PHONE' },
    {
      label: '  Main Telebirr ',
      accountHolderName: 'CRRSA',
      account: ' 0906422230 ',
      providersAllowed: ['Telebirr'],
    },
  );
  assert.ok('data' in result, JSON.stringify(result));
  if (!('data' in result)) return;
  assert.equal(result.data.label, 'Main Telebirr');
  assert.equal(result.data.accountHolderName, 'CRRSA');
  assert.equal(result.data.account, '0906422230');
  assert.deepEqual(result.data.providersAllowed, ['telebirr']);
});

test('an edit cannot leave a bank account with two providers', () => {
  const result = validatePayoutEdit({ type: 'BANK' }, { providersAllowed: ['cbe', 'dashen'] });
  assert.ok('error' in result);
  if ('error' in result) assert.match(result.error, /exactly one bank provider/);
});

test('an edit that would make the account invalid is refused', () => {
  const bad = validatePayoutEdit({ type: 'PHONE' }, { account: '123' });
  assert.ok('error' in bad);
  if ('error' in bad) assert.match(bad.error, /valid Ethiopian phone/);
});

test('an edit leaves untouched fields alone', () => {
  const result = validatePayoutEdit({ type: 'PHONE' }, { label: 'Renamed' });
  assert.ok('data' in result);
  if ('data' in result) {
    assert.equal(result.data.label, 'Renamed');
    assert.equal(result.data.account, undefined);
    assert.equal(result.data.providersAllowed, undefined);
  }
});

// ─── Unified accounts ────────────────────────────────────────────────────────
// One payout account can hold a destination per provider — a phone for the
// wallet providers and a bank account number for a bank — so products and
// payment links pick it as a unit while each receipt is still compared against
// its own provider's number. resolvePayoutState is the single place that
// decides what a create or edit results in.

test('a unified create keeps one number per provider and derives UNIFIED', () => {
  const result = resolvePayoutState(null, {
    providersAllowed: ['Telebirr', 'CBE'],
    providerAccounts: { telebirr: '0906422230', cbe: '1000123456789012' },
  });
  assert.ok('data' in result, JSON.stringify(result));
  if (!('data' in result)) return;
  assert.equal(result.data.type, 'UNIFIED');
  assert.equal(result.data.account, '0906422230', 'the legacy column gets the first destination');
  assert.deepEqual(result.data.providersAllowed, ['telebirr', 'cbe']);
  assert.deepEqual(result.data.providerAccounts, {
    telebirr: '0906422230',
    cbe: '1000123456789012',
  });
});

test('two banks coexist once each gets its own number', () => {
  // Under the legacy shape this is the ambiguous case ("exactly one bank
  // provider"); with an explicit number per bank there is nothing ambiguous.
  const result = resolvePayoutState(null, {
    providersAllowed: ['cbe', 'dashen'],
    providerAccounts: { cbe: '1000123456789012', dashen: '2000123456789012' },
  });
  assert.ok('data' in result, JSON.stringify(result));
  if (!('data' in result)) return;
  assert.equal(result.data.type, 'BANK');
  assert.deepEqual(result.data.providerAccounts, {
    cbe: '1000123456789012',
    dashen: '2000123456789012',
  });
});

test('a single account still serves several providers of one kind', () => {
  // The legacy shape: no map, one phone for the wallets. The map stays empty so
  // a later `account` change is not blocked by frozen entries.
  const result = resolvePayoutState(null, { account: '0906422230', providersAllowed: ['telebirr', 'mpesa'] });
  assert.ok('data' in result, JSON.stringify(result));
  if (!('data' in result)) return;
  assert.equal(result.data.type, 'PHONE');
  assert.equal(result.data.account, '0906422230');
  assert.deepEqual(result.data.providerAccounts, {});
});

test('account remains the fallback for providers the map does not name', () => {
  const result = resolvePayoutState(null, {
    account: '0906422230',
    providersAllowed: ['telebirr', 'mpesa'],
    providerAccounts: { mpesa: '0911223344' },
  });
  assert.ok('data' in result, JSON.stringify(result));
  if (!('data' in result)) return;
  assert.equal(result.data.account, '0906422230');
  assert.deepEqual(result.data.providerAccounts, { mpesa: '0911223344' });
});

test('a provider with neither a number nor a fallback is refused', () => {
  const result = resolvePayoutState(null, {
    providersAllowed: ['telebirr', 'cbe'],
    providerAccounts: { telebirr: '0906422230' },
  });
  assert.ok('error' in result);
  if ('error' in result) assert.match(result.error, /No account number for: cbe/);
});

test('a destination in the wrong format is refused, naming the provider', () => {
  const badPhone = resolvePayoutState(null, {
    providersAllowed: ['telebirr', 'mpesa'],
    providerAccounts: { telebirr: '0906422230', mpesa: '1000123456789012' },
  });
  assert.ok('error' in badPhone);
  if ('error' in badPhone) assert.match(badPhone.error, /mpesa destination must be a valid Ethiopian phone/);

  const badBank = resolvePayoutState(null, {
    providersAllowed: ['cbe', 'dashen'],
    providerAccounts: { cbe: '1000123456789012', dashen: '0911223344' },
  });
  assert.ok('error' in badBank);
  if ('error' in badBank) assert.match(badBank.error, /dashen destination must be a 13-16 digit bank account number/);
});

test('an edit changes one destination without disturbing the rest', () => {
  const current = {
    account: '0906422230',
    providersAllowed: ['telebirr', 'cbebirr'],
    providerAccounts: { telebirr: '0906422230', cbebirr: '0911223344' },
  };

  const result = resolvePayoutState(current, { providerAccounts: { cbebirr: '0911334455' } });
  assert.ok('data' in result, JSON.stringify(result));
  if (!('data' in result)) return;
  assert.deepEqual(result.data.providerAccounts, { telebirr: '0906422230', cbebirr: '0911334455' });
  assert.equal(result.data.type, 'PHONE');

  // Dropping a provider drops its entry, so a later re-add starts over rather
  // than silently inheriting a stale number.
  const narrowed = resolvePayoutState(current, { providersAllowed: ['telebirr'] });
  assert.ok('data' in narrowed, JSON.stringify(narrowed));
  if (!('data' in narrowed)) return;
  assert.deepEqual(narrowed.data.providerAccounts, { telebirr: '0906422230' });
});

test('the map is canonicalised like providersAllowed is', () => {
  const result = resolvePayoutState(null, {
    providersAllowed: ['M-Pesa'],
    providerAccounts: { 'M-Pesa': '0911223344' },
  });
  assert.ok('data' in result, JSON.stringify(result));
  if (!('data' in result)) return;
  assert.deepEqual(result.data.providersAllowed, ['mpesa']);
  assert.deepEqual(result.data.providerAccounts, { mpesa: '0911223344' });
});

test('unknown or malformed maps are refused outright', () => {
  for (const bad of ['telebirr', 42, ['telebirr'], { awash: '0906422230' }, { telebirr: '' }, { telebirr: 42 }]) {
    const result = resolvePayoutState(null, { providersAllowed: ['telebirr'], providerAccounts: bad });
    assert.ok('error' in result, `map=${JSON.stringify(bad)} must be refused`);
  }

  // A provider the allow-list does not know is refused before any destination
  // is examined, with the full list so the caller can correct the spelling.
  const unknown = resolvePayoutState(null, { providersAllowed: ['awash'] });
  assert.ok('error' in unknown);
  if ('error' in unknown) assert.match(unknown.error, /unsupported providers: awash/);
});
