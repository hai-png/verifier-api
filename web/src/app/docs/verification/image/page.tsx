import { DocH, DocLead, DocH2, DocP, Code, Endpoint, Next, API_HOST } from "@/components/Docs";

export default function Image() {
  return (
    <>
      <DocH>Receipt image verification</DocH>
      <DocLead>
        Upload a receipt screenshot from any Ethiopian bank — OCR extracts payer, amount, date and
        reference automatically.
      </DocLead>

      <Endpoint
        method="POST"
        path="/verify-image"
        desc="multipart/form-data with an image field. Consumes one image credit (not a verification credit). Requires the verify-image permission."
      />
      <Code
        code={`curl -X POST ${API_HOST}/verify-image \\
  -H "x-api-key: $VERIFIER_API_KEY" \\
  -F "image=@/path/to/receipt.jpg"`}
      />
      <DocH2>Coverage</DocH2>
      <DocP>
        Works for all Ethiopian banks — including ones without a dedicated endpoint (Cooperative
        Bank of Oromia, Amhara, Wegagen, Bunna, Enat, Lion, Berhan, Abay and more). For best
        results send a clear, uncropped screenshot; blurry or partial images return 422 with the
        reason.
      </DocP>
      <Next href="/docs/commerce/products" label="Products" />
    </>
  );
}
