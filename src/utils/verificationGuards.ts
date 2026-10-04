import { prisma } from './prisma';
import { extractPaymentDetails } from './paymentMatch';

/**
 * The two checks the recipient check cannot make for itself.
 *
 * AMOUNT: knowing who was paid says nothing about how much. A receipt for 100
 * Birr into the right account satisfies a recipient check as readily as one for
 * 5,000, and the caller was previously told only that the amount was unchecked.
 *
 * REPLAY: a receipt that has already been used can arrive again, and it will
 * match on both recipient and amount. Nothing about the receipt distinguishes it
 * from a legitimate second look-up — a customer asking twice, support
 * re-checking — so the fact is recorded and reported. Refusing outright would
 * break those; pretending not to notice would leave the caller unable to tell.
 */
export type AmountFailureReason = 'AMOUNT_MISMATCH' | 'AMOUNT_NOT_VERIFIABLE';

export interface AmountCheckResult {
  ok: boolean;
  reason?: AmountFailureReason;
  error?: string;
  expectedAmount?: number;
  /** What the provider reported, null when it reports none. */
  foundAmount?: number | null;
  checked: boolean;
}

/** ETB amounts are whole birr in practice; this only absorbs float representation. */
const AMOUNT_TOLERANCE = 0.01;

/**
 * Compare the amount the provider reported against what the caller expected.
 *
 * `expectedAmount` absent means no expectation was stated, so nothing is checked
 * and the result carries `checked: false` — the caller has to opt in, because a
 * silent pass would read as a verified amount.
 *
 * A provider that reports no amount is not treated as a match, and "we cannot
 * see how much" is not evidence that the right amount arrived. Note this is not
 * the same as "the provider has no amount": M-Pesa, Awash and Zemen all report
 * one, and extractPaymentDetails reads it for them. Only a provider that
 * genuinely omits the field reaches AMOUNT_NOT_VERIFIABLE.
 */
export function checkAmount(params: {
  result: Record<string, unknown>;
  expectedAmount: unknown;
  provider: string;
  /**
   * The amount the source already resolved, bypassing `extractPaymentDetails`.
   *
   * The OCR path needs this. Its payload speaks a different vocabulary from a
   * provider API (`details.amount` rather than `settledAmount` /
   * `transactionAmount` / `paidAmount`), and `ocrVerifiedTypes` covers 21
   * providers of which `extractPaymentDetails` knows 8. Routing the OCR payload
   * through the extractor therefore returned `AMOUNT_NOT_VERIFIABLE` for 13 of
   * them — on receipts whose amount was present and correct. `undefined` means
   * "not supplied, use the extractor", which keeps the reference path unchanged.
   */
  foundAmount?: number | null;
}): AmountCheckResult {
  const { result, provider } = params;
  const expected = Number(params.expectedAmount);

  if (!Number.isFinite(expected) || expected <= 0) {
    return { ok: true, checked: false };
  }

  if (result.success !== true) {
    return { ok: true, checked: false };
  }

  const found = 'foundAmount' in params
    ? params.foundAmount ?? null
    : (() => {
        const data = (result.data ?? result.details) as Record<string, unknown> | undefined;
        return data && typeof data === 'object' ? extractPaymentDetails(data, provider).amount : null;
      })();

  if (found === null || !Number.isFinite(found)) {
    return {
      ok: false,
      checked: true,
      reason: 'AMOUNT_NOT_VERIFIABLE',
      expectedAmount: expected,
      foundAmount: null,
      error:
        `${provider} did not report an amount for this transaction, so it cannot be confirmed as a payment of ${expected}. ` +
        'Do not issue on this evidence.',
    };
  }

  if (Math.abs(found - expected) > AMOUNT_TOLERANCE) {
    return {
      ok: false,
      checked: true,
      reason: 'AMOUNT_MISMATCH',
      expectedAmount: expected,
      foundAmount: found,
      error: `The payment was ${found}, not ${expected}.`,
    };
  }

  return { ok: true, checked: true, expectedAmount: expected, foundAmount: found };
}

export interface ReplayInfo {
  replayed: boolean;
  firstSeenAt?: Date;
  seenCount?: number;
  lastSeenAt?: Date;
}

/**
 * Record that this workspace has now been shown a successful verification, and
 * report whether it had been shown one before.
 *
 * Only successful verifications are recorded: a receipt that failed the recipient
 * or amount check was never accepted, so its return is not a replay of anything.
 *
 * Never throws. This runs on the response path, and a replay flag is a
 * diagnostic — a database hiccup must not turn a valid verification into a 500.
 * The upsert is keyed on the unique triple so two concurrent verifications of the
 * same receipt cannot create duplicate rows.
 */
export async function noteSuccessfulVerification(params: {
  workspaceId?: string;
  provider: string;
  reference: string;
  amount?: number | null;
}): Promise<ReplayInfo> {
  const { workspaceId, provider, reference } = params;
  if (!workspaceId || !provider || !reference) return { replayed: false };

  try {
    const existing = await prisma.verifiedTransaction.findUnique({
      where: {
        workspaceId_provider_reference: { workspaceId, provider, reference },
      },
      select: { firstSeenAt: true, seenCount: true, lastSeenAt: true },
    });

    if (existing) {
      // Do not await: the flag is already decided, and a slow write should not
      // hold up the response. A failure here only costs a stale seenCount.
      prisma.verifiedTransaction
        .update({
          where: {
            workspaceId_provider_reference: { workspaceId, provider, reference },
          },
          data: { seenCount: { increment: 1 }, lastSeenAt: new Date() },
        })
        .catch(() => {});
      return {
        replayed: true,
        firstSeenAt: existing.firstSeenAt,
        lastSeenAt: existing.lastSeenAt,
        seenCount: existing.seenCount + 1,
      };
    }

    try {
      await prisma.verifiedTransaction.create({
        data: {
          workspaceId,
          provider,
          reference,
          amount: typeof params.amount === 'number' && Number.isFinite(params.amount) ? params.amount : null,
        },
      });
    } catch {
      // Lost a race with a concurrent identical verification. That is a replay
      // too, and the row now exists.
      return { replayed: true, seenCount: 2 };
    }

    return { replayed: false, seenCount: 1 };
  } catch {
    return { replayed: false };
  }
}
