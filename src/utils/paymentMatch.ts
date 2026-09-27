/**
 * paymentMatch.ts
 *
 * Shared helpers for extracting the verified amount + credited account from
 * provider-specific verification responses, and matching the credited account
 * against a merchant's payout account. Used by /payment-links/.../confirm
 * and /admin/verify-payment (the product purchase flow).
 */

export interface PaymentDetails {
  amount: number | null;
  /** Credited account as reported by the receipt, or null when unavailable. */
  account: string | null;
  /**
   * True only for providers whose receipt genuinely carries no credited-account
   * field. This is what separates "the provider does not report an account" from
   * "the provider should have reported one and did not".
   *
   * `accountMatches()` used to treat every null as the former and returned true,
   * so a receipt that failed to yield an account skipped the recipient check
   * entirely — a buyer could pay any account they liked and settlement still
   * matched. Callers must now consult this flag; see `recipientMatches()`.
   */
  accountNotReportedByProvider: boolean;
}

/** Providers whose receipt format has no credited-account field at all. */
const PROVIDERS_WITHOUT_ACCOUNT_FIELD = new Set(['dashen']);

/** Normalise Ethiopian phone numbers to the 251 prefix for comparison. */
export function normalisePhone(phone: string): string {
  const d = phone.replace(/\D/g, '');
  if (d.startsWith('251')) return d;
  if (d.startsWith('09') || d.startsWith('07')) return '251' + d.slice(1);
  return d;
}

function normaliseCbeMaskToken(value: string): string {
  return value.replace(/[^A-Za-z0-9*]/g, '').toUpperCase();
}

export function maskCbeAccount(account: string): string | null {
  const normalized = account.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (normalized.length < 5) return null;
  return `${normalized[0]}***${normalized.slice(-4)}`;
}

export function cbeAccountMatches(verifiedAccount: string | null, merchantAccount: string): boolean {
  if (verifiedAccount === null) return false;

  const normalizedVerified = normaliseCbeMaskToken(verifiedAccount);
  const canonicalVerified = normalizedVerified.includes('*')
    ? `${normalizedVerified[0]}***${normalizedVerified.slice(-4)}`
    : maskCbeAccount(normalizedVerified);
  const canonicalMerchant = maskCbeAccount(merchantAccount);

  if (!canonicalVerified || !canonicalMerchant) return false;
  return canonicalVerified === canonicalMerchant;
}

