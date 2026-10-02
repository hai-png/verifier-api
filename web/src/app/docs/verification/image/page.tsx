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
        desc="multipart/form-data with a file field. Consumes one image credit (not a verification credit). Requires the verify-image permission."
      />
      <Code
        code={`curl -X POST ${API_HOST}/verify-image \\
  -H "x-api-key: $VERIFIER_API_KEY" \\
  -F "file=@/path/to/receipt.jpg"`}
      />

      <DocH2>Enforcing the destination account</DocH2>
      <DocP>
        Without a <Code code="payoutAccountId" inline />, a receipt is reported as verified on the
        strength of the OCR alone — the image is the verification for the 21 providers with no public
        API. Passing <Code code="payoutAccountId" inline /> makes the destination check enforceable: the
        account the receipt names must match that payout account, or the request fails with 422.
      </DocP>
      <Code
        code={`curl -X POST ${API_HOST}/verify-image \\
  -H "x-api-key: $VERIFIER_API_KEY" \\
  -F "file=@/path/to/receipt.jpg" \\
  -F "payoutAccountId=clx1234567890abcdef"`}
      />
      <DocP>
        The account must belong to the calling key&apos;s own workspace, and must accept the provider
        the receipt turns out to be from. Two failures are reported separately so they can be told
        apart: <Code code="RECIPIENT_MISMATCH" inline /> when the receipt names a different account, and{' '}
        <Code code="RECIPIENT_UNREADABLE" inline /> when no account could be read from the image at all.
        The second is deliberate — a receipt whose account number could not be read is not evidence
        that the payment arrived. An unknown or other workspace&apos;s account id is rejected with 404
        before the image credit is spent.
      </DocP>
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
