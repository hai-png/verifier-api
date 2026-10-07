import { DocH, DocLead, DocH2, DocP, Code, Next } from "@/components/Docs";

export default function Amounts() {
  return (
    <>
      <DocH>Amount checks</DocH>
      <DocLead>
        Knowing a receipt is genuine tells you nothing about whether the right amount arrived. Add
        an expected amount and the API compares it before reporting success.
      </DocLead>

      <DocH2>It is opt-in</DocH2>
      <DocP>
        Amount checking is never applied unless you send <Code code="expectedAmount" inline />. This
        is deliberate: a check you did not ask for cannot fail a payment you have already decided to
        accept, and the response always says which happened rather than leaving it implied.
      </DocP>
      <DocP>
        <Code code="amountChecked" inline /> is <Code code="true" inline /> only when a comparison
        actually ran. <Code code="false" inline /> means no expectation was stated and nothing was
        verified about the amount — it is not a pass.
      </DocP>
      <Code
        code={`curl -X POST https://verify.noveld.com.et/verify-telebirr \\
  -H "x-api-key: $VERIFIER_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"reference": "FT123ABC456", "expectedAmount": 797}'`}
      />
      <DocP>
        The same field is accepted by <Code code="/verify-image" inline /> and every provider
        endpoint. Comparisons allow a tolerance of 0.01 Birr, which exists only to absorb floating
        point representation — not to absorb a fee.
      </DocP>

      <DocH2>Net, not gross</DocH2>
      <DocP>
        <Code code="expectedAmount" inline /> means <strong>what the recipient actually
        received</strong>. Ethiopian providers charge the sender a service fee on top of the transfer,
        so the amount on the receipt and the amount in your account are different numbers. A real
        Telebirr transaction:
      </DocP>
      <Code
        code={`Service fee              3.48 Birr
Service fee VAT          0.52 Birr
                        ----------
Charged to the sender    4.00 Birr
Total Paid Amount      801.00 Birr   ← debited from the customer
Credited to merchant    797.00 Birr   ← arrived in the account`}
      />
      <DocP>
        The receipt&apos;s headline <strong>Total Paid Amount</strong> is 801, because that is what the
        customer was debited. If you expect 797 and the API compares against 801, every correct
        payment is rejected by exactly the fee — and if you expect 801 and it compares against 797,
        short payments are approved. Both directions are wrong, so the API never asks you to guess:
        it reports the provider&apos;s own settled figure where one exists.
      </DocP>

      <DocH2>Where the figure comes from</DocH2>
      <DocP>
        Fee rates are never hardcoded anywhere in this API. They are tiered by amount, revised
        without notice, and sometimes zero through a promotion, so any baked-in rate is wrong within
        weeks and fails by rejecting valid payments. Each provider&apos;s own reported numbers are
        used instead:
      </DocP>
      <DocP>
        <Code code="1." inline /> a provider-reported <strong>settled or credited</strong> figure,
        used directly with no arithmetic — immune to rate changes entirely;{' '}
        <Code code="2." inline /> otherwise the <strong>charged amount minus the fee the provider
        itself reported</strong> — so a revised rate needs no change here either;{' '}
        <Code code="3." inline /> a provider that charges no fee, where charged equals received.
      </DocP>
      <DocP>
        A transaction that genuinely carried no fee resolves to charged-equals-received and compares
        normally. That is not a special case: it is the same arithmetic with a zero.
      </DocP>

      <DocH2>Per provider</DocH2>
      <Code
        code={`Provider    Figure compared         How it is obtained
---------  ----------------------  --------------------------------
Telebirr   received (net)          settledAmount — reported directly
CBE        received (net)          amountCredited — reported directly
Zemen      received (net)          settled amount — reported directly
Dashen     received (net)          charged − serviceCharge
M-Pesa     received (net)          amount − serviceFee
CBE Birr   received (net)          paidAmount − serviceCharge
Abyssinia  received (net)          amount − serviceCharge
Awash      charged (= received)    no fee is deducted from the recipient`}
      />
      <DocP>
        If you price in terms of what the customer was charged rather than what you keep, the
        comparison basis is a server-side setting — <Code code="VERIFY_AMOUNT_BASIS=gross" inline /> —
        and needs no code change on your side.
      </DocP>

      <DocH2>Reading the breakdown</DocH2>
      <DocP>
        Whenever a comparison runs, the response carries{" "}
        <Code code="amountBreakdown" inline /> so you can see the arithmetic behind the result
        rather than deducing it from a failure:
      </DocP>
      <Code
        code={`{
  "verified": true,
  "recipientChecked": true,
  "amountChecked": true,
  "verifiedAmount": 797,
  "amountBreakdown": {
    "gross": 801,
    "fee": 3.48,
    "net": 797,
    "basis": "net",
    "source": "providerNet"
  }
}`}
      />
      <DocP>
        <Code code="source" inline /> tells you how{" "}
        <Code code="net" inline /> was arrived at: <Code code="providerNet" inline /> when the
        provider reported it outright, <Code code="grossMinusFee" inline /> when it was derived from
        the provider&apos;s own fee, <Code code="grossIsNet" inline /> when no fee applies, and{" "}
        <Code code="unresolved" inline /> when the net could not be established.
      </DocP>

      <DocH2>When an amount check fails</DocH2>
      <DocP>
        Two reasons, and the difference matters for what you do next.{" "}
        <Code code="AMOUNT_MISMATCH" inline /> means the provider reported an amount and it was not
        the one you expected — a real discrepancy.{" "}
        <Code code="AMOUNT_NOT_VERIFIABLE" inline /> means no amount could be established at all.
        That includes the case where the provider reported a charged amount but its service fee
        could not be read: the net is then unknown rather than guessed, and the request fails rather
        than passing on an assumption.
      </DocP>
      <Code
        code={`{
  "success": false,
  "verified": false,
  "reason": "AMOUNT_MISMATCH",
  "error": "The payment was 797, not 801.",
  "expectedAmount": 801,
  "verifiedAmount": 797,
  "amountBreakdown": { "gross": 801, "fee": 3.48, "net": 797 }
}`}
      />
      <DocP>
        Never treat <Code code="AMOUNT_NOT_VERIFIABLE" inline /> as a pass. &ldquo;We could not see
        how much&rdquo; is not evidence that the right amount arrived, and issuing on it is exactly
        the loss this check exists to prevent.
      </DocP>

      <DocH2>Ordering with the recipient check</DocH2>
      <DocP>
        When you pass both <Code code="payoutAccountId" inline /> and{" "}
        <Code code="expectedAmount" inline />, the destination account is checked first and the
        amount second. A receipt that fails either check is never recorded as a successful
        verification, so the replay count in the response only ever describes payments that genuinely
        passed both.
      </DocP>
      <DocP>
        Receipts that are genuine but already seen return <Code code="replayed: true" inline /> with{" "}
        <Code code="timesSeen" inline /> and <Code code="firstVerifiedAt" inline /> rather than an
        error. A customer asking twice, or support re-checking, is not a failure — but the flag is
        there so you can tell it apart from a first-time payment.
      </DocP>
      <Next href="/docs/verification/image" label="Receipt images" />
    </>
  );
}