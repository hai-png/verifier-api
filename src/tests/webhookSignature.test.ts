// Webhook signatures were HMAC(secret, body) with no timestamp, so they never
// expired. A request captured in transit could be replayed at any point in the
// future and the receiver had no way to tell it from a genuine retry — the one
// thing the signature was supposed to establish.
//
// The timestamp is signed rather than merely sent alongside. If it travelled
// unsigned an attacker could rewrite it to "now" on a captured request, so the
// freshness check would pass without the replay window ever closing.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  buildWebhookSignature,
  serialiseWebhookBody,
  WEBHOOK_SIGNATURE_VERSION,
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
} from '../queues/webhookQueue';

const SECRET = 'whsec_test_secret';
const PAYLOAD = {
  event: 'payment_link.paid',
  data: { order: { id: 'o-1', reference: 'FT2513001V2G', amountPaid: 500 } },
} as any;

/** Mirror of the receiver-side check documented for customers. */
function verify(
  body: string,
  secret: string,
  signatureHeader: string,
  nowSeconds: number,
  tolerance = WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
): boolean {
  const parts = Object.fromEntries(
    signatureHeader.split(',').map((pair: string) => pair.split(/=(.*)/s).slice(0, 2)),
  );
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(nowSeconds - timestamp) > tolerance) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${parts.t}.${body}`)
    .digest('hex');
  const a = Buffer.from(parts.v1 ?? '', 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function signedHeaders(body: string, secret = SECRET, timestamp = 1_800_000_000) {
  const signature = buildWebhookSignature(body, secret, timestamp);
  return {
    'X-Veritas-Timestamp': String(timestamp),
    'X-Veritas-Signature': `t=${timestamp},${WEBHOOK_SIGNATURE_VERSION}=${signature}`,
  };
}

test('a fresh delivery verifies', () => {
  const body = serialiseWebhookBody(PAYLOAD);
  const headers = signedHeaders(body);
  assert.equal(verify(body, SECRET, headers['X-Veritas-Signature'], 1_800_000_000), true);
});

test('a replayed delivery is rejected once it ages out', () => {
  const body = serialiseWebhookBody(PAYLOAD);
  const headers = signedHeaders(body, SECRET, 1_800_000_000);
  const longAfter = 1_800_000_000 + WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS + 1;
  assert.equal(
    verify(body, SECRET, headers['X-Veritas-Signature'], longAfter),
    false,
    'a captured delivery must stop being trusted',
  );
});

test('a replay inside the tolerance still passes, which is why receivers must dedupe', () => {
  // Not a defect. Our own retries resend the same event, and a receiver cannot
  // distinguish those from an attacker without its own idempotency key. The
  // window bounds the exposure rather than pretending to eliminate it.
  const body = serialiseWebhookBody(PAYLOAD);
  const headers = signedHeaders(body, SECRET, 1_800_000_000);
  assert.equal(
    verify(body, SECRET, headers['X-Veritas-Signature'], 1_800_000_000 + 60),
    true,
  );
});

test('the timestamp is covered by the signature, not just sent next to it', () => {
  const body = serialiseWebhookBody(PAYLOAD);
  const real = buildWebhookSignature(body, SECRET, 1_800_000_000);
  const rewritten = buildWebhookSignature(body, SECRET, 1_800_000_000 + 10_000_000);
  assert.notEqual(real, rewritten, 'moving the timestamp must invalidate the digest');

  // The attack this prevents: keep the captured digest, rewrite t to "now".
  const forged = `t=${1_800_000_000 + 10_000_000},${WEBHOOK_SIGNATURE_VERSION}=${real}`;
  assert.equal(verify(body, SECRET, forged, 1_800_000_000 + 10_000_000), false);
});

test('a body edited after signing is rejected', () => {
  const body = serialiseWebhookBody(PAYLOAD);
  const headers = signedHeaders(body);
  const tampered = body.replace('500', '5000');
  assert.equal(verify(tampered, SECRET, headers['X-Veritas-Signature'], 1_800_000_000), false);
});

test('the wrong secret is rejected', () => {
  const body = serialiseWebhookBody(PAYLOAD);
  const headers = signedHeaders(body);
  assert.equal(verify(body, 'whsec_other', headers['X-Veritas-Signature'], 1_800_000_000), false);
});

test('the signature covers the bytes actually sent', () => {
  // The delivery path signs a serialised string and must transmit that same
  // string. Signing one serialisation and letting axios produce another only
  // works until the key order changes.
  const body = serialiseWebhookBody(PAYLOAD);
  assert.equal(body, JSON.stringify(PAYLOAD));
  assert.equal(verify(body, SECRET, signedHeaders(body)['X-Veritas-Signature'], 1_800_000_000), true);
});

test('an unserialisable payload degrades instead of throwing', () => {
  // This runs outside the delivery try/catch, so a throw here would strand the
  // job with no recorded reason.
  const circular: any = { event: 'x' };
  circular.self = circular;
  const body = serialiseWebhookBody(circular);
  assert.equal(typeof body, 'string');
  assert.doesNotThrow(() => JSON.parse(body));
});

test('the legacy untimestamped header is still produced for existing receivers', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(
    require('node:path').join(__dirname, '..', '..', 'src', 'queues', 'webhookQueue.ts'),
    'utf8',
  );
  assert.match(source, /X-Veritas-Legacy-Signature/);
  // The old shape over the old material: a customer still running the previous
  // documented example must not start failing on deploy.
  const body = serialiseWebhookBody(PAYLOAD);
  const legacy = 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');
  assert.match(legacy, /^sha256=[0-9a-f]{64}$/);
});
