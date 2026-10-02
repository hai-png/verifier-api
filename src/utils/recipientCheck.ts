import { accountMatches, cbeAccountMatches } from './paymentMatch';

/**
 * Enforcing "this receipt was paid into MY account" on a receipt image.
 *
 * The OCR path is the weak one. Twenty-one of the recognised providers have no
 * public API, so the image itself is the verification, and the old response
 * carried a note telling the caller to check the amount and payer themselves.
 * That is a warning label, not a control: nothing stopped a merchant issuing a
 * subscription for a receipt that named somebody else's account.
 *
 * Not every provider prints a destination account. Dashen does not — not on the
 * receipt and not in its own API response, which returns only a receiver name
 * (see extractPaymentDetails in paymentMatch.ts, where Dashen's account is a
 * hardcoded null for exactly that reason). So the check cascades through the
 * evidence a receipt can actually carry, strongest first, and fails closed at
 * every step:
 *
 *   1. a full account number    — exact comparison
 *   2. a masked account number  — every visible digit run must line up with the
 *                                expected account (prefix and suffix)
 *   3. a receiver name          — compared against the payout account's
 *                                accountHolderName
 *   4. nothing usable           — RECIPIENT_NOT_VERIFIABLE, never a pass
 *
 * `accountMatches()` deliberately treats a null verified account as a pass,
 * because a provider that omits the field is not evidence of a mismatch. In OCR
 * that reasoning inverts: an absent field means there was nothing to read, not
 * that nothing was wrong. So this module never inherits the skip.
 */
export type RecipientFailureReason =
    | 'RECIPIENT_MISMATCH'
    | 'RECIPIENT_NOT_VERIFIABLE'
    | 'PROVIDER_NOT_ALLOWED';

export interface RecipientCheckResult {
    ok: boolean;
    /** Absent when ok. */
    reason?: RecipientFailureReason;
    error?: string;
    expectedAccount?: string;
    /** What the receipt actually named. Null when nothing was readable. */
    foundAccount?: string | null;
    /** Which of the three comparisons decided the outcome. Useful in logs. */
    matchedOn?: 'account' | 'maskedAccount' | 'receiverName';
}

/** A payout account's `providersAllowed` is a Json array, so it needs narrowing. */
export function payoutAccountAllowsProvider(providersAllowed: unknown, provider: string): boolean {
    if (!Array.isArray(providersAllowed)) return false;
    return (providersAllowed as unknown[]).some(
        (value) => typeof value === 'string' && value.trim().toLowerCase() === provider.trim().toLowerCase(),
    );
}

/**
 * True when the printed account is only partly legible — banks commonly show
 * `5155*******11`, `5155 – 11` or `5155###11` rather than the whole number.
 * The glyph set is deliberately wide: a mask character we do not recognise is
 * worse than none, because it sends the value down the exact-comparison path and
 * produces a false mismatch on a correct receipt.
 */
function isMaskedAccount(value: string): boolean {
    return /[*xX#•·–—−‒―]/.test(value);
}

/**
 * Remove the separators banks print between digit groups.
 *
 * `5155 1047 39011`, `5155-1047-39011`, `51551047.39011` and `5155104739011` are
 * the same account. The exact comparison below does no normalisation at all, so
 * without this every grouped receipt reads as a mismatch — and grouping is the
 * normal way an account number is printed.
 */
function stripSeparators(value: string): string {
    return value.replace(/[\s./\\|_-]/g, '');
}

/**
 * Compare the digits a masked account still shows against the expected account.
 *
 * Masking keeps the leading and trailing digits and hides the middle, so the
 * visible runs must line up as a prefix and a suffix. A single run is accepted
 * as either end, but not merely "somewhere in the middle" — a four-digit run
 * matching any position would let far too much through.
 *
 * This is deliberately weaker than a full comparison, because the bank chose to
 * hide those digits. It is still far better than comparing names alone.
 */
export function maskedAccountMatches(found: string, expected: string): boolean {
    const runs = found.match(/\d+/g);
    if (!runs || runs.length === 0) return false;
    const target = stripSeparators(expected).replace(/\D/g, '');
    if (target === '') return false;

    if (runs.length >= 2) {
        const prefix = runs[0];
        const suffix = runs[runs.length - 1];
        return target.startsWith(prefix) && target.endsWith(suffix);
    }
    const only = runs[0];
    return target.startsWith(only) || target.endsWith(only);
}

/**
 * Compare a receipt's receiver name against the payout account's holder name.
 *
 * Normalisation keeps letters and digits of *any* script. An earlier version
 * stripped to `[a-z0-9]`, which is catastrophic here: Ethiopian receipts carry
 * Amharic names, so "ክርሳ አካኪ ካሊቲ ወረዳ 07", "ብርታ ሶንብ ኢንተርፓይዘሽ 07" and
 * "አዲስ አበባ ንግድ 07" all reduced to "07" and matched each other — three
 * unrelated businesses passed one another's check. Only the trailing digits
 * survived, which is no evidence at all.
 *
 * Not fuzzy beyond that: banks truncate long names on receipts, and a loose
 * comparison would start approving receipts for a similarly-named payee. A
 * truncation produces a visible RECIPIENT_MISMATCH with the names in the
 * response, which is the right way to find out.
 */
export function receiverNameMatches(found: string, expected: string): boolean {
    const normalise = (value: string) =>
        value
            .toLowerCase()
            .normalize('NFKC')
            // Keep letters and digits in every script; drop punctuation, spaces
            // and separators. \p{L}\p{N} rather than [a-z0-9] is the whole point.
            .replace(/[^\p{L}\p{N}]/gu, '');
    const a = normalise(found);
    const b = normalise(expected);
    // A floor rather than just non-empty: if normalisation somehow collapses a
    // name to a token or two, two different payees could collide, so refuse to
    // decide on so little.
    return a.length >= 3 && a === b;
}

/**
 * Check the receipt against the payout account it was expected to reach.
 *
 * `useCbeAccountRule` selects the CBE masked comparison for full account
 * numbers; every other provider compares phones and account numbers directly.
 */
export function checkReceiptRecipient(params: {
    foundAccount: unknown;
    expectedAccount: string;
    /** Receiver name from the receipt, when the provider prints one. */
    foundName?: unknown;
    /** `PayoutAccount.accountHolderName` — null when the merchant never set it. */
    expectedHolderName?: string | null;
    useCbeAccountRule?: boolean;
}): RecipientCheckResult {
    const { expectedAccount, useCbeAccountRule = false } = params;
    const expected = expectedAccount.trim();
    const expectedDigits = stripSeparators(expected);

    const raw = typeof params.foundAccount === 'string' ? params.foundAccount.trim() : '';
    const found = raw === '' ? null : raw;

    // 1. A full account number is the strongest evidence there is. Strip the
    //    separators a bank prints between groups first, so 5155 1047 39011 and
    //    5155104739011 are recognised as the same account before anything else
    //    gets a chance to call them different.
    if (found !== null && !isMaskedAccount(found)) {
        if (expectedDigits !== '' && stripSeparators(found) === expectedDigits) {
            return { ok: true, foundAccount: found, matchedOn: 'account' };
        }
        const matches = useCbeAccountRule
            ? cbeAccountMatches(found, expected)
            : accountMatches(found, expected);
        return matches
            ? { ok: true, foundAccount: found, matchedOn: 'account' }
            : mismatch(found, expected, 'account');
    }

    // 2. Masked but legible: the digits still shown must line up. A mask that
    //    hides every digit tells us nothing either way, so it is not a mismatch.
    if (found !== null) {
        const visible = (found.match(/\d+/g) ?? []).join('');
        if (visible === '') {
            return notVerifiable(expected);
        }
        return maskedAccountMatches(found, expectedDigits || expected)
            ? { ok: true, foundAccount: found, matchedOn: 'maskedAccount' }
            : mismatch(found, expected, 'maskedAccount');
    }

    // 3. No account at all. Some providers — Dashen among them — identify the
    //    beneficiary by name only, so the name is the only identifier there is.
    const rawName = typeof params.foundName === 'string' ? params.foundName.trim() : '';
    const expectedName = typeof params.expectedHolderName === 'string' ? params.expectedHolderName.trim() : '';
    if (rawName !== '' && expectedName !== '') {
        return receiverNameMatches(rawName, expectedName)
            ? { ok: true, foundAccount: null, matchedOn: 'receiverName' }
            : {
                ...mismatch(null, expected, 'receiverName'),
                error:
                    `The receipt names "${rawName}" as the receiver, but the selected payout account ` +
                    `is held by "${expectedName}".`,
            };
    }

    // 4. Nothing on the receipt that identifies the destination. Not a pass:
    //    an unreadable field and a provider that never printed one look the
    //    same from here, so say that rather than guessing which it was.
    return notVerifiable(expected);
}

/**
 * "Nothing to check against" — one reason for every shape it arrives in, because
 * an unreadable field, a fully masked account and a provider that never prints
 * one are indistinguishable from here. Claiming a mismatch would point an
 * operator at the wrong problem.
 */
function notVerifiable(expected: string): RecipientCheckResult {
    return {
        ok: false,
        reason: 'RECIPIENT_NOT_VERIFIABLE',
        error:
            'This receipt does not show a destination account or a receiver name that can be matched, ' +
            'so it cannot be confirmed as a payment to the selected payout account. Reject it, or have ' +
            'the payer supply a reference that can be checked against the provider directly.',
        expectedAccount: expected,
        foundAccount: null,
    };
}

function mismatch(found: string | null, expected: string, matchedOn: string): RecipientCheckResult {
    return {
        ok: false,
        reason: 'RECIPIENT_MISMATCH',
        error: `The payment was not sent to the selected payout account. Expected ${expected}, receipt shows ${found}.`,
        expectedAccount: expected,
        foundAccount: found,
        matchedOn: matchedOn as RecipientCheckResult['matchedOn'],
    };
}