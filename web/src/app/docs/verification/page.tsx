import { DocH, DocLead, DocH2, DocP, Code, Endpoint, Next, API_HOST } from "@/components/Docs";

export default function Verification() {
  return (
    <>
      <DocH>Single & universal verification</DocH>
      <DocLead>
        Send one reference; the universal route detects the provider from the receipt format.
      </DocLead>

      <Endpoint
        method="POST"
        path="/verify"
        desc="Smart router. Body: { reference, suffix?, phoneNumber? }. suffix = receiving-account tail (CBE/Abyssinia legacy); phoneNumber = buyer phone (CBE Birr)."
      />
      <Code
        code={`curl -X POST ${API_HOST}/verify \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: $VERIFIER_API_KEY" \\
  -d '{"reference": "FT123ABC456", "suffix": "12345678"}'`}
      />

      <DocH2>Provider-specific endpoints</DocH2>
      <DocP>Use these when you already know the provider — same body shape, same auth:</DocP>
      <Endpoint method="POST" path="/verify-telebirr" desc="Telebirr receipt numbers." />
      <Endpoint method="POST" path="/verify-cbe" desc="CBE legacy FT + suffix and new token/URL receipts." />
      <Endpoint method="POST" path="/verify-cbebirr" desc="CBE Birr (needs buyer phoneNumber)." />
      <Endpoint method="POST" path="/verify-dashen" desc="Dashen Bank references." />
      <Endpoint method="POST" path="/verify-abyssinia" desc="Bank of Abyssinia references." />
      <Endpoint method="POST" path="/verify-mpesa" desc="M-Pesa transaction IDs." />
      <Endpoint method="POST" path="/verify-awash" desc="Awash Bank references." />
      <Endpoint method="POST" path="/verify-zemen" desc="Zemen Bank references." />

      <DocH2>Quotas & limits</DocH2>
      <DocP>
        Each successful call consumes one monthly verification credit from the key&apos;s workspace
        (HTTP 402 when exhausted). Per-minute rate limits apply per key. See{" "}
        <a href="/docs/reference/plans" className="underline">
          Plans & limits
        </a>
        .
      </DocP>
      <Next href="/docs/verification/batch" label="Batch verification" />
    </>
  );
}
