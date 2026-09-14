import { DocH, DocLead, DocH2, DocP, Code, Endpoint, Next, API_HOST } from "@/components/Docs";

export default function Notifications() {
  return (
    <>
      <DocH>Notifications</DocH>
      <DocLead>Workspace event alerts over email and Telegram.</DocLead>

      <Endpoint method="GET" path="/notifications" desc="List channels with delivery stats." />
      <Endpoint method="POST" path="/notifications" desc="Create: { type: EMAIL|TELEGRAM, destination, events[] }." />
      <Endpoint method="POST" path="/notifications/:id/test" desc="Queue a test delivery." />

      <Code
        code={`curl -X POST ${API_HOST}/notifications \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: $VERIFIER_API_KEY" \\
  -d '{
    "type": "TELEGRAM",
    "destination": "123456789",
    "events": ["order.paid"]
  }'`}
      />
      <DocH2>Destinations</DocH2>
      <DocP>
        EMAIL channels take a valid email address; TELEGRAM takes a chat ID (
        <code>123456789</code>) or username (<code>@yourchannel</code>). Events use the same
        workspace event names as webhooks. Active-channel limits depend on plan.
      </DocP>
      <Next href="/docs/tools/cbe-qr" label="CBE receipt URLs" />
    </>
  );
}
