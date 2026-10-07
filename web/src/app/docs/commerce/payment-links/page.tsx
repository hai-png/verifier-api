import { DocH, DocLead, DocH2, DocP, Code, Endpoint, Next, API_HOST } from "@/components/Docs";

export default function PaymentLinks() {
  return (
    <>
      <DocH>Payment links</DocH>
      <DocLead>Shareable hosted checkout pages for a product or a one-off amount.</DocLead>

      <Endpoint method="GET" path="/payment-links" desc="List links." />
      <Endpoint method="POST" path="/payment-links" desc="Create: { name?, productId | customAmount, acceptedProviders?, payoutAccountIds?, redirectUrl?, expiresInMinutes? }." />
      <Endpoint method="GET" path="/payment-links/:id/public" desc="Public link details (no key needed)." />
      <Endpoint method="POST" path="/payment-links/:id/confirm" desc="Verify + record a buyer payment: { reference, provider?, buyerName?, buyerEmail?, buyerPhone?, suffix? }." />
      <Endpoint method="GET" path="/payment-links/:id" desc="Fetch one link." />
      <Endpoint method="PATCH" path="/payment-links/:id" desc="Update name, status, expiry or payout accounts." />
      <Endpoint method="DELETE" path="/payment-links/:id" desc="Delete a link." />
      <Endpoint method="GET" path="/payment-links/:id/recent-order" desc="The most recent order for this link." />

      <DocH2>Pricing: exactly one of productId or customAmount</DocH2>
      <DocP>
        A link is priced either by a product or by a direct amount — supply{" "}
        <Code code="productId" inline /> or <Code code="customAmount" inline />, never both and
        never neither. Sending <Code code="fixedAmount" inline /> is the common mistake here: that
        field name is not read at all, so the request falls through to the both-or-neither check and
        is rejected with <Code code="400 Provide exactly one of productId or customAmount." inline />
        .
      </DocP>
      <Code
        code={`# a one-off amount
curl -X POST ${API_HOST}/payment-links \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: $VERIFIER_API_KEY" \\
  -d '{
        "name": "Pro plan",
        "customAmount": 801,
        "acceptedProviders": ["telebirr", "cbe"],
        "expiresInMinutes": 1440
      }'

# or priced by a product
curl -X POST ${API_HOST}/payment-links \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: $VERIFIER_API_KEY" \\
  -d '{ "name": "Pro plan", "productId": "prod_xxx" }'`}
      />
      <DocP>
        <Code code="expiresInMinutes" inline /> is capped at 1440 (24 hours). Leave it out for a link
        that never expires.
      </DocP>

      <DocH2>Which providers a link accepts</DocH2>
      <DocP>
        <Code code="acceptedProviders" inline /> is not the full provider list. Only these six may be
        sold on: <Code code="telebirr" inline />, <Code code="cbe" inline />,{" "}
        <Code code="dashen" inline />, <Code code="abyssinia" inline />, <Code code="cbebirr" inline />{" "}
        and <Code code="mpesa" inline />. Awash and Zemen have dedicated verification endpoints but
        cannot be sold on — a payment link has to be able to settle an order, and those cannot
        deliver the amount and recipient figures needed to do it.
      </DocP>
      <DocP>
        <Code code="payoutAccountIds" inline /> selects which saved accounts the buyer may pay into.
        Each id must be a payout account of the calling workspace, and a link can only offer a
        provider it has an account for.
      </DocP>

      <DocH2>Buyer flow</DocH2>
      <DocP>
        1. Buyer opens the link and pays to the shown account. 2. Your app (or the buyer) posts the
        reference to <Code code="/payment-links/:id/confirm" inline />. 3. The API verifies the payment,
        checks the amount and recipient, then records a <Code code="PAID" inline /> order — rejecting
        double-spent references with <Code code="409" inline />.
      </DocP>
      <Code
        code={`curl -X POST ${API_HOST}/payment-links/pl_xxx/confirm \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: $VERIFIER_API_KEY" \\
  -d '{
    "reference": "FT74A19B2C3D",
    "provider": "telebirr",
    "buyerName": "Abebe",
    "buyerEmail": "abebe@example.com",
    "buyerPhone": "0911111111"
  }'`}
      />
      <DocP>
        The amount is compared against the <strong>net received</strong>, not the total the payer was
        charged — see <a href="/docs/reference/amounts" className="underline font-medium">Amount checks</a>.
        A Telebirr payment of 801 gross with a 4 Birr fee credited as 797 satisfies an 797 link and
        correctly fails an 801 one.
      </DocP>

      <DocH2>The buyer's phone number is often mandatory</DocH2>
      <DocP>
        <Code code="buyerPhone" inline /> is listed as optional but is effectively required for some
        providers: CBE Birr cannot be confirmed without it. It is also accepted as the alias{" "}
        <Code code="phoneNumber" inline />. If the provider reports a payer number that does not match
        the one supplied, the confirmation fails with <Code code="422 BUYER_PHONE_MISMATCH" inline />;
        if the provider needs one and none was supplied, <Code code="422 BUYER_PHONE_REQUIRED" inline />.
        Both are deliberate: a mismatch means the receipt belongs to a different buyer.
      </DocP>
      <Next href="/docs/commerce/orders" label="Orders" />
    </>
  );
}