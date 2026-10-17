import { DocH, DocLead, DocH2, DocP, Code, Endpoint, Next, API_HOST } from "@/components/Docs";

export default function PayoutAccounts() {
  return (
    <>
      <DocH>Payout accounts</DocH>
      <DocLead>
        Destinations where verified payments land. One account record can hold a destination per
        provider.
      </DocLead>

      <Endpoint method="GET" path="/payouts" desc="List workspace payout accounts." />
      <Endpoint
        method="POST"
        path="/payouts"
        desc="Create: { label, accountHolderName, providersAllowed[], providerAccounts{} } — or the legacy { type: PHONE|BANK, account } shape."
      />
      <Endpoint method="PATCH" path="/payouts/:id" desc="Update label, holder, providers, destinations, default." />

      <DocH2>One number per provider</DocH2>
      <DocP>
        <code>providersAllowed</code> names the providers this account can receive, and{" "}
        <code>providerAccounts</code> maps each of them to the number payments must reach — a phone
        number for the wallet providers (Telebirr, CBE Birr, M-Pesa) and a bank account number for a
        bank (CBE, Dashen, Bank of Abyssinia). Storing a phone <em>and</em> a bank account number on
        one record makes it a <em>unified</em> account: products and payment links then select it as
        a single account while each receipt is compared against its own provider&apos;s number.
      </DocP>
      <Code
        code={`curl -X POST ${API_HOST}/payouts \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: $VERIFIER_API_KEY" \\
  -d '{
    "label": "Main account",
    "accountHolderName": "Abebe Kebede",
    "providersAllowed": ["telebirr", "cbebirr", "mpesa", "cbe"],
    "providerAccounts": {
      "telebirr": "0911111111",
      "cbebirr":  "0911111111",
      "mpesa":    "0911111111",
      "cbe":      "1000123456789012"
    }
  }'`}
      />
      <DocP>
        Every provider in <code>providersAllowed</code> must have a destination in{" "}
        <code>providerAccounts</code>, and every key must be one of the allowed providers. The
        formats are checked per provider: Ethiopian phone numbers for the wallets, 13–16 digits for
        banks. <code>type</code> is derived (<code>PHONE</code>, <code>BANK</code>, or{" "}
        <code>UNIFIED</code> when both kinds are present) and <code>account</code> is set to the
        first destination.
      </DocP>
      <DocP>
        The simpler shape still works for accounts whose providers share one number: send{" "}
        <code>type</code>, <code>account</code> and <code>providersAllowed</code> (no{" "}
        <code>providerAccounts</code>) and every allowed provider falls back to that one number.
        A bank account still cannot share one number across two banks — give each bank its own
        entry in <code>providerAccounts</code> instead.
      </DocP>

      <DocH2>Matching rules</DocH2>
      <DocP>
        When a buyer pays, the system finds the payout account whose{" "}
        <code>providersAllowed</code> includes that provider and compares the receipt against that
        provider&apos;s destination — its <code>providerAccounts</code> entry, or <code>account</code>{" "}
        when the map has none. Exactly one selected account may cover each accepted provider, which
        is what makes the destination unambiguous at confirm time. CBE accounts compare by suffix,
        so store the full account number.
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
