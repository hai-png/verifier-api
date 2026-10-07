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
        desc="Smart router. Body: { reference, suffix?, phoneNumber?, provider?, payoutAccountId?, expectedAmount? }. suffix = the payer's CBE account tail; phoneNumber = buyer phone (CBE Birr)."
      />
      <Code
        code={`curl -X POST ${API_HOST}/verify \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: $VERIFIER_API_KEY" \\
  -d '{"reference": "FT74A19B2C3D", "suffix": "12345678"}'`}
      />

      <DocH2>Enforcing who and how much</DocH2>
      <DocP>
        Two optional fields turn a successful lookup into a checked one, and both are accepted on
        every endpoint on this page as well as on <Code code="/verify-image" inline />:
      </DocP>
      <Code
        code={`payoutAccountId   the account that must have been credited. Taken from your
               payout accounts in the dashboard — see "Payout accounts".
               A mismatch is refused, never passed.
expectedAmount    the net amount that must have arrived. Compared against
               what the recipient actually received, after the provider's
               service fee. See "Amount checks".`}
      />
      <DocP>
        A payout account can also be bound to the API key as its default, so per-request values are
        unnecessary for a single-account merchant. A <Code code="payoutAccountId" inline /> on the
        request overrides the bound default. The account must belong to the calling key&apos;s own
        workspace, and must accept the provider the receipt turns out to be from.
      </DocP>
      <DocP>
        Also accepted on <Code code="/verify" inline />: <Code code="receiptNumber" inline /> as an alias for{" "}
        <Code code="reference" inline />, <Code code="accountSuffix" inline /> for <Code code="suffix" inline />,
        and <Code code={'provider: "auto"'} inline /> to request detection explicitly.
      </DocP>

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
      <Endpoint method="POST" path="/verify/public" desc="Browser-safe public verification. No API key; 10 requests/hour/IP, no quota consumed, no webhook fired." />

      <DocH2>Quotas & limits</DocH2>
      <DocP>
        Each call consumes one monthly verification credit from the key&apos;s workspace when the
        provider lookup is attempted (HTTP 402 when exhausted). A lookup that returns &ldquo;receipt
        not found&rdquo; is still billed, because the upstream query was made. Errors that never
        reach a provider (400, 413, 415) and gateway failures (500, 503) are refunded; 404, 422 and
        502 are not. Per-minute rate limits apply per key. See{" "}
        <a href="/docs/reference/plans" className="underline font-medium">
          Plans &amp; limits
        </a>
        .
      </DocP>
      <Next href="/docs/verification/batch" label="Batch verification" />
    </>
  );
}