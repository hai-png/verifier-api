import { DocH, DocLead, DocH2, DocP, Code, Endpoint, Next, API_HOST } from "@/components/Docs";

export default function Image() {
  return (
    <>
      <DocH>Receipt image verification</DocH>
      <DocLead>
        Upload a receipt screenshot and a vision model reads it. What happens next depends on the
        provider: for eight of them the reference on the receipt is checked against the bank&apos;s own
        API. For the rest, reading the image is the only thing that happens — and the response says so.
      </DocLead>

      <Endpoint
        method="POST"
        path="/verify-image"
        desc="multipart/form-data with an image field. Consumes one image credit (not a verification credit). Requires the verify-image permission."
      />
      <Code
        code={`curl -X POST ${API_HOST}/verify-image?autoVerify=true \\
  -H "x-api-key: $VERIFIER_API_KEY" \\
  -F "file=@/path/to/receipt.jpg"`}
      />

      <DocH2>Read this before you act on the response</DocH2>
      <DocP>
        A picture of a receipt can be produced by anyone, in any image editor, with any amount and any
        payer name on it. Recognising the pixels is extraction; it is not proof that a payment
        happened. So <Code code="verified" /> means one thing only: something authoritative confirmed
        the payment. An OCR read on its own never sets it.
      </DocP>
      <DocP>
        This endpoint used to return <Code code="verified: true" /> for 21 of its 23 provider types on
        the strength of the image alone. If you integrated against that, your flow accepted doctored
        screenshots. Check <Code code="verification.method" /> — not <Code code="verified" /> — if you
        need to know how much weight a result carries.
      </DocP>

      <DocH2>Providers confirmed against their own API</DocH2>
      <DocP>
        With <Code code="?autoVerify=true" />, the reference read off the image is sent to the
        provider. The provider&apos;s answer is final: there is no fallback to the image when it says
        no, because a fallback would let a forged picture win whenever the real check failed.
      </DocP>
      <Code
        code={`// telebirr, cbe, cbe-birr, dashen, abyssinia, awash, zemen, mpesa
{
  "verified": true,
  "type": "awash",
  "reference": "ABC123456789",
  "details": { /* the provider's own receipt record */ },
  "verification": {
    "method": "provider_api",
    "authoritative": true,
    "outcome": "confirmed"
  }
}`}
      />
      <DocP>
        <Code code="cbe-birr" /> needs the payer&apos;s phone number and <Code code="abyssinia" /> needs
        an account suffix. If the image does not legibly contain one, the response is{" "}
        <Code code="outcome: &quot;not_attempted&quot;" /> with the reference and a{" "}
        <Code code="forward_to" /> route, so you can supply it and verify properly. A legacy CBE{" "}
        <Code code="FT" /> reference likewise needs <Code code="suffix" /> (the last 8 digits after the
        CBE <Code code="1000" /> prefix) in the request body.
      </DocP>

      <DocH2>Providers with no public API</DocH2>
      <DocP>
        Fifteen banks — Cooperative Bank of Oromia, Oromia, Hijra, Amhara, Wegagen, Berhan, Abay,
        Lion, Bunna, Enat, Gadaa, Tsehay, Orbit, Shabelle and Sinqee — have no endpoint to ask. The
        fields are read and returned, and <Code code="requiresManualReview" /> is{" "}
        <Code code="true" />. Do not issue goods on that response alone.
      </DocP>
      <Code
        code={`{
  "verified": false,
  "type": "wegagen",
  "reference": "1234567890",
  "details": {
    "payerName": "…", "payerAccount": "…", "payerPhone": "…",
    "receiverName": "…", "receiverAccount": "…",
    "amount": 1299, "date": "…", "reference": "1234567890", "paymentReason": "…"
  },
  "verification": {
    "method": "ocr_only",
    "authoritative": false,
    "outcome": "unverified",
    "expectationsProvided": false,
    "satisfied": false,
    "checks": {
      "amount": null, "payerName": null, "payerPhone": null,
      "receiverName": null, "receiverAccount": null, "reference": null
    },
    "extractedAmount": 1299,
    "requiresManualReview": true
  }
}`}
      />

      <DocH2>Making an OCR-only receipt useful: send your expectations</DocH2>
      <DocP>
        Pass what this particular order expected and the comparison happens server-side, so you are not
        eyeballing fields yourself. Each check reports <Code code="true" />, <Code code="false" />, or{" "}
        <Code code="null" /> for &quot;you did not ask about this&quot; — an unchecked field is never
        mistaken for a passing one. Amounts tolerate sub-bir rounding; names ignore case, word order,
        punctuation and company suffixes; phone numbers ignore the <Code code="0" /> /{" "}
        <Code code="251" /> prefix convention.
      </DocP>
      <Code
        code={`curl -X POST ${API_HOST}/verify-image \\
  -H "x-api-key: $VERIFIER_API_KEY" \\
  -F "file=@/path/to/receipt.jpg" \\
  -F "expectedAmount=1299" \\
  -F "expectedPayerPhone=0911223344" \\
  -F "expectedReceiverAccount=1000123456789"`}
      />
      <DocP>
        Every field also has an expectation counterpart — <Code code="expectedAmount" />,{" "}
        <Code code="expectedPayerName" />, <Code code="expectedPayerPhone" />,{" "}
        <Code code="expectedReceiverName" />, <Code code="expectedReceiverAccount" /> and{" "}
        <Code code="expectedReference" /> — accepted as form fields or query params.
      </DocP>
      <Code
        code={`"verification": {
  "method": "ocr_only",
  "authoritative": false,
  "outcome": "matches_expectations",   // or "does_not_match_expectations"
  "expectationsProvided": true,
  "satisfied": true,
  "checks": {
    "amount": true, "payerName": null, "payerPhone": true,
    "receiverName": null, "receiverAccount": true, "reference": null
  }
}`}
      />
      <DocP>
        <Code code="satisfied: true" /> means the receipt says what your order expected. It still does
        not mean the payment happened — a well-made forgery that matches your amount and payer name
        passes. That is why <Code code="verified" /> remains <Code code="false" /> and{" "}
        <Code code="authoritative" /> remains <Code code="false" />.
      </DocP>

      <DocH2>The legacy verified:true shorthand</DocH2>
      <DocP>
        If you do your own matching and depend on the old response shape, pass{" "}
        <Code code="?trustOcr=true" /> per request (or set <Code code="OCR_TRUST_IMAGES=true" /> for the
        whole deployment). It sets <Code code="verified" /> from the image read alone and every such
        call is logged. It is an opt-in rather than the default because the default was the problem.
      </DocP>

      <DocH2>Credits and failures</DocH2>
      <DocP>
        One image credit is consumed per upload. It is refunded automatically when the failure is ours:
        the vision model is unreachable (503), returns an empty or unparseable body (502), or returns
        JSON that is not a receipt object (502). It is not refunded when the read succeeded and the
        provider then rejected the reference — the provider was asked, which is the same policy single
        verification applies.
      </DocP>
      <DocP>
        Send a clear, uncropped screenshot. An image the model cannot classify at all returns 422 with{" "}
        <Code code="&quot;Unknown or unrecognized receipt type&quot;" />. Fields it cannot read are
        omitted rather than guessed; an omitted field is recoverable, an invented one is not.
      </DocP>

      <Next href="/docs/commerce/products" label="Products" />
    </>
  );
}
