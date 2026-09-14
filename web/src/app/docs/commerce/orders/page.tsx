import { DocH, DocLead, DocH2, DocP, Code, Endpoint, Next, API_HOST } from "@/components/Docs";

export default function Orders() {
  return (
    <>
      <DocH>Orders</DocH>
      <DocLead>Recorded buyer payments: PAID or REFUNDED, searchable and filterable.</DocLead>

      <Endpoint method="GET" path="/orders?provider=&status=&productId=&search=&page=&pageSize=" desc="List workspace orders, newest first." />
      <Endpoint method="GET" path="/orders/:id" desc="Single order with payment-link and product context." />
      <Endpoint method="POST" path="/orders/:id/resend-email" desc="Re-send the buyer purchase email." />

      <Code
        code={`curl "${API_HOST}/orders?status=PAID&pageSize=25" \\
  -H "x-api-key: $VERIFIER_API_KEY"`}
      />
      <DocH2>Buyer emails</DocH2>
      <DocP>
        Confirmed orders email the buyer a receipt (product name, reference, amount, delivery URL
        and success message when the product defines them). Use resend-email if the buyer lost it.
      </DocP>
      <Next href="/docs/automation/webhooks" label="Webhooks" />
    </>
  );
}