/** Basic format check — Ethiopian phone or 13–16 digit bank account. */
export function isValidMerchantAccount(account: string): boolean {
  const cleaned = account.trim();
  if (/^(09|07)\d{8}$/.test(cleaned)) return true;
  if (/^251(9|7)\d{8}$/.test(cleaned)) return true;
  if (/^\d{13,16}$/.test(cleaned)) return true;
  return false;
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = parseFloat(value.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Extract the verified amount and credited account from a raw service result,
 * keyed by the provider the caller specified.
 *
 * Every provider the API can verify must appear here. A missing case used to
 * fall through to `{ amount: null, account: null }`, which made settlement
 * impossible for that provider: M-Pesa is an accepted payment-link provider
 * (`VALID_PROVIDERS`) and an accepted `/admin/verify-payment` provider, but had
 * no case, so every M-Pesa checkout was rejected with AMOUNT_UNKNOWN no matter
 * what the buyer paid. Awash and Zemen were missing for the same reason.
 */
export function extractPaymentDetails(data: unknown, provider: string): PaymentDetails {
  const d = (data ?? {}) as Record<string, unknown>;
  const key = provider.toLowerCase();
  const accountNotReportedByProvider = PROVIDERS_WITHOUT_ACCOUNT_FIELD.has(key);

  switch (key) {
    case 'telebirr':
      return {
        // The receipt carries e.g. "1,234.56 Birr". `parseFloat` on that string
        // stops at the thousands separator and yields 1, so any payment over
        // 999 ETB was read as a fraction of its value and rejected as an amount
        // mismatch. numeric() strips separators before parsing.
        amount: numeric(d.settledAmount) ?? numeric(d.totalPaidAmount),
        account: text(d.creditedPartyAccountNo),
        accountNotReportedByProvider: false,
      };
    case 'cbe':
      return {
        amount: numeric(d.amount),
        account: text(d.receiverAccount),
        accountNotReportedByProvider: false,
      };
    case 'dashen':
      return {
        amount: numeric(d.transactionAmount) ?? numeric(d.total),
        // Dashen's receipt exposes only a receiver *name*, never an account.
        account: null,
        accountNotReportedByProvider: true,
      };
    case 'abyssinia':
      return {
        amount: numeric(d.amount),
        account: text(d.receiverAccount),
        accountNotReportedByProvider: false,
      };
    case 'cbebirr':
    case 'cbe-birr':
    case 'cbe_birr':
      return {
        amount: numeric(d.paidAmount) ?? numeric(d.amount),
        account: text(d.creditAccount),
        accountNotReportedByProvider: false,
      };
    case 'mpesa':
    case 'm-pesa':
      return {
        amount: numeric(d.amount),
        // verifyMpesa reports the receiver's phone number as receiverAccount.
        account: text(d.receiverAccount),
        accountNotReportedByProvider: false,
      };
    case 'awash':
      return {
        amount: numeric(d.amount),
        account: text(d.beneficiaryAccount),
        accountNotReportedByProvider: false,
      };
    case 'zemen':
      return {
        amount: numeric(d.amount) ?? numeric(d.totalAmount),
        account: text(d.recipientAccount),
        accountNotReportedByProvider: false,
      };
    default:
      return { amount: null, account: null, accountNotReportedByProvider };
  }
}

/**
 * Compare the receipt's credited account against the merchant's payout account.
 * Phone numbers are normalised first; masked phone numbers (e.g. `2519***1234`)
 * are matched on their visible prefix/suffix.
 *
 * A null `verifiedAccount` is NOT a pass. It means the receipt did not name a
 * recipient, so there is nothing to compare and settlement must be refused.
 */
export function accountMatches(verifiedAccount: string | null, merchantAccount: string): boolean {
  if (verifiedAccount === null) return false;

  const trimmedVerified = verifiedAccount.trim();
  const trimmedMerchant = merchantAccount.trim();
  if (!trimmedVerified || !trimmedMerchant) return false;

  const looksLikePhone = (s: string) => /^(09|07|251)/.test(s.replace(/\D/g, ''));
  if (looksLikePhone(trimmedVerified) && looksLikePhone(trimmedMerchant)) {
    const maskedMatch = trimmedVerified.match(/^(251\d{1})\*+(\d{4})$/);
    const normalizedMerchant = normalisePhone(trimmedMerchant);

    if (maskedMatch) {
      const visiblePrefix = maskedMatch[1] ?? '';
      const visibleSuffix = maskedMatch[2] ?? '';
      return normalizedMerchant.startsWith(visiblePrefix) && normalizedMerchant.endsWith(visibleSuffix);
    }
    return normalisePhone(trimmedVerified) === normalizedMerchant;
  }

  return trimmedVerified === trimmedMerchant;
}

/**
 * The single recipient check every settlement path must use.
 *
 * Provider-specific matching (CBE receipts mask the account, so an exact string
 * compare can never succeed) and the "this provider reports no account"
 * exception both live here. `/payment-links/:id/confirm` special-cased CBE while
 * `/admin/verify-payment` did not, so the same receipt produced two different
 * answers depending on which endpoint settled it — and the admin path rejected
 * essentially every real CBE payment.
 */
export function recipientMatches(
  provider: string,
  details: Pick<PaymentDetails, 'account' | 'accountNotReportedByProvider'>,
  merchantAccount: string,
): boolean {
  if (details.accountNotReportedByProvider) return true;
  if (details.account === null) return false;
  const key = provider.toLowerCase();
  return key === 'cbe'
    ? cbeAccountMatches(details.account, merchantAccount)
    : accountMatches(details.account, merchantAccount);
}
