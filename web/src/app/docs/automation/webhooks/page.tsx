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
        Every delivery carries an <code>X-Veritas-Signature</code> header: HMAC-SHA256 of the raw
        request body with your webhook&apos;s signing secret, prefixed <code>sha256=</code>.
        Reject anything that doesn&apos;t match before processing.
      </DocP>
      <DocP>
        Compare in constant time and strip the prefix. The example shipped here previously did
        neither: it compared the bare hex digest against the prefixed header, so as written it
        rejected every delivery it was copied into.
      </DocP>
      <Code
        code={`const crypto = require('crypto');
const signature = req.headers['x-veritas-signature'] ?? '';
const expected = 'sha256=' + crypto
  .createHmac('sha256', process.env.WEBHOOK_SECRET)
  .update(rawBody)
  .digest('hex');

const a = Buffer.from(signature);
const b = Buffer.from(expected);
if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.sendStatus(401);

// The signature proves the body is yours. It does NOT stop someone replaying a
// delivery they captured earlier — there is no timestamp in the signed material
// — so dedupe on something you already track, such as the payment reference,
// before acting on a payment_link.paid event.`}
      />
      <DocH2>Retries</DocH2>
      <DocP>
        Failed deliveries retry automatically (up to 4 attempts with backoff), then move to the
        dead-letter state where you can replay them from the dashboard or the retry endpoint.
      </DocP>
      <Next href="/docs/automation/notifications" label="Notifications" />
    </>
  );
}
