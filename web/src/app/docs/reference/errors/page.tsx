import { DocH, DocLead, DocH2, DocP, Code } from "@/components/Docs";

const ROWS: [string, string][] = [
  ["400", "Bad request — missing/invalid parameters. Fix the payload."],
  ["401", "No API key or session presented at all."],
  ["402", "Quota exhausted or feature not in plan. Top up or upgrade."],
  ["403", "API key invalid, or lacks the required permission."],
  ["404", "Unknown receipt / resource. Confirm the reference."],
  ["409", "Conflict — reference already used, sold out, or duplicate."],
  ["413", "Upload too large (receipt images are capped at 2 MB)."],
  ["415", "Unsupported upload type — receipt images accept JPEG, PNG or WebP."],
  ["422", "Provider understood the request but rejected it (e.g. recipient mismatch, unreadable image)."],
  ["429", "Rate limit or public-verify throttle. Back off per retryAfter."],
  ["500", "Server error. Retry with backoff; contact support if persistent."],
  ["502", "Upstream provider unreachable (relays exhausted). Retry later."],
  ["503", "Cold start or database unavailable. Honour Retry-After."],
];

export default function Errors() {
  return (
    <>
      <DocH>Errors & retries</DocH>
      <DocLead>One envelope, predictable codes, safe retry rules.</DocLead>

      <DocP>
Errors generally look like <Code code={"{ success: false, error }"} inline />, sometimes with
        extra fields (<Code code="reason" inline />, <Code code="details" inline />,{" "}
        <Code code="retryAfter" inline />). Two exceptions worth knowing: receipt image verification
        uses <Code code={"{ verified: false, error }"} inline />, and the legacy Dashen, M-Pesa,
        Awash, Zemen and CBE Birr routes return the provider&apos;s own payload unchanged.
      </DocP>

      <div className="border rounded-md overflow-hidden mb-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted text-left">
              <th className="p-2">Status</th>
              <th className="p-2">Meaning & action</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map(([code, desc]) => (
              <tr key={code} className="border-t">
                <td className="p-2 font-mono font-bold">{code}</td>
                <td className="p-2">{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <DocP>
        An invalid API key is <Code code="403" inline />, not <Code code="401" inline />. Only a completely
        absent credential is <Code code="401" inline />, which distinguishes &ldquo;forgot the header&rdquo;
        from &ldquo;rotated the key&rdquo; without reading the body.
      </DocP>

      <DocH2>Reason codes</DocH2>
      <DocP>
        A verification can succeed as a lookup and still be refused. Branch on{" "}
        <Code code="reason" inline /> rather than matching the <Code code="error" inline /> prose:
      </DocP>
      <table className="w-full text-sm">
        <tbody>
          {[
            ['RECIPIENT_MISMATCH', 'The receipt names a different account or payee. Do not issue.'],
            ['RECIPIENT_NOT_VERIFIABLE', 'The receipt shows no destination account or receiver name that can be matched, so it cannot be confirmed either way. Do not issue.'],
            ['PROVIDER_NOT_ALLOWED', 'The selected payout account does not accept that provider. Choose another account or omit it.'],
            ['AMOUNT_MISMATCH', 'The provider reported an amount, and it was not the expected one.'],
            ['AMOUNT_NOT_VERIFIABLE', 'No amount could be established at all. Never treat this as a pass.'],
            ['BUYER_PHONE_REQUIRED', 'The provider reports a payer phone number and none was supplied.'],
            ['BUYER_PHONE_MISMATCH', 'The payer number on the receipt is not the one supplied.'],
          ].map(([code, desc]) => (
            <tr key={code} className="border-t">
              <td className="p-2 font-mono text-xs align-top whitespace-nowrap">{code}</td>
              <td className="p-2">{desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <DocP>
        On reference verification a recipient or amount refusal comes back as <Code code="200" inline />{" "}
        with <Code code="success:false" inline /> and a <Code code="reason" inline />, because the provider
        lookup itself succeeded. Receipt image verification uses <Code code="422" inline /> for the same
        conditions.
      </DocP>
      <DocP>
        A successful response with no <Code code="expectedAmount" inline /> supplied carries{" "}
        <Code code="amountChecked: false" inline />. The recipient check says <em>who</em> was paid, never{" "}
        <em>how much</em> — see{" "}
        <a href="/docs/reference/amounts" className="underline font-medium">Amount checks</a>.
      </DocP>

      <DocH2>Retry strategy</DocH2>
      <DocP>Retry 429 / 502 / 500 with exponential backoff + jitter (1s → 2s → 4s, max ~3 tries).</DocP>
      <DocP>
        Never retry 400 / 401 / 403 / 409 / 422 — the request itself must change. Treat 404 on a
        receipt lookup as &quot;not found yet&quot; only if you poll a freshly-made payment;
        otherwise it means the receipt doesn&apos;t exist.
      </DocP>
      <Code
        code={`for attempt in 1..3:
  res = POST /verify
  if res.status in (500, 502, 429): sleep(min(2^attempt + rand(), 30)); continue
  break  # 400/401/403/404/409/422 are final`}
      />
    </>
  );
}
