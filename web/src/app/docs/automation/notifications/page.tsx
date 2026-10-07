import { DocH, DocLead, DocH2, DocP, Code, Endpoint, Next, API_HOST } from "@/components/Docs";

export default function Notifications() {
  return (
    <>
      <DocH>Notifications</DocH>
      <DocLead>Workspace event alerts over email and Telegram.</DocLead>

      <Endpoint method="GET" path="/notifications" desc="List channels with delivery stats." />
      <Endpoint method="POST" path="/notifications" desc="Create: { type: EMAIL|TELEGRAM, destination, events[] }." />
      <Endpoint method="PATCH" path="/notifications/:id" desc="Update destination, events or active state." />
      <Endpoint method="DELETE" path="/notifications/:id" desc="Delete a channel." />
      <Endpoint method="POST" path="/notifications/:id/test" desc="Queue a test delivery. Requires the queue backend." />

      <DocH2>Event names</DocH2>
      <DocP>
        These are the complete set. An unrecognised name — including{" "}
        <Code code="order.paid" inline />, which is a natural guess but does not exist — fails the
        whole request with <Code code="400" inline /> rather than being ignored:
      </DocP>
      <Code
        code={`payment_link.paid      a payment link was paid and the order recorded
product.sold_out        a product hit its stock limit
verification.success    a receipt verified
verification.failed     a receipt failed to verify
webhook.dead_letter     a webhook exhausted its delivery attempts`}
      />
      <DocP>
        <Code code="webhook.dead_letter" inline /> reaches notification channels but is deliberately{" "}
        <strong>not</strong> delivered to webhooks. Routing it to a webhook that is itself subscribed
        would let one failing endpoint generate an endless chain of new dead-letter events. A webhook
        subscribed to it receives nothing, silently.
      </DocP>

      <DocH2>Creating a channel</DocH2>
      <Code
        code={`curl -X POST ${API_HOST}/notifications \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: $VERIFIER_API_KEY" \\
  -d '{
    "type": "TELEGRAM",
    "destination": "123456789",
    "events": ["payment_link.paid", "verification.failed"]
  }'`}
      />
      <DocH2>Destinations</DocH2>
      <DocP>
        EMAIL channels take a valid email address; TELEGRAM takes a chat ID (
        <Code code="123456789" inline />) or username (<Code code="@yourchannel" inline />). Active-channel
        limits depend on plan.
      </DocP>

      <DocH2>Delivery needs the queue backend</DocH2>
      <DocP>
        Notifications are delivered through the same queue as webhooks, so they are unavailable when{" "}
        <Code code="REDIS_URL" inline /> is unset or its backend is unreachable. In that state{" "}
        <Code code="POST /notifications/:id/test" inline /> returns <Code code="500" inline /> rather
        than queueing anything. Verification endpoints are unaffected — see{" "}
        <a href="/docs/reference/operations" className="underline font-medium">Operations</a>.
      </DocP>
      <Next href="/docs/tools/cbe-qr" label="CBE receipt URLs" />
    </>
  );
}