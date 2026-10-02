import type { Request } from 'express';
import { prisma } from './prisma';
import { checkReceiptRecipient, payoutAccountAllowsProvider } from './recipientCheck';
import { extractPaymentDetails } from './paymentMatch';

/**
 * The recipient check for ordinary (reference-based) verification.
 *
 * /verify-image does this inside its own handler, where the receipt fields come
 * straight off the OCR. This is the same check applied to a provider's response
 * instead, and it carries the two properties that path does not have to worry
 * about:
 *
 *  - It runs AFTER the result cache. The cache key is built from workspace,
 *    provider, reference, suffix and phoneNumber only, so a receipt verified once
 *    is re-checked against whatever payout account this request names, without a
 *    second call to the provider and without fragmenting the cache per account.
 *
 *  - A mismatch is not an error. The provider did confirm the receipt, so the
 *    answer stays 200 with verified:false and a reason. Turning it into a 422
 *    would change the status of a request whose lookup succeeded, which is a
 *    breaking change for integrations that only check for a 2xx.
 */
export interface RecipientCheckOutcome {
  /** The result to send. Never null: a mismatch is reported, not thrown. */
  result: Record<string, unknown>;
  checked: boolean;
  reason?: string;
}

interface PayoutAccountRow {
  id: string;
  label: string;
  account: string;
  accountHolderName: string | null;
  providersAllowed: unknown;
}

/**
 * Which payout account this verification should be checked against.
 *
 * A request's own `payoutAccountId` wins over the key's bound default, so a
 * one-off can be checked against a different account without unbinding the key.
 * Both are scoped to the calling workspace: an id from another tenant is treated
 * as absent rather than honoured, and cannot be probed for existence by watching
 * the response change.
 */
export async function resolveRecipientPayoutAccount(
  req: Request,
  requestedPayoutAccountId: unknown,
): Promise<PayoutAccountRow | null> {
  // Set by apiKeyAuth (API keys) or dashboardVerificationAccess (sessions).
  const workspaceId = (req as any).workspaceContext?.workspace?.id;
  if (!workspaceId) return null;

  const requested =
    typeof requestedPayoutAccountId === 'string' && requestedPayoutAccountId.trim() !== ''
      ? requestedPayoutAccountId.trim()
      : null;

  if (requested) {
    return prisma.payoutAccount.findFirst({
      where: { id: requested, workspaceId, active: true },
      select: { id: true, label: true, account: true, accountHolderName: true, providersAllowed: true },
    });
  }

  const apiKeyId = (req as any).apiKeyData?.id;
  if (!apiKeyId) return null;

  const key = await prisma.apiKey.findFirst({
    where: { id: apiKeyId, workspaceId },
    select: { defaultPayoutAccountId: true },
  });
  if (!key?.defaultPayoutAccountId) return null;

  return prisma.payoutAccount.findFirst({
    where: { id: key.defaultPayoutAccountId, workspaceId, active: true },
    select: { id: true, label: true, account: true, accountHolderName: true, providersAllowed: true },
  });
}

/**
 * The credited party, as the provider reported it.
 *
 * extractPaymentDetails already knows which field each provider uses and that
 * Dashen returns none. The name is read separately because the account is not
 * the only identifier on offer — Dashen-style responses give a receiver name,
 * which is what the check falls back to.
 */
function creditedParty(result: Record<string, unknown>, slug: string): {
  account: string | null;
  name: string | null;
} {
  const data = (result.data ?? result.details) as Record<string, unknown> | undefined;
  if (!data || typeof data !== 'object') return { account: null, name: null };

  const { account } = extractPaymentDetails(data, slug);
  const record = data as Record<string, unknown>;
  let name: string | null = null;
  for (const key of ['creditedPartyName', 'receiverName', 'accountHolderName', 'beneficiaryName']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') { name = value.trim(); break; }
  }
  return { account, name };
}

/**
 * The two vocabularies do not line up.
 *
 * The pipeline and the provider responses use the enum names — CBE_BIRR, with an
 * underscore — while extractPaymentDetails and PayoutAccount.providersAllowed both
 * use `cbebirr`. Passing the enum value straight through silently returned no
 * credited account for CBE Birr, so every CBE Birr receipt read as
 * RECIPIENT_NOT_VERIFIABLE against a bound payout account. One place to translate.
 */
export function providerSlug(provider: string): string {
  const lower = provider.toLowerCase();
  return lower === 'cbe_birr' ? 'cbebirr' : lower;
}

/**
 * Apply the recipient check to a successful verification result.
 *
 * Returns the result unchanged when there is nothing to check, when the
 * provider was not confirmed, or when no payout account is bound. Anything else
 * produces verified:false with a reason, alongside the provider data so an
 * operator can adjudicate rather than being handed a bare rejection.
 */
export function applyRecipientCheck(params: {
  result: Record<string, unknown>;
  payoutAccount: PayoutAccountRow | null;
  /** Provider in the pipeline's vocabulary, e.g. TELEBIRR or CBE_BIRR. */
  provider: string;
}): RecipientCheckOutcome {
  const { result, payoutAccount, provider } = params;

  if (!payoutAccount || result.success !== true) {
    return { result, checked: false };
  }

  const slug = providerSlug(provider);
  if (slug && !payoutAccountAllowsProvider(payoutAccount.providersAllowed, slug)) {
    return mismatch(result, payoutAccount, 'PROVIDER_NOT_ALLOWED',
      `The selected payout account does not accept ${slug} payments.`);
  }

  const { account, name } = creditedParty(result, slug);
  const outcome = checkReceiptRecipient({
    foundAccount: account,
    foundName: name,
    expectedAccount: payoutAccount.account,
    expectedHolderName: payoutAccount.accountHolderName,
    useCbeAccountRule: slug === 'cbe',
  });

  if (outcome.ok) {
    return {
      result: {
        ...result,
        recipientChecked: true,
        matchedOn: outcome.matchedOn,
        payoutAccountId: payoutAccount.id,
        payoutAccountLabel: payoutAccount.label,
        // Stated rather than implied: the check says who was paid, never how
        // much. The image path reports the same thing.
        amountChecked: false,
      },
      checked: true,
    };
  }

  return {
    result: mismatch(result, payoutAccount, outcome.reason!, outcome.error!)
      .result,
    checked: true,
    reason: outcome.reason,
  };
}

function mismatch(
  result: Record<string, unknown>,
  payoutAccount: PayoutAccountRow,
  reason: string,
  error: string,
): RecipientCheckOutcome {
  return {
    result: {
      ...result,
      // The provider confirmed the receipt; only the recipient failed. Keeping
      // the data alongside lets a caller see what was actually paid.
      success: false,
      verified: false,
      reason,
      error,
      recipientChecked: true,
      expectedAccount: payoutAccount.account,
      payoutAccountId: payoutAccount.id,
      payoutAccountLabel: payoutAccount.label,
    },
    checked: true,
    reason,
  };
}