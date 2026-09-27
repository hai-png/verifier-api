/**
 * ocrVerification.ts
 *
 * The trust model for `/verify-image`.
 *
 * `/verify-image` asks a vision model to read a picture of a receipt. That is
 * *extraction*, not verification: the model reports what the pixels say, and the
 * pixels can say anything, because anyone can produce the picture. For years the
 * handler answered `verified: true` for 21 of its 23 provider types, which meant
 * a doctored screenshot was accepted as proof of payment, with the amount and the
 * payer's name both chosen by whoever made the image. The only thing standing
 * between that and a fraudulent subscription was a `note` string telling the
 * caller to check the amount themselves — prose, in a field no program parses.
 *
 * This module makes the distinction structural rather than a comment:
 *
 *   • `providerForOcrType()` — six of the 23 types (cbe-birr, dashen, abyssinia,
 *     awash, zemen, mpesa) are banks this service already has a real adapter for.
 *     For those, the receipt reference the model extracted is fed to the bank's
 *     own API, and the bank's answer is authoritative. The image is then only a
 *     way of *finding* the reference, never a way of proving the payment.
 *
 *   • `compareAgainstExpectations()` — for the remaining types there is no API to
 *     ask, so the honest comparison is the one the old `note` described: does the
 *     extracted amount and payer match what this particular order expected? Doing
 *     it here, server-side, against values supplied with the request, is the only
 *     check that has any meaning. It still cannot detect a well-made forgery, and
 *     the response says so explicitly.
 *
 *   • `ocrTrustEnabled()` — the legacy `verified: true` shorthand is available
 *     behind an explicit opt-in so an existing integration can keep working, but
 *     it is opt-in, per-request or per-deployment, and it is logged.
 */

/**
 * OCR `type` values that map onto a provider adapter in `verifyUniversal`.
 * Anything not listed here has no upstream API, so nothing can be verified
 * against ground truth.
 */
const OCR_TYPE_TO_PROVIDER: Record<string, {
    /** Name accepted by `runSmartVerify({ provider })`. */
    provider: string;
    /** The adapter needs a phone number as well as the reference. */
    needsPhone?: boolean;
    /** The adapter needs an account suffix as well as the reference. */
    needsSuffix?: boolean;
}> = {
    'cbe-birr': { provider: 'cbebirr', needsPhone: true },
    dashen: { provider: 'dashen' },
    abyssinia: { provider: 'abyssinia', needsSuffix: true },
    awash: { provider: 'awash' },
    zemen: { provider: 'zemen' },
    mpesa: { provider: 'mpesa' },
};

/** Provider types the vision model is asked to recognise. */
export const ALL_OCR_TYPES = [
    'telebirr', 'cbe', 'cbe-birr', 'dashen', 'abyssinia', 'awash', 'zemen', 'mpesa',
    'coop-oromia', 'oromia-bank', 'hijra', 'amhara', 'wegagen', 'berhan', 'abay',
    'lion', 'bunna', 'enat', 'gadaa', 'tsehay', 'orbit', 'shabelle', 'sinqee',
] as const;

/**
 * Types whose only evidence is the image itself: no adapter exists upstream.
 * `telebirr` and `cbe` are excluded — the handler routes those through
 * `runSmartVerify` separately and always has.
 */
export function ocrOnlyTypes(): string[] {
    return ALL_OCR_TYPES.filter((type) => !OCR_TYPE_TO_PROVIDER[type] && type !== 'telebirr' && type !== 'cbe');
}

export function providerForOcrType(type: string): { provider: string; needsPhone: boolean; needsSuffix: boolean } | undefined {
    const entry = OCR_TYPE_TO_PROVIDER[String(type ?? '').toLowerCase()];
    return entry ? { provider: entry.provider, needsPhone: Boolean(entry.needsPhone), needsSuffix: Boolean(entry.needsSuffix) } : undefined;
}

