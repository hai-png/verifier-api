/**
 * Which figure an `expectedAmount` is compared against.
 *
 * NET    - what the recipient's account actually received, after the provider's
 *          own service fee. This is what a merchant reconciles against a bank
 *          statement, so it is the default.
 * GROSS  - what the payer was charged, before the fee.
 *
 * Observed on a real Telebirr receipt: the payer was debited 801 Birr, itemised
 * as service fee 3.48 + VAT 0.52, and 797 Birr was credited. Comparing a
 * merchant's expected 797 against the receipt's headline "Total Paid Amount" of
 * 801 rejects a correct payment.
 *
 * Gross is what this API compared before, because most providers report a gross
 * figure as their primary amount field. Setting `VERIFY_AMOUNT_BASIS=gross`
 * restores that behaviour exactly.
 */
export type AmountBasis = 'net' | 'gross';

export function resolveAmountBasis(value: string | undefined = process.env.VERIFY_AMOUNT_BASIS): AmountBasis {
  return String(value ?? '').trim().toLowerCase() === 'gross' ? 'gross' : 'net';
}

export type AmountSource =
  /** The provider reports a settled/net figure directly. No arithmetic. */
  | 'providerNet'
  /** Derived as gross minus the provider's own reported fee. */
  | 'grossMinusFee'
  /** The provider is known to charge no fee deducted from the recipient. */
  | 'grossIsNet'
  /** Nothing usable, or a declared fee could not be read. */
  | 'unresolved';

export interface ResolvedAmount {
  provider: string;
  /** What the recipient received. Null when it cannot be established. */
  net: number | null;
  /** What the payer was charged. Null when the provider reports none. */
  gross: number | null;
  /**
   * The provider's reported fee.
   *
   * `null` means a fee field was present but could not be read, which is an
   * extraction failure and is deliberately distinguished from a genuine zero.
   * Collapsing the two is the failure this module exists to prevent: quietly
   * treating an unreadable fee as 0 overstates the net, and the merchant's
   * expected net then mismatches on exactly the transactions where the fee
   * mattered.
   */
  fee: number | null;
  /** Whether this provider is known to report a fee at all. */
  feeDeclared: boolean;
  /**
   * True when the provider declares a fee but the field was absent, so zero was
   * assumed. Legitimate and common: these fetchers build the field from a regex
   * match and leave it undefined when the receipt shows no fee, which is how a
   * fee-free transaction is actually represented.
   */
  feeAssumedZero: boolean;
  source: AmountSource;
}

/**
 * Per-provider field maps, taken from what each fetcher actually returns.
 *
 * The providers are inconsistent in kind, not merely in rate. Telebirr and
 * Zemen lead with a settled figure; Dashen, M-Pesa, CBE Birr and Abyssinia lead
 * with a gross figure and itemise the fee; Awash itemises nothing because it
 * deducts nothing from the recipient.
 *
 * Nothing here encodes a fee *rate*. Rates are tiered by amount, revised without
 * notice and occasionally zero through promotion, so any hardcoded rate is
 * wrong within weeks and fails in the direction of rejecting valid payments.
 * The fee is always read from the provider.
 */
interface ProviderAmountFields {
  /** Fields that already represent the amount credited to the recipient. */
  net: string[];
  /** Fields that represent what the payer was charged. */
  gross: string[];
  /** Fields holding the provider's itemised fee. */
  fee: string[];
}

/**
 * Fallback for any provider without an entry above.
 *
 * No fee is declared. Declaring one on an unstudied provider would make an
 * absent fee field fail closed, which would break every provider not yet
 * audited — an earlier draft did exactly that and CBE stopped verifying. Assuming
 * a fee you have not seen is worse than assuming none: `grossIsNet` preserves the
 * behaviour that shipped, and a provider that does deduct one is added here
 * deliberately, with evidence.
 */
const DEFAULT_FIELDS: ProviderAmountFields = {
  net: [],
  gross: ['amount', 'settledAmount', 'transactionAmount', 'paidAmount', 'totalPaidAmount'],
  fee: [],
};

const PROVIDER_FIELDS: Record<string, ProviderAmountFields> = {
  // `settledAmount` is scraped from the receipt's "Settled Amount" row and is
  // the amount actually credited — verified against a live 801 gross / 797 net
  // transaction. It leads; `amount` is only a fallback for a shape change.
  telebirr: {
    net: ['settledAmount'],
    gross: ['totalPaidAmount', 'amount'],
    fee: ['serviceFee', 'serviceCharge'],
  },
  // CBE's fetcher reads the provider's `amountCredited` and publishes it as
  // `amount`, so this provider's primary figure is already the credited one.
  // Calling it gross would subtract a fee that is not deducted from the receiver.
  cbe: { net: ['amount'], gross: [], fee: [] },
  // Zemen's fetcher assigns `amount` from its settled-amount regex, so its
  // primary figure is already net.
  zemen: { net: ['amount'], gross: ['totalPaidAmount'], fee: ['serviceCharge'] },
  // Registered under the hyphenated OCR spelling; `fieldsFor` normalises it so the
  // reference path's `cbebirr` slug reaches this same entry.
  'cbe-birr': { net: [], gross: ['paidAmount', 'amount'], fee: ['serviceCharge'] },
  dashen: { net: [], gross: ['transactionAmount', 'amount'], fee: ['serviceCharge'] },
  mpesa: { net: [], gross: ['amount'], fee: ['serviceFee'] },
  abyssinia: { net: [], gross: ['amount'], fee: ['serviceCharge'] },
  // Awash reports no fee and deducts none from the recipient, so gross is net.
  awash: { net: [], gross: ['amount'], fee: [] },
};

