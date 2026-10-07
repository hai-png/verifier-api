import { DocH, DocLead, DocH2, DocP, Code, Endpoint, Next, API_HOST } from "@/components/Docs";

export default function Batch() {
  return (
    <>
      <DocH>Batch verification</DocH>
      <DocLead>Submit references together; get an individual result for every item.</DocLead>

      <Endpoint
        method="POST"
        path="/verify-batch"
        desc="Body: { references: BatchItem[] }. Max batch size depends on plan. Requires the verify-batch permission."
      />
      <DocH2>Each item is an object, not a string</DocH2>
      <DocP>
        <Code code="references" inline /> holds an array of objects, one per receipt. A bare array
        of strings is rejected with <Code code="400 Verification input must be an object." inline />
        for every item, so the older-looking shape does not work.
      </DocP>
      <Code
        code={`curl -X POST ${API_HOST}/verify-batch \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: $VERIFIER_API_KEY" \\
  -d '{"references": [
        {"reference": "FT74A19B2C3D"},
        {"reference": "FT74A19B2C3E", "suffix": "12345678"},
        {"reference": "912345678", "provider": "telebirr"},
        {"reference": "TXN99331", "provider": "zemen"}
      ]}'`}
      />
      <DocP>
        Only <Code code="reference" inline /> is required. The rest exist because a receipt is not
        always enough on its own to find the transaction:
      </DocP>
      <Code
        code={`reference      the receipt reference                     required
suffix         8-digit account suffix, for legacy CBE FT receipts
phoneNumber    the payer's phone number, for mobile-money providers
provider       force a provider instead of auto-detecting — one of:
               telebirr, cbe, cbebirr, dashen, abyssinia, mpesa,
               awash, zemen`}
      />
      <DocP>
        <Code code="provider" inline /> is what lets you submit a receipt whose format is ambiguous.
        A 12-character <Code code="FT…" inline /> reference is recognised as CBE automatically, and
        a 9-digit one as Telebirr, but naming the provider removes the guesswork entirely. The
        aliases <Code code="m-pesa" inline />, <Code code="cbe-birr" inline /> and{" "}
        <Code code="cbe_birr" inline /> are also accepted.
      </DocP>

      <DocH2>Response</DocH2>
      <DocP>
        Returns one result object per input item in order, each with its own{" "}
        <Code code="success" inline /> flag — a failed item never fails the whole batch. Every
        processed reference consumes a verification credit individually, including items that return
        &ldquo;receipt not found&rdquo;: the lookup is billed whether or not the provider recognises
        the receipt.
      </DocP>

      <DocH2>Permissions</DocH2>
      <DocP>
        Requires the <Code code="verify-batch" inline /> permission. API keys created from the
        dashboard are issued <Code code="verify" inline /> and <Code code="webhooks" inline /> only,
        so a key made through the UI receives <Code code="403" inline /> on this endpoint until its
        permissions are changed.
      </DocP>
      <Next href="/docs/verification/image" label="Receipt image verification" />
    </>
  );
}