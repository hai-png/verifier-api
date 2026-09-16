import { DocH, DocLead, DocH2, DocP, Code, Endpoint, Next, API_HOST } from "@/components/Docs";

export default function PaymentLinks() {
  return (
    <>
      <DocH>Payment links</DocH>
      <DocLead>Shareable hosted checkout pages with a fixed amount.</DocLead>

      <Endpoint method="GET" path="/payment-links" desc="List links." />
      <Endpoint method="POST" path="/payment-links" desc="Create: { name, fixedAmount, acceptedProviders[], payoutAccountIds[], redirectUrl? }." />
      <Endpoint method="GET" path="/payment-links/:id/public" desc="Public link details (no key needed)." />
      <Endpoint method="POST" path="/payment-links/:id/confirm" desc="Verify + record a buyer payment: { reference, provider, buyerName, buyerEmail, buyerPhone?, suffix? }." />

      <DocH2>Buyer flow</DocH2>
      <DocP>
        1. Buyer opens the link and pays to the shown account. 2. Your app (or the buyer) posts the
        reference to <code>/payment-links/:id/confirm</code>. 3. The API verifies the payment,
        checks amount ≥ fixed amount and recipient match, then records a <code>PAID</code> order —
        rejecting double-spent references with 409.
      </DocP>
      <Code
        code={`curl -X POST ${API_HOST}/payment-links/pl_xxx/confirm \\
  -H "Content-Type: application/json" \\
  -d '{
    "reference": "FT123ABC456",
    "provider": "telebirr",
    "buyerName": "Abebe",
    "buyerEmail": "abebe@example.com",
    "buyerPhone": "0911111111"
  }'`}
      />
      <Next href="/docs/commerce/orders" label="Orders" />
    </>
  );
}
