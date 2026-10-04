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

// The regression this file did not have. `isPrivateAddress('::ffff:127.0.0.1')`
// passed because the old check matched the dotted-quad spelling — but
// `new URL()` never emits that spelling, it normalises to hex hextets, so the
// guard silently never ran on a real request. Everything here is asserted in
// the notation an attacker actually types into a webhook URL field.
test('IPv4-mapped and IPv4-compatible IPv6 are judged by the IPv4 rules', () => {
  for (const ip of [
    '::ffff:a9fe:a9fe', // 169.254.169.254, cloud metadata
    '::ffff:7f00:1',    // 127.0.0.1, loopback
    '::ffff:a00:1',     // 10.0.0.1, private
    '::ffff:c0a8:1',    // 192.168.0.1, private
    '::7f00:1',         // 127.0.0.1, IPv4-compatible
    '::a9fe:a9fe',      // 169.254.169.254, IPv4-compatible
    '0:0:0:0:0:ffff:7f00:1', // fully written out
    'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '2001:db8::1',
    '64:ff9b::1.2.3.4', '100::1',
  ]) {
    assert.equal(isPrivateAddress(ip), true, `${ip} must be treated as non-public`);
  }
  // A mapped *public* address is still a routable address and stays allowed,
  // so this is a real comparison rather than a blanket IPv6 rejection.
  assert.equal(isPrivateAddress('::ffff:0808:0808'), false, '::ffff:8.8.8.8 is public');
  assert.equal(isPrivateAddress('2606:4700::1111'), false, 'a public IPv6 must be allowed');
});

test('every IPv4-mapped spelling is rejected at the URL layer, which is the only layer that matters', async () => {
  // Asserted through assertSafeOutboundUrl, not isPrivateAddress: the bypass
  // lived in the gap between what the guard matched and what new URL() emits,
  // so only the URL-level assertion can fail if that gap reopens.
  for (const url of [
    'http://[::ffff:169.254.169.254]/latest/meta-data/iam/security-credentials/',
    'http://[::ffff:127.0.0.1]:6379/',
    'http://[::ffff:10.0.0.1]/',
    'http://[::7f00:1]/',
    'http://[::a9fe:a9fe]/latest/meta-data/',
    'http://[0:0:0:0:0:ffff:7f00:1]/',
  ]) {
    await assert.rejects(
      () => assertSafeOutboundUrl(url),
      (err: unknown) => err instanceof UnsafeOutboundUrlError,
      `expected ${url} to be rejected`,
    );
  }
});

test('unsafe webhook destinations are rejected', async () => {
  for (const url of [
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'http://127.0.0.1:3001/admin/stats',
    'http://localhost:3001/admin/stats',
    'http://[::1]:3001/',
    'http://[::ffff:127.0.0.1]:3001/admin/stats',
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
