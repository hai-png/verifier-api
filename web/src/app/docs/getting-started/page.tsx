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
      <DocP>
        This is where you will find the account IDs the API refers to. Each payout account has an{" "}
        <Code code="id" inline /> — that is the value you pass as{" "}
        <Code code="payoutAccountId" inline /> to hold a verification to your account, and as{" "}
        <Code code="payoutAccountIds" inline /> on a payment link. Copy it from the Payouts page; there
        is no endpoint that lists them without authentication, so the dashboard is the intended
        place to read it. See <a href="/docs/commerce/payout-accounts" className="underline font-medium">Payout accounts</a>.
      </DocP>

      <DocH2>3. Create an API key</DocH2>
      <DocP>
        Open <strong>API Keys → Create</strong>. The raw key is shown once — copy it into your
        server environment as <Code code="VERIFIER_API_KEY" inline />.
      </DocP>
      <DocP>
        Keys created here are issued the <Code code="verify" inline /> and <Code code="webhooks" inline />{" "}
        permissions. <Code code="/verify-batch" inline /> and <Code code="/verify-image" inline /> need
        permissions that are not granted by default, so a new key receives <Code code="403" inline /> on
        those two endpoints until you change its permissions.
      </DocP>

      <DocH2>4. Verify your first payment</DocH2>
      <Code
        code={`curl -X POST ${API_HOST}/verify \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: $VERIFIER_API_KEY" \\
  -d '{"reference": "PASTE_A_REAL_RECEIPT_NO"}'`}
      />
      <DocP>
        The <Code code="data" inline /> object is the provider&apos;s own response, so its fields depend
        on which provider the reference resolved to. A Telebirr receipt returns strings for its
        money fields, because Telebirr distinguishes what was charged from what settled:
      </DocP>
      <Code
        code={`{
  "success": true,
  "data": {
    "receiptNo": "FTK9ABCD12",
    "payerName": "Abebe K.",
    "payerTelebirrNo": "251911223344",
    "receiverName": "Noveld Trading",
    "totalPaidAmount": "801.00 Birr",
    "settledAmount": "797.00 Birr"
  }
}`}
      />
      <DocP>
        A CBE receipt instead returns <Code code="amount" inline /> as a number alongside{" "}
        <Code code="payer" inline />, <Code code="receiver" inline />, <Code code="date" inline /> and{" "}
        <Code code="reference" inline />. There is no single field set that fits every provider — read{" "}
        <a href="/docs/reference/providers" className="underline font-medium">Providers</a> for the
        shape each one returns.
      </DocP>
      <DocP>
        Note that <Code code="settledAmount" inline /> and <Code code="amount" inline /> are not
        interchangeable with what the payer was charged. If you are checking the amount, send{" "}
        <Code code="expectedAmount" inline /> and compare against the net received — see{" "}
        <a href="/docs/reference/amounts" className="underline font-medium">Amount checks</a>.
      </DocP>
      <Next href="/docs/authentication" label="Authentication" />
    </>
  );
}