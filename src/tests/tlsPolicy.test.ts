// Four provider adapters hardcoded `new https.Agent({ rejectUnauthorized: false })`.
// For a service whose whole job is proving a bank receipt is genuine, that means
// anyone on the network path could serve a receipt they wrote and the API would
// report a successful payment. Nothing logged it and there was no way to turn it
// back on for one host without a code change.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  httpsAgentFor,
  isTlsVerificationDisabledFor,
  resetTlsPolicyCache,
  tlsPolicyState,
  verifyingAgentWithExtraCa,
} from '../utils/tlsPolicy';

test('certificate verification is on for a host that is not listed', () => {
  resetTlsPolicyCache();
  const agent = httpsAgentFor('https://example-bank.com.et/receipt/123');
  assert.equal((agent.options as any).rejectUnauthorized !== false, true,
    'an unlisted host must verify its certificate');
  assert.equal(isTlsVerificationDisabledFor('example-bank.com.et'), false);
});

test('the hosts that genuinely need relaxing are named, and only those', () => {
  resetTlsPolicyCache();
  const { verificationDisabledFor, defaultPolicy } = tlsPolicyState();
  assert.equal(defaultPolicy, 'verify');
  for (const host of ['apps.cbe.com.et', 'mb.cbe.com.et', 'awashpay.awashbank.com', 'share.zemenbank.com']) {
    assert.ok(verificationDisabledFor.includes(host), `${host} is a known broken chain and must be seeded`);
    assert.equal(isTlsVerificationDisabledFor(host), true);
  }
  // Hosts with working chains must not be swept in.
  for (const host of ['cs.bankofabyssinia.com', 'receipts.dashenbanksc.com', 'cbepay1.cbe.com.et']) {
    assert.equal(isTlsVerificationDisabledFor(host), false, `${host} must verify its certificate`);
  }
});

test('a relaxed host gets an agent with verification off, a normal host does not', () => {
  resetTlsPolicyCache();
  const relaxed = httpsAgentFor('https://apps.cbe.com.et:100/?id=ABC');
  assert.equal((relaxed.options as any).rejectUnauthorized, false);

  const strict = httpsAgentFor('https://cs.bankofabyssinia.com/receipt');
  assert.notEqual((strict.options as any).rejectUnauthorized, false);
  assert.notEqual(strict, relaxed);
});

test('the port does not change the decision — matching is by hostname', () => {
  resetTlsPolicyCache();
  assert.equal(isTlsVerificationDisabledFor('awashpay.awashbank.com'), true);
  // The agent is selected from the URL, where the port is present.
  const agent = httpsAgentFor('https://awashpay.awashbank.com:8225/-ABC123');
  assert.equal((agent.options as any).rejectUnauthorized, false);
});

test('agents are cached per host so sockets are reused', () => {
  resetTlsPolicyCache();
  const first = httpsAgentFor('https://apps.cbe.com.et:100/?id=1');
  const second = httpsAgentFor('https://apps.cbe.com.et:100/?id=2');
  assert.equal(first, second, 'constructing an agent per request leaks sockets');

  const secureA = httpsAgentFor('https://cs.bankofabyssinia.com/a');
  const secureB = httpsAgentFor('https://receipts.dashenbanksc.com/b');
  assert.equal(secureA, secureB, 'all verifying hosts share one agent');
});

test('INSECURE_TLS_HOSTS overrides the seeded list', () => {
  resetTlsPolicyCache();
  const env = { INSECURE_TLS_HOSTS: 'only-this-host.example' } as NodeJS.ProcessEnv;
  assert.deepEqual(tlsPolicyState(env).verificationDisabledFor, ['only-this-host.example']);
  assert.equal(isTlsVerificationDisabledFor('apps.cbe.com.et', env), false);
  assert.equal(isTlsVerificationDisabledFor('only-this-host.example', env), true);
  // An empty value means "verify everything", which is a legitimate choice.
  assert.deepEqual(tlsPolicyState({ INSECURE_TLS_HOSTS: '' } as NodeJS.ProcessEnv).verificationDisabledFor, []);
});

test('hostname matching is case-insensitive', () => {
  resetTlsPolicyCache();
  assert.equal(isTlsVerificationDisabledFor('APPS.CBE.COM.ET'), true);
  assert.equal(isTlsVerificationDisabledFor('  share.zemenbank.com  '), true);
});

test('no extra CA bundle is applied unless TLS_CA_BUNDLE_PATH is set', () => {
  resetTlsPolicyCache();
  const previous = process.env.TLS_CA_BUNDLE_PATH;
  delete process.env.TLS_CA_BUNDLE_PATH;
  assert.equal(verifyingAgentWithExtraCa('https://apps.cbe.com.et:100/?id=1'), undefined);

  // A configured-but-unreadable bundle must not silently downgrade to no CA.
  process.env.TLS_CA_BUNDLE_PATH = '/nonexistent/ca.pem';
  assert.equal(verifyingAgentWithExtraCa('https://apps.cbe.com.et:100/?id=1'), undefined);

  if (previous !== undefined) process.env.TLS_CA_BUNDLE_PATH = previous;
  resetTlsPolicyCache();
});