/**
 * Fold the two spellings of a provider slug onto one key.
 *
 * The reference path and the OCR path disagree about this: `providerSlug()`
 * translates the CBE_BIRR enum to `cbebirr`, while the OCR vocabulary in
 * `ocrVerifiedTypes` uses `cbe-birr`. Keying the map on only one of them meant
 * `/verify-cbebirr` missed its own entry and fell through to the defaults, which
 * declare no fee — so CBE Birr silently compared `paidAmount` gross instead of
 * subtracting the service charge. Normalising both sides makes the spelling
 * irrelevant instead of load-bearing.
 */
function normaliseProviderKey(provider: string): string {
  return provider.trim().toLowerCase().replace(/[-_\s]/g, '');
}

const NORMALISED_PROVIDER_FIELDS: Record<string, ProviderAmountFields> = Object.fromEntries(
  Object.entries(PROVIDER_FIELDS).map(([key, value]) => [normaliseProviderKey(key), value]),
);

function fieldsFor(provider: string): ProviderAmountFields {
  return NORMALISED_PROVIDER_FIELDS[normaliseProviderKey(provider)] ?? DEFAULT_FIELDS;
}

/** Like the extractor's `num`: accepts a number or a numeric string, rejects NaN. */
function readNumber(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (value === null || value === undefined || value === '') continue;
    const parsed = typeof value === 'number' ? value : parseFloat(String(value));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** True when any of `keys` holds something other than absent/empty. */
function hasAnyValue(source: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => {
    const value = source[key];
    return value !== undefined && value !== null && value !== '';
  });
}

/** Round to 2dp so 3.48 + 0.52 style float residue cannot fail a tolerance check. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Work out the net, gross and fee for a provider payload.
 *
 * Resolution order, and why:
 *
 * 1. A provider-reported net field wins outright. No arithmetic, so it is immune
 *    to fee-rate changes, promotional zero-fee windows and tiering. Telebirr,
 *    CBE and Zemen are here, and for them this is the authoritative answer.
 * 2. Otherwise gross minus the provider's own reported fee. Both operands come
 *    from the provider, so a changed rate needs no code change. A genuine zero
 *    fee correctly yields net === gross.
 * 3. A fee the provider declares but does not send is read as zero, because that
 *    is how these fetchers represent a fee-free transaction: verifyMpesa builds
 *    `serviceFee` from a regex match and leaves it undefined when the receipt
 *    shows no service fee. Treating absence as a failure instead made every
 *    fee-free M-Pesa, Dashen and CBE-Birr payment unverifiable.
 * 4. A fee that is present but unparseable is the genuine failure, and resolves
 *    to `null` rather than zero — see the `fee` note above.
 * 5. A provider that declares no fee at all treats gross as net (Awash, and any
 *    provider not yet audited).
 */
export function resolveAmounts(provider: string, data: unknown): ResolvedAmount {
  const source = (data ?? {}) as Record<string, unknown>;
  const fields = fieldsFor(provider);

  const netDirect = readNumber(source, fields.net);
  const gross = readNumber(source, fields.gross);
  const feeDeclared = fields.fee.length > 0;
  const feeValue = feeDeclared ? readNumber(source, fields.fee) : null;
  // A declared-but-absent fee means zero. A declared-but-unreadable one does not.
  const feePresentButBroken = feeDeclared && feeValue === null && hasAnyValue(source, fields.fee);
  const fee = feeValue ?? (feeDeclared && !feePresentButBroken ? 0 : null);
  const feeAssumedZero = feeDeclared && feeValue === null && !feePresentButBroken;

  const base = { provider, gross, fee, feeDeclared, feeAssumedZero };

  if (netDirect !== null) {
    return { ...base, net: netDirect, source: 'providerNet' };
  }

  if (gross !== null && fee !== null) {
    return { ...base, net: round2(gross - fee), source: 'grossMinusFee' };
  }

  if (gross !== null && !feeDeclared) {
    return { ...base, net: gross, source: 'grossIsNet' };
  }

  return { ...base, net: null, source: 'unresolved' };
}

/**
 * The single number an `expectedAmount` should be compared against.
 *
 * Returns null when the requested basis cannot be established, which the caller
 * must treat as unverifiable rather than as a match — "we cannot see how much"
 * is never evidence that the right amount arrived.
 */
export function resolveComparableAmount(
  provider: string,
  data: unknown,
  basis: AmountBasis = resolveAmountBasis(),
): { amount: number | null; resolved: ResolvedAmount } {
  const resolved = resolveAmounts(provider, data);
  const amount = basis === 'gross' ? resolved.gross : resolved.net;
  return { amount, resolved };
}

/**
 * Human-readable explanation for an unverifiable amount, naming the real cause.
 *
 * The generic "provider did not report an amount" message is actively misleading
 * for the fee-unreadable case: the provider did report an amount, and the fee it
 * reported alongside it is what stopped the net from being computed.
 */
export function describeAmountUnresolvable(resolved: ResolvedAmount, basis: AmountBasis): string {
  if (basis === 'gross') {
    return `${resolved.provider} did not report the charged amount for this transaction.`;
  }
  if (resolved.fee === null && resolved.feeDeclared) {
    return (
      `${resolved.provider} reported a charged amount of ${resolved.gross} but its service fee could not be ` +
      'read, so the net received cannot be confirmed. Do not issue on this evidence.'
    );
  }
  if (resolved.net !== null) {
    return `${resolved.provider} did not report a charged amount for this transaction.`;
  }
  return `${resolved.provider} did not report an amount for this transaction.`;
}
