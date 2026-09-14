import { DocH, DocLead, DocH2, DocP, Code, Next, API_HOST } from "@/components/Docs";

export default function DocsOverview() {
  return (
    <>
      <DocH>Add Ethiopian payment verification to your app.</DocH>
      <DocLead>
        Get an API key from the dashboard, verify payment receipts from your server, and expand
        into batch processing, receipt images, products, payment links, orders, and automation.
      </DocLead>

      <DocH2>Implementation path</DocH2>
      <DocP>
        <strong>01 — Create an API key.</strong> Create a workspace key in the dashboard and store
        it in your server environment, never in client-side code.
      </DocP>
      <DocP>
        <strong>02 — Make one verification.</strong> Send a payment reference to the universal
        verification endpoint and handle the result.
      </DocP>
      <DocP>
        <strong>03 — Choose your workflow.</strong> Add batch or image verification, or build a
        hosted commerce flow with payment links.
      </DocP>
      <DocP>
        <strong>04 — Prepare for production.</strong> Handle provider failures, protect secrets,
        and use webhooks for reliable background updates.
      </DocP>

      <DocH2>API conventions</DocH2>
      <DocP>
        The examples use the hosted API at <code>{API_HOST}</code>. Send your API key through the{" "}
        <code>x-api-key</code> header. JSON routes use <code>application/json</code>; receipt-image
        verification uses multipart form data.
      </DocP>
      <DocP>
        Inspect both the HTTP status and the JSON body. Every error uses the{" "}
        <code>{"{ success: false, error }"}</code> envelope.
      </DocP>
      <Code
        code={`curl -X POST ${API_HOST}/verify \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: sk_live_YOUR_KEY" \\
  -d '{"reference": "FT123ABC456"}'`}
      />
      <Next href="/docs/getting-started" label="Getting started" />
    </>
  );
}
