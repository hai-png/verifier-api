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
        <code>account</code> against the verified recipient. CBE accounts compare by suffix, so
        store the full account number and pass the seller suffix when verifying legacy CBE
        receipts.
      </DocP>
      <Next href="/docs/commerce/payment-links" label="Payment links" />
    </>
  );
}
