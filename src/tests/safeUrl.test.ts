// Webhook and redirect targets are tenant-supplied and dereferenced by the
// server, so `new URL()` alone made every tenant an internal scanner:
// http://169.254.169.254/ (cloud credentials), http://127.0.0.1:3001/admin/...
// and file:///etc/passwd were all accepted, and dashboard.ts validated neither
// the URL nor the event names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeOutboundUrl, isPrivateAddress, UnsafeOutboundUrlError } from '../utils/safeUrl';

test('private, loopback, link-local and reserved addresses are recognised', () => {
  for (const ip of [
    '127.0.0.1', '127.1.2.3', '10.0.0.1', '10.255.255.254', '172.16.0.1', '172.31.255.254',
    '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '198.18.0.1',
    '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'fd00::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '2001:db8::1',
  ]) {
    assert.equal(isPrivateAddress(ip), true, `${ip} must be treated as non-public`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700::1111']) {
    assert.equal(isPrivateAddress(ip), false, `${ip} is public and must be allowed`);
  }
});

test('unsafe webhook destinations are rejected', async () => {
  for (const url of [
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'http://127.0.0.1:3001/admin/stats',
    'http://localhost:3001/admin/stats',
    'http://[::1]:3001/',
    'http://10.0.0.5:8080/internal',
    'http://192.168.1.1/',
    'http://172.16.0.9/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://metadata/',
    'http://redis/',
    'file:///etc/passwd',
    'gopher://127.0.0.1:11211/',
    'ftp://example.com/',
    'not-a-url',
    '',
  ]) {
    await assert.rejects(
      () => assertSafeOutboundUrl(url),
      (err: unknown) => err instanceof UnsafeOutboundUrlError,
      `expected ${JSON.stringify(url)} to be rejected`,
    );
  }
});

test('credentials embedded in a URL are rejected', async () => {
  await assert.rejects(() => assertSafeOutboundUrl('http://user:pass@example.com/hook'));
});

test('public https webhook destinations are accepted', async () => {
  const url = await assertSafeOutboundUrl('https://example.com/hooks/veritas');
  assert.equal(url.protocol, 'https:');
  assert.equal(url.hostname, 'example.com');
  // A trailing slash difference is irrelevant; the stored value stays usable.
  const withPath = await assertSafeOutboundUrl('  https://example.com/hooks/veritas  ');
  assert.equal(withPath.hostname, 'example.com');
});

test('a public hostname resolving to a private address is rejected', async () => {
  // localhost is the portable stand-in for "name resolves somewhere internal".
  await assert.rejects(
    () => assertSafeOutboundUrl('http://localhost/hook'),
    (err: unknown) => err instanceof UnsafeOutboundUrlError,
  );
});
