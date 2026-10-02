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
        the receipt turns out to be from. Failures are reported separately so they can be told apart:{' '}
        <Code code="RECIPIENT_MISMATCH" inline /> when the receipt names a different account, and{' '}
        <Code code="RECIPIENT_NOT_VERIFIABLE" inline /> when the receipt carries nothing that identifies
        the destination. An unknown or other workspace&apos;s account id is rejected with 404 before the
        image credit is spent.
      </DocP>

      <DocH2>Not every receipt prints an account</DocH2>
      <DocP>
        Some banks identify the beneficiary by name only — Dashen publishes no destination account
        number at all, on the receipt or through its API. So the check uses whatever evidence the
        receipt carries, strongest first, and fails closed at every step:
      </DocP>
      <DocP>
        <Code code="1." inline /> a full account number, compared exactly;{' '}
        <Code code="2." inline /> a masked one like <Code code="5155*******11" inline />, where every
        visible digit must line up with your account;{' '}
        <Code code="3." inline /> the receiver name, compared against your payout account&apos;s
        account holder name; <Code code="4." inline /> nothing usable, which fails rather than passes.
      </DocP>
      <DocP>
        If you rely on the name check — which you will for Dashen — set the account holder name on
        the payout account. Without it there is nothing to compare against and the request fails with{' '}
        <Code code="RECIPIENT_NOT_VERIFIABLE" inline />. Names are compared exactly after normalising
        case and punctuation, so a name the bank truncated is reported as a mismatch rather than
        guessed at.
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
