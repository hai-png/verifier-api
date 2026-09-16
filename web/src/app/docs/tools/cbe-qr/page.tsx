import { DocH, DocLead, DocH2, DocP, Code, Next, API_HOST } from "@/components/Docs";

export default function CbeQr() {
  return (
    <>
      <DocH>CBE receipt URLs</DocH>
      <DocLead>CBE receipts come in two formats — both verify through the same endpoints.</DocLead>

      <DocH2>New format: token / full receipt URL</DocH2>
      <DocP>
        Recent CBE receipts (and QR scans) resolve to a token or full receipt URL. Pass it as the{" "}
        <code>reference</code> — the router detects the format automatically, no suffix needed:
      </DocP>
      <Code
        code={`curl -X POST ${API_HOST}/verify \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: $VERIFIER_API_KEY" \\
  -d '{"reference": "https://…cbe-receipt…token=abc123"}'`}
      />

      <DocH2>Legacy format: FT number + account suffix</DocH2>
      <DocP>
        Older receipts show an FT reference only. Pair it with the last 8 digits of the payer&apos;s
        CBE account (the digits after the <code>1000</code> prefix) as <code>suffix</code>. The
        suffix is part of CBE&apos;s receipt lookup key:
      </DocP>
      <Code
        code={`curl -X POST ${API_HOST}/verify-cbe \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: $VERIFIER_API_KEY" \\
  -d '{"reference": "FT123ABC456", "suffix": "12345678"}'`}
      />
      <Next href="/docs/reference/providers" label="Providers reference" />
    </>
  );
}
