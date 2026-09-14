import { DocH, DocLead, DocH2, DocP, Code } from "@/components/Docs";

const ROWS: [string, string][] = [
  ["400", "Bad request — missing/invalid parameters. Fix the payload."],
  ["401", "Missing or invalid API key / session. Check credentials."],
  ["402", "Quota exhausted or feature not in plan. Top up or upgrade."],
  ["403", "Key lacks the required permission. Update it in the dashboard."],
  ["404", "Unknown receipt / resource. Confirm the reference."],
  ["409", "Conflict — reference already used, sold out, or duplicate."],
  ["422", "Provider understood the request but rejected it (e.g. recipient mismatch, unreadable image)."],
  ["429", "Rate limit or public-verify throttle. Back off per retryAfter."],
  ["500", "Server error. Retry with backoff; contact support if persistent."],
  ["502", "Upstream provider unreachable (relays exhausted). Retry later."],
];

export default function Errors() {
  return (
    <>
      <DocH>Errors & retries</DocH>
      <DocLead>One envelope, predictable codes, safe retry rules.</DocLead>

      <DocP>
        Errors always look like <code>{"{ success: false, error }"}</code>, sometimes with extra
        fields (<code>details</code>, <code>retryAfter</code>, <code>code</code>).
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
