import { DocH, DocLead, DocH2, DocP, Code, Endpoint, Next, API_HOST } from "@/components/Docs";

export default function Batch() {
  return (
    <>
      <DocH>Batch verification</DocH>
      <DocLead>Submit references together; get an individual result for every item.</DocLead>

      <Endpoint
        method="POST"
        path="/verify-batch"
        desc="Body: { references: string[] }. Max batch size depends on plan. Requires the verify-batch permission."
      />
      <Code
        code={`curl -X POST ${API_HOST}/verify-batch \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: $VERIFIER_API_KEY" \\
  -d '{"references": ["FT111", "FT222", "TXN333"]}'`}
      />
      <DocH2>Response</DocH2>
      <DocP>
        Returns one result object per input reference in order, each with its own{" "}
        <code>success</code> flag — a failed item never fails the whole batch. Every processed
        reference consumes credits individually.
      </DocP>
      <Next href="/docs/verification/image" label="Receipt image verification" />
    </>
  );
}
