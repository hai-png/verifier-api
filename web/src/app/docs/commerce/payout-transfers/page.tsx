import { DocH, DocLead, DocH2, DocP, Code, Endpoint, Next, API_HOST } from "@/components/Docs";

export default function PayoutTransfers() {
  return (
    <>
      <DocH>Payout transfers</DocH>
      <DocLead>
        Pay money out to wallets and bank accounts — the same Telebirr, CBE Birr, Dashen phone
        numbers you already verify — as instruction records executed over USSD.
      </DocLead>

      <DocH2>What a payout transfer is</DocH2>
      <DocP>
        A transfer is one <strong>instruction</strong>: an amount, a provider, a destination, and
        your own <code>reference</code>. Creating it does not move money — the operator&apos;s{" "}
        <a href="/docs/commerce/payout-accounts" className="underline">USSD device agents</a>{" "}
        execute transfers from the wallet SIMs they hold and report the outcome back. You create
        the transfer, you get a status machine, and you subscribe to{" "}
        <code>payout.succeeded</code> / <code>payout.failed</code> like any other event.
      </DocP>
      <DocP>
        Responses mask destinations (<code>0911**45</code>) so account numbers never sit in
        weblogs, while the full number lives inside the instruction for the agent to dial.
        Nothing is &quot;sent&quot; until an agent reports; the operator reconciles.
      </DocP>
      <Endpoint method="POST" path="/payout-transfers" desc="Create a payout intent. Idempotent on reference — a replay returns the original row; a different payload with a used reference answers 409." />
      <Endpoint method="GET" path="/payout-transfers" desc="List intents, newest first. Filters: status, provider, limit (≤100)." />
      <Endpoint method="GET" path="/payout-transfers/{id}" desc="Read one intent." />
      <Endpoint method="POST" path="/payout-transfers/{id}/cancel" desc="Cancel while the row is still PENDING (once an agent dials, cancel is refused with 409)." />
      <Code
        code={`curl -X POST ${API_HOST}/payout-transfers \\
  -H "x-api-key: sk_live_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "provider": "telebirr",
    "destination": "0911223344",
    "amount": 150.0,
    "reference": "refund-1248",
    "accountHolderName": "Hanna Tesfaye"
  }'`}
      />
      <Code
        code={`{
  "ok": true,
  "transfer": {
    "id": "pti_…",
    "provider": "telebirr",
    "destination": "0911**44",
    "amount": 150,
    "reference": "refund-1248",
    "status": "PENDING"
  }
}`}
      />

      <DocH2>Statuses</DocH2>
      <DocP>
        <code>PENDING</code> → an agent claims it (<code>CLAIMED</code>) or confirms the dial is
        running (<code>CONFIRMING</code>) → <code>SUCCEEDED</code> or <code>FAILED</code>. A
        claim that never reports is re-queued by the server&apos;s reconciler and re-dialed by
        any device until the attempt cap (default 3). Cancel only works while still PENDING.
      </DocP>

      <DocH2>Providers</DocH2>
      <DocP>
        Supported today: <code>telebirr</code> (<code>*127#</code>), <code>cbebirr</code>{" "}
        (<code>*848#</code>), <code>dashen</code> (<code>*644#</code>, wallet or bank account),
        and <code>cbe</code> bank accounts (through CBE&apos;s own USSD menu). The reference
        live list is always <code>GET /payout-transfers/providers</code>.
      </DocP>
      <Next href="/docs/automation/webhooks" label="Webhooks" />
    </>
  );
}