/** `299`, `"299.00"`, `"1,299 Birr"` → 1299. Anything unparseable → null. */
export function normaliseAmount(value: unknown): number | null {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string') return null;
    const match = value.replace(/\s/g, '').match(/-?\d[\d,]*(?:\.\d+)?/);
    if (!match) return null;
    const parsed = Number.parseFloat(match[0].replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
}

/** Case/diacritic-insensitive name comparison, ignoring honorifics and spacing. */
export function namesEquivalent(a: unknown, b: unknown): boolean {
    const norm = (v: unknown) =>
        String(v ?? '')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .replace(/\b(plc|ltd|llc|inc|mr|mrs|ms|dr|eth|et)\b/g, ' ')
            .split(/\s+/)
            .filter(Boolean)
            .sort()
            .join(' ');
    const left = norm(a);
    const right = norm(b);
    return left.length > 0 && left === right;
}

/** Phone comparison on digits only, tolerating the 0/251 prefix conventions. */
export function phonesEquivalent(a: unknown, b: unknown): boolean {
    const norm = (v: unknown) => {
        const digits = String(v ?? '').replace(/\D/g, '');
        if (digits.startsWith('251')) return digits.slice(3);
        if (digits.startsWith('0')) return digits.slice(1);
        return digits;
    };
    const left = norm(a);
    const right = norm(b);
    return left.length >= 9 && left === right;
}

export interface OcrExpectations {
    amount?: unknown;
    payerName?: unknown;
    payerPhone?: unknown;
    receiverName?: unknown;
    receiverAccount?: unknown;
    reference?: unknown;
}

export interface OcrExtracted {
    amount?: unknown;
    payer_name?: unknown;
    payer_phone?: unknown;
    receiver_name?: unknown;
    receiver_account?: unknown;
    transaction_id?: unknown;
    transaction_number?: unknown;
    reference?: unknown;
}

export interface ExpectationComparison {
    /** True when the caller supplied at least one expectation to check against. */
    expectationsProvided: boolean;
    /** Every supplied expectation matched. False if none were supplied. */
    satisfied: boolean;
    /** Per-field results; `null` means "not supplied, so not checked". */
    checks: {
        amount: boolean | null;
        payerName: boolean | null;
        payerPhone: boolean | null;
        receiverName: boolean | null;
        receiverAccount: boolean | null;
        reference: boolean | null;
    };
    /** The amount the receipt claims, normalised — echoed so the caller can log it. */
    extractedAmount: number | null;
}

/**
 * Compare what the model read against what this order expected.
 *
 * Only fields the caller actually supplied are checked, and the response
 * distinguishes "matched", "did not match" and "was not asked about" — an
 * unchecked field must never be mistaken for a passing one.
 */
export function compareAgainstExpectations(
    extracted: OcrExtracted,
    expectations: OcrExpectations,
): ExpectationComparison {
    const extractedAmount = normaliseAmount(extracted.amount);
    const expectedAmount = normaliseAmount(expectations.amount);

    const check = (expected: unknown, compare: (a: unknown, b: unknown) => boolean, actual: unknown): boolean | null =>
        expected === undefined || expected === null || String(expected).trim() === '' ? null : compare(actual, expected);

    const checks = {
        amount: expectedAmount === null
            ? null
            : (extractedAmount === null ? false : Math.abs(extractedAmount - expectedAmount) < 0.005),
        payerName: check(expectations.payerName, namesEquivalent, extracted.payer_name),
        payerPhone: check(expectations.payerPhone, phonesEquivalent, extracted.payer_phone),
        receiverName: check(expectations.receiverName, namesEquivalent, extracted.receiver_name),
        receiverAccount: check(
            expectations.receiverAccount,
            (a, b) => {
                const left = String(a ?? '').replace(/\D/g, '');
                const right = String(b ?? '').replace(/\D/g, '');
                return left.length > 0 && (left === right || left.endsWith(right) || right.endsWith(left));
            },
            extracted.receiver_account,
        ),
        reference: check(
            expectations.reference,
            (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase(),
            extracted.transaction_id ?? extracted.transaction_number ?? extracted.reference,
        ),
    };

    const supplied = Object.values(checks).filter((v): v is boolean => v !== null);
    return {
        expectationsProvided: supplied.length > 0,
        satisfied: supplied.length > 0 && supplied.every(Boolean),
        checks,
        extractedAmount,
    };
}

/**
 * Whether this request may use the legacy `verified: true` shorthand for an
 * OCR-only receipt.
 *
 * Off by default. Turning it on is a deliberate statement that the caller does
 * its own amount/payer matching and wants the old response shape; it is logged
 * so the exposure shows up in the audit trail rather than only in a query string.
 */
export function ocrTrustEnabled(source: { query?: Record<string, unknown>; env?: NodeJS.ProcessEnv }): boolean {
    const env = source.env ?? process.env;
    if (String(env.OCR_TRUST_IMAGES ?? '').toLowerCase() === 'true') return true;
    return String(source.query?.trustOcr ?? '').toLowerCase() === 'true';
}
