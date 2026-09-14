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
        request body with your webhook&apos;s signing secret. Reject anything that doesn&apos;t
        match before processing.
      </DocP>
      <Code
        code={`const crypto = require('crypto');
const expected = crypto
  .createHmac('sha256', process.env.WEBHOOK_SECRET)
  .update(rawBody)
  .digest('hex');
if (expected !== req.headers['x-veritas-signature']) return res.sendStatus(401);`}
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
