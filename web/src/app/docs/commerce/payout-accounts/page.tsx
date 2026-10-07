import { DocH, DocLead, DocH2, DocP, Code, Endpoint, Next, API_HOST } from "@/components/Docs";

export default function PayoutAccounts() {
  return (
    <>
      <DocH>Payout accounts</DocH>
      <DocLead>Destinations where verified payments land. One account per provider.</DocLead>

      <Endpoint method="GET" path="/payouts" desc="List workspace payout accounts." />
      <Endpoint method="POST" path="/payouts" desc="Create: { label, accountHolderName, type: PHONE|BANK, account, providersAllowed[] }." />

      <Code
        code={`curl -X POST ${API_HOST}/payouts \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: $VERIFIER_API_KEY" \\
  -d '{
    "label": "Main Telebirr",
    "accountHolderName": "Abebe Kebede",
    "type": "PHONE",
    "account": "0911111111",
    "providersAllowed": ["telebirr"]
  }'`}
      />
      <DocH2>Matching rules</DocH2>
      <DocP>
        When a buyer pays, the system finds the payout account whose{" "}
        <code>providersAllowed</code> includes that provider and compares its{" "}
        <code>account</code> against the verified recipient. CBE accounts compare by suffix, so store
        the full account number.
      </DocP>
      <DocP>
        The <code>suffix</code> you send when verifying a legacy CBE receipt is the{" "}
        <strong>payer&apos;s</strong> 8-digit account tail, not this account. CBE keys its legacy
        receipt lookup on the sender, so submitting your own account number looks up a different
        receipt and returns 404. This payout account belongs in the{" "}
        <code>payoutAccountId</code> you pass to the verification request instead.
      </DocP>
      <Next href="/docs/commerce/payment-links" label="Payment links" />
    </>
  );
}
