import { DocH, DocLead, DocH2, DocP, Code, Next, API_HOST } from "@/components/Docs";

export default function CbeQr() {
  return (
    <>
      <DocH>CBE receipt references</DocH>
      <DocLead>
        CBE receipts come in two formats, and getting the shape right decides whether a receipt is
        routed to CBE or quietly sent to a different bank.
      </DocLead>

      <DocH2>New format: token or receipt URL</DocH2>
      <DocP>
        Recent CBE receipts and QR scans resolve to a token or a receipt URL. Pass it as the{" "}
        <Code code="reference" inline /> and the format is detected automatically — no suffix needed.
      </DocP>
      <Code
        code={`# a bare token: 15–40 alphanumeric characters, not starting with "FT"
curl -X POST ${API_HOST}/verify \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: $VERIFIER_API_KEY" \\
  -d '{"reference": "kQ7bN2pX9dL4mR8wT1vY6zA3"}'

# or the full receipt URL — host mbreciept.cbe.com.et, path segment only
curl -X POST ${API_HOST}/verify \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: $VERIFIER_API_KEY" \\
  -d '{"reference": "https://mbreciept.cbe.com.et/kQ7bN2pX9dL4mR8wT1vY6zA3"}'`}
      />
      <DocP>
        The URL must be exactly that host with the token as its only path segment. A query string
        such as <Code code="?token=…" inline /> is not accepted and the value falls through to
        auto-detection, which sends a 20-character string to Awash or Zemen rather than CBE.
      </DocP>

      <DocH2>Legacy format: FT reference plus account suffix</DocH2>
      <DocP>
        Older receipts show an FT reference only. It is <strong>FT followed by exactly 10
        characters — 12 in total</strong>. Pair it with the payer&apos;s 8-digit CBE account suffix (the
        digits after the <Code code="1000" inline /> prefix) as <Code code="suffix" inline />, which is
        part of CBE&apos;s receipt lookup key:
      </DocP>
      <Code
        code={`curl -X POST ${API_HOST}/verify-cbe \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: $VERIFIER_API_KEY" \\
  -d '{"reference": "FT74A19B2C3D", "suffix": "12345678"}'`}
      />
      <DocP>
        The suffix is the <strong>payer&apos;s</strong> account, not the merchant&apos;s receiving
        account. CBE keys its legacy receipt lookup on the sender, so submitting your own account
        number here looks up a different receipt and returns 404. The merchant&apos;s account belongs
        in the payout account you pass as <Code code="payoutAccountId" inline />.
      </DocP>

      <DocH2>Why length matters</DocH2>
      <DocP>
        Auto-detection recognises a 12-character <Code code="FT…" inline /> reference as CBE and a
        9-digit one as Telebirr. A reference that is one character short matches neither, and is
        routed as a generic long reference to Awash or Zemen — so a malformed CBE reference does not
        fail loudly, it fails against the wrong bank. If a CBE receipt is being verified against a
        provider that is not CBE, check the character count first.
      </DocP>

      <DocH2>Pasted combined IDs</DocH2>
      <DocP>
        Some receipts print the reference and account tail together. A single unbroken string of 20
        digits is split automatically — CBE takes an 8-digit tail, Bank of Abyssinia a 5-digit one —
        so it can be pasted as-is.
      </DocP>
      <Code
        code={`# FT + 10 characters + 8 digits, pasted as one string
curl -X POST ${API_HOST}/verify \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: $VERIFIER_API_KEY" \\
  -d '{"reference": "FT74A19B2C3D12345678"}'`}
      />
      <Next href="/docs/reference/providers" label="Providers reference" />
    </>
  );
}