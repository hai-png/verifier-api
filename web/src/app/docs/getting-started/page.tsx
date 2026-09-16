import { DocH, DocLead, DocH2, DocP, Code, Next, API_HOST } from "@/components/Docs";

export default function GettingStarted() {
  return (
    <>
      <DocH>Getting started</DocH>
      <DocLead>From zero to your first verified payment in four steps.</DocLead>

      <DocH2>1. Create an account</DocH2>
      <DocP>
        Open the dashboard and sign up. You get a workspace with 100 free monthly verifications —
        no card required.
      </DocP>

      <DocH2>2. Add a payout account</DocH2>
      <DocP>
        In your workspace, open <strong>Payouts</strong> and add where your money lands (e.g. your
        Telebirr number or CBE account). Use exactly one payout account per provider so incoming
        payments can be matched unambiguously.
      </DocP>

      <DocH2>3. Create an API key</DocH2>
      <DocP>
        Open <strong>API Keys → Create</strong>. The raw key is shown once — copy it into your
        server environment as <code>VERIFIER_API_KEY</code>.
      </DocP>

      <DocH2>4. Verify your first payment</DocH2>
      <Code
        code={`curl -X POST ${API_HOST}/verify \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: $VERIFIER_API_KEY" \\
  -d '{"reference": "PASTE_A_REAL_RECEIPT_NO"}'`}
      />
      <DocP>A successful verification returns the payer, amount, and transaction status:</DocP>
      <Code
        code={`{
  "success": true,
  "data": {
    "payerName": "Abebe K.",
    "amount": 299,
    "transactionStatus": "Completed",
    "receiptNo": "PASTE_A_REAL_RECEIPT_NO"
  }
}`}
      />
      <Next href="/docs/authentication" label="Authentication" />
    </>
  );
}
