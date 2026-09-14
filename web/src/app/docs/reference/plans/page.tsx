import { DocH, DocLead, DocH2, DocP, Next } from "@/components/Docs";

export default function Plans() {
  return (
    <>
      <DocH>Plans & limits</DocH>
      <DocLead>Three tiers. Every new workspace starts on FREE with monthly credits.</DocLead>

      <div className="border rounded-md overflow-hidden mb-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted text-left">
              <th className="p-2">Quota</th>
              <th className="p-2">FREE</th>
              <th className="p-2">PRO</th>
              <th className="p-2">BUSINESS</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t"><td className="p-2">Monthly verifications</td><td className="p-2">100</td><td className="p-2">2,000</td><td className="p-2">50,000</td></tr>
            <tr className="border-t"><td className="p-2">Rate limit (req/min)</td><td className="p-2">10</td><td className="p-2">60</td><td className="p-2">300</td></tr>
            <tr className="border-t"><td className="p-2">Image credits / month</td><td className="p-2">0</td><td className="p-2">100</td><td className="p-2">300</td></tr>
            <tr className="border-t"><td className="p-2">Batch max references</td><td className="p-2">—</td><td className="p-2">20</td><td className="p-2">100</td></tr>
            <tr className="border-t"><td className="p-2">Webhooks</td><td className="p-2">—</td><td className="p-2">20</td><td className="p-2">50</td></tr>
            <tr className="border-t"><td className="p-2">Notification channels</td><td className="p-2">—</td><td className="p-2">—</td><td className="p-2">20</td></tr>
          </tbody>
        </table>
      </div>

      <DocH2>Notes</DocH2>
      <DocP>
        Limits are operator-configurable and may differ on self-hosted installs. Legacy workspaces
        are grandfathered with higher FREE quotas. Exceeding the monthly quota returns HTTP 402;
        exceeding the rate limit returns 429 with a <code>retryAfter</code> hint.
      </DocP>
      <Next href="/docs/reference/errors" label="Errors & retries" />
    </>
  );
}
