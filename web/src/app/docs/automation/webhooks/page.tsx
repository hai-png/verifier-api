import { DocH, DocLead, DocH2, DocP, Code, Endpoint, Next, API_HOST } from "@/components/Docs";

export default function Webhooks() {
  return (
    <>
      <DocH>Webhooks</DocH>
      <DocLead>Push workspace events to your app with signed deliveries and retries.</DocLead>

      <Endpoint method="GET" path="/webhooks" desc="List webhooks." />
      <Endpoint method="POST" path="/webhooks" desc="Create: { url, events[] }. Returns a signing secret — shown once." />
      <Endpoint method="POST" path="/webhooks/:id/rotate-secret" desc="Rotate the signing secret." />
      <Endpoint method="GET" path="/webhooks/:id/deliveries" desc="Delivery history with status and attempts." />
      <Endpoint method="POST" path="/webhooks/:id/retry/:deliveryId" desc="Re-queue a failed delivery." />

      <DocH2>Verifying signatures</DocH2>
      <DocP>
        Every delivery carries an <code>X-Veritas-Signature</code> header in the form
        <code>t=&lt;unix seconds&gt;,v1=&lt;hex&gt;</code>, alongside an{' '}
        <code>X-Veritas-Timestamp</code> header with the same value. The signature is
        HMAC-SHA256 over <code>&lt;timestamp&gt;.&lt;raw body&gt;</code> using your
        webhook&apos;s signing secret.
      </DocP>
      <DocP>
        The timestamp is part of the signed material on purpose. Earlier deliveries
        signed the body alone, which meant a captured request stayed valid forever —
        replaying it was indistinguishable from a genuine retry. Rejecting anything
        outside your tolerance window is what closes that gap; the tolerance also
        absorbs clock skew and delivery retries.
      </DocP>
      <DocP>
        Verify against the raw body exactly as received, before any JSON parsing or
        middleware touches it.
      </DocP>
      <Code
        code={`const crypto = require('crypto');

const TOLERANCE_SECONDS = 300;
const rawBody = require('raw-body')(req);
const header = req.headers['x-veritas-signature'] ?? '';

// t=<unix seconds>,v1=<hex>
const parts = Object.fromEntries(
  header.split(',').map((pair) => pair.split(/=(.*)/s).slice(0, 2)),
);

const timestamp = Number(parts.t);
if (!Number.isFinite(timestamp)) return res.sendStatus(401);
if (Math.abs(Date.now() / 1000 - timestamp) > TOLERANCE_SECONDS) return res.sendStatus(401);

const expected = crypto
  .createHmac('sha256', process.env.WEBHOOK_SECRET)
  .update(\`\${parts.t}.\${rawBody}\`)
  .digest('hex');

const a = Buffer.from(parts.v1 ?? '', 'hex');
const b = Buffer.from(expected, 'hex');
if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.sendStatus(401);

const event = JSON.parse(rawBody);`}
      />
<DocP>
        <code>X-Veritas-Legacy-Signature</code> is <strong>off by default</strong>. It is only
        emitted when the server is started with <code>WEBHOOK_LEGACY_SIGNATURE=true</code>, and the
        server logs a warning when it is. If your receiver still validates the old
        <code>sha256=&lt;hex&gt;</code> header over the body alone, that header will be absent
        until it is enabled explicitly — migrate to the timestamped form above rather than relying
        on it continuing to arrive.
      </DocP>
      <DocP>
        A valid signature still does not make a delivery safe to act on twice: the
        receiver&apos;s own retry or a queued redelivery will present a fresh valid
        signature for an event already handled. Dedupe on something you already
        track, such as the payment reference, in addition to checking the signature.
      </DocP>
      <DocH2>Retries</DocH2>
      <DocP>
        Failed deliveries retry automatically (up to 4 attempts with backoff), then move to the
        dead-letter state where you can replay them from the dashboard or the retry endpoint.
      </DocP>
      <Next href="/docs/automation/notifications" label="Notifications" />
    </>
  );
}
