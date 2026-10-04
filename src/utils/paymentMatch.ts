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
  account: string | null; // null when provider doesn't return an account number
}

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

/**
 * Extract the verified amount and credited account from a raw service result,
 * keyed by the provider the caller specified.
 *
 * Every branch names the field that provider's fetcher actually populates. A
 * provider that reaches `default:` is indistinguishable from a provider that
 * reported nothing, and the amount check fails closed on that — so a missing
 * case does not degrade gracefully, it makes the provider permanently unusable
 * for settlement. `mpesa`, `awash` and `zemen` were all missing: their fetchers
 * do report an amount and a receiver (verifyMpesa.ts → `amount` +
 * `receiverAccount`, verifyAwash.ts → `amount` + `beneficiaryAccount`,
 * verifyZemen.ts → `amount` + `recipientAccount`), yet every M-Pesa payment-link
 * confirmation failed with "Could not extract transaction amount".
 *
 * `dashen` is the one genuine null: its API returns a receiver *name* and no
 * account number, which is why checkReceiptRecipient has a name fallback and
 * accountMatches() treats a null account as "cannot compare, not a mismatch".
 */
export function extractPaymentDetails(data: unknown, provider: string): PaymentDetails {
  const d = (data ?? {}) as Record<string, unknown>;
  const str = (key: string): string | null => (typeof d[key] === 'string' ? (d[key] as string) : null);
  // Providers differ on whether the amount arrives as a number or as a string.
  // `parseFloat` on a numeric-looking string and a plain cast on a number both
  // land on the same value, and NaN is filtered by the caller's isFinite check.
  const num = (key: string): number | null => {
    const value = d[key];
    if (value === null || value === undefined) return null;
    const parsed = typeof value === 'number' ? value : parseFloat(String(value));
    return Number.isFinite(parsed) ? parsed : null;
  };

  switch (provider.toLowerCase()) {
    case 'telebirr':
      return {
        amount: num('settledAmount') ?? num('amount'),
        account: str('creditedPartyAccountNo') ?? str('receiverAccount'),
      };
    case 'cbe':
      return {
        amount: num('amount'),
        account: str('receiverAccount'),
      };
    case 'dashen':
      return {
        amount: num('transactionAmount') ?? num('amount'),
        // Dashen response has only receiverName, not an account number.
        account: null,
      };
    case 'abyssinia':
      return {
        amount: num('amount'),
        account: str('receiverAccount'),
      };
    case 'cbebirr':
      return {
        amount: num('paidAmount') ?? num('amount'),
        account: str('creditAccount') ?? str('receiverAccount'),
      };
    case 'mpesa':
      return {
        amount: num('amount'),
        account: str('receiverAccount'),
      };
    case 'awash':
      return {
        amount: num('amount'),
        account: str('beneficiaryAccount'),
      };
    case 'zemen':
      return {
        amount: num('amount'),
        account: str('recipientAccount'),
      };
    default:
      return { amount: null, account: null };
  }
}

/**
 * The *payer's* account, as the provider reported it.
 *
 * Deliberately separate from extractPaymentDetails, which returns the credited
 * (receiver) side. The payment-link confirm path needs both: knowing who was
 * paid proves the money arrived, but only knowing who sent it proves that the
 * caller asking for delivery is the person who paid.
 *
 * Returns null for cbebirr and dashen, which do not report a payer. A null here
 * means "cannot be checked", never "matches".
 */
export function extractPayerAccount(data: unknown, provider: string): string | null {
  const d = (data ?? {}) as Record<string, unknown>;
  const first = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = d[key];
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
    }
    return null;
  };

  switch (provider.toLowerCase()) {
    case 'telebirr':
      return first('payerTelebirrNo', 'payerAccount', 'payerPhone');
    case 'cbe':
    case 'abyssinia':
      return first('payerAccount', 'sourceAccount');
    case 'mpesa':
      return first('payerAccount', 'payerPhone');
    case 'awash':
      return first('senderAccount', 'payerAccount');
    case 'zemen':
      return first('senderAccount', 'payerAccount');
    default:
      // cbebirr: the payer number is an input to the lookup, not an output.
      // dashen: no payer in the response at all.
      return null;
  }
}

/**
 * Notation-insensitive comparison of two Ethiopian phone numbers.
 *
 * `251911000000`, `251 911 000 000`, `0911000000`, `+251911000000` and a
 * partially masked `2519***00000` all denote the same subscriber, and the same
 * number is printed in whichever notation the bank's form happens to use. A raw
 * digit comparison rejected correct payments, so every notation is tried.
 *
 * Both sides are stripped of separators first, so an account formatted as
 * `0911-000-0000` compares equal to `0911000000`.
 */
export function payerMatches(buyerPhone: string, payerAccount: string): boolean {
  const digitsOf = (value: string): string => value.replace(/\D/g, '');
  const candidate = digitsOf(buyerPhone);
  const expected = digitsOf(payerAccount);
  if (!candidate || !expected) return false;
  // Fast path: identical digits.
  if (candidate === expected) return true;

  const forms = (value: string): string[] => {
    const digits = digitsOf(value);
    const out = new Set<string>();
    if (digits) out.add(digits);
    const international = normalisePhone(digits);
    if (international) out.add(international);
    if (/^251[97]\d{8}$/.test(international)) out.add(`0${international.slice(3)}`);
    // A masked receipt number, e.g. 2519***00000: compare the visible digits as a
    // prefix/suffix pair, exactly as the recipient check does for masked accounts.
    return [...out];
  };

  const expectedForms = forms(payerAccount);
  if (expectedForms.some((form) => form === candidate)) return true;

  const maskedRuns = payerAccount.match(/\d+/g);
  if (!maskedRuns || maskedRuns.length === 0) return false;
  if (maskedRuns.length >= 2) {
    const head = maskedRuns[0]!;
    const tail = maskedRuns[maskedRuns.length - 1]!;
    return candidate.startsWith(head) && candidate.endsWith(tail);
  }
  const only = maskedRuns[0]!;
  return only.length >= 6 && (candidate.startsWith(only) || candidate.endsWith(only));
}

/**
 * Returns true if the verified credited account matches the merchant account.
 * Phone numbers are normalised before comparison; masked phone numbers (e.g.
 * `2519***1234`) are matched by prefix/suffix.
 * When `verifiedAccount` is null (e.g. Dashen), the check is skipped.
 *
 * ⚠ This skip is why the verification paths do not use this function. For
 * Dashen the null is the *normal* case, not an edge case, so a check built on it
 * passes unconditionally. Use checkReceiptRecipient() (recipientCheck.ts), which
 * falls back to the receiver name and fails closed, in anything that authorises
 * a delivery or a credit.
 */
export function accountMatches(verifiedAccount: string | null, merchantAccount: string): boolean {
  if (verifiedAccount === null) return true;

  const trimmedVerified = verifiedAccount.trim();
  const trimmedMerchant = merchantAccount.trim();

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
