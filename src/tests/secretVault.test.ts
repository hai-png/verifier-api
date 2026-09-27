// Webhook.signingSecret was stored in plaintext — in a column still called
// `secretHash`. A database read therefore yielded the signing key for every
// merchant's webhook, which is enough to POST a forged `payment_link.paid` event
// that the merchant's own endpoint accepts as authentic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  secretVaultEnabled,
  secretVaultState,
} from '../utils/secretVault';

const KEY = 'webhook-vault-test-key-that-is-long-enough';
const env = { WEBHOOK_SECRET_KEY: KEY } as NodeJS.ProcessEnv;
const noKey = {} as NodeJS.ProcessEnv;

test('the vault reports whether it is armed without revealing the key', () => {
  assert.equal(secretVaultEnabled(env), true);
  assert.equal(secretVaultEnabled(noKey), false);
  assert.deepEqual(secretVaultState(env), { encryptionEnabled: true, keyEnvVar: 'WEBHOOK_SECRET_KEY' });
  assert.ok(!JSON.stringify(secretVaultState(env)).includes(KEY));
});

test('a short or empty key is not accepted', () => {
  assert.equal(secretVaultEnabled({ WEBHOOK_SECRET_KEY: '' } as NodeJS.ProcessEnv), false);
  assert.equal(secretVaultEnabled({ WEBHOOK_SECRET_KEY: 'too-short' } as NodeJS.ProcessEnv), false);
  assert.equal(secretVaultEnabled({ WEBHOOK_SECRET_KEY: ' ' } as NodeJS.ProcessEnv), false);
});

test('an encrypted secret round-trips and the plaintext is not recoverable from storage', () => {
  const raw = 'a1b2c3d4e5f6'.repeat(4);
  const stored = encryptSecret(raw, env);
  assert.ok(isEncryptedSecret(stored));
  assert.ok(!stored.includes(raw), 'the stored value must not contain the secret');
  assert.notEqual(stored, raw);
  assert.equal(decryptSecret(stored, env), raw);
});

test('the same secret encrypts to a different value each time', () => {
  // A fresh IV per row: identical secrets must not produce identical ciphertext,
  // which would let an attacker tell two merchants share a key.
  const raw = 'shared-secret-value';
  assert.notEqual(encryptSecret(raw, env), encryptSecret(raw, env));
  assert.equal(decryptSecret(encryptSecret(raw, env), env), raw);
});

test('without a configured key the value is stored unchanged, not silently unusable', () => {
  // Deployments that have not set WEBHOOK_SECRET_KEY must keep working exactly as
  // before. Encrypting anyway would write values nothing could ever read back.
  const raw = 'plaintext-secret';
  const stored = encryptSecret(raw, noKey);
  assert.equal(stored, raw);
  assert.equal(isEncryptedSecret(stored), false);
  assert.equal(decryptSecret(stored, noKey), raw);
});

test('legacy plaintext rows still decrypt after the key is switched on', () => {
  // Turning encryption on must not break the webhooks already registered.
  assert.equal(decryptSecret('legacy-plaintext-secret', env), 'legacy-plaintext-secret');
  assert.equal(isEncryptedSecret('legacy-plaintext-secret'), false);
});

test('a tampered ciphertext fails closed instead of signing with garbage', () => {
  const stored = encryptSecret('real-secret', env);
  const bytes = Buffer.from(stored.slice(3), 'base64');
  bytes[bytes.length - 1] ^= 0xff;
  const tampered = `v2.${bytes.toString('base64')}`;
  assert.equal(decryptSecret(tampered, env), null,
    'a GCM tag failure means no signature, not a wrong signature');
});

test('a ciphertext written under a different key does not decrypt', () => {
  const stored = encryptSecret('real-secret', { WEBHOOK_SECRET_KEY: 'a-completely-different-key-value' } as NodeJS.ProcessEnv);
  assert.ok(isEncryptedSecret(stored));
  assert.equal(decryptSecret(stored, env), null);
});

test('an encrypted value with no key configured fails closed', () => {
  const stored = encryptSecret('real-secret', env);
  assert.equal(decryptSecret(stored, noKey), null);
});

test('null, undefined and empty secrets stay null', () => {
  assert.equal(decryptSecret(null, env), null);
  assert.equal(decryptSecret(undefined, env), null);
  assert.equal(decryptSecret('', env), null);
  assert.equal(isEncryptedSecret(null), false);
  assert.equal(isEncryptedSecret(undefined), false);
});

test('truncated ciphertext is rejected rather than throwing', () => {
  assert.equal(decryptSecret('v2.AAAA', env), null);
  assert.equal(decryptSecret('v2.', env), null);
  assert.equal(decryptSecret('v2.not-base64-at-all!!', env), null);
});
