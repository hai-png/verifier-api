import { DocH, DocLead, DocH2, DocP, Code, Endpoint, Next, API_HOST } from "@/components/Docs";

export default function Products() {
  return (
    <>
      <DocH>Products</DocH>
      <DocLead>Sellable items with a price. Creating one also generates its default payment link.</DocLead>

      <Endpoint method="GET" path="/products" desc="List workspace products (supports status filter)." />
      <Endpoint method="POST" path="/products" desc="Create a product + default payment link in one call." />
      <Endpoint method="GET" path="/products/:id" desc="Product detail incl. payout accounts and links." />
      <Endpoint method="GET" path="/products/:id/orders" desc="Orders placed for this product." />

      <DocH2>Create a product</DocH2>
      <Code
        code={`curl -X POST ${API_HOST}/products \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: $VERIFIER_API_KEY" \\
  -d '{
    "name": "Monthly Subscription",
    "price": 299,
    "acceptedProviders": ["telebirr", "cbe"],
    "payoutAccountIds": ["pa_xxx"],
    "maxBuyers": 100
  }'`}
      />
      <DocP>
        <code>payoutAccountIds</code> must cover every accepted provider exactly once — one account
        per provider, so buyer payments match unambiguously. <code>maxBuyers</code> caps sales
        (sold-out links return 409).
      </DocP>
      <Next href="/docs/commerce/payout-accounts" label="Payout accounts" />
    </>
  );
}
