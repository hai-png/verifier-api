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
 * When the caller supplies a payout account, this module makes that check
 * enforceable. Two things have to hold, and both fail closed:
 *
 *  - the account the receipt names must match the expected one, and
 *  - the account must be *legible*. `accountMatches()` deliberately treats a
 *    null verified account as a pass, because a provider that does not return
 *    one (Dashen) is not evidence of a mismatch. In OCR that reasoning inverts:
 *    a missing field means Mistral did not read it, not that nothing was wrong.
 *    So an unreadable account is reported separately and never passes here.
 */
export type RecipientFailureReason =
    | 'RECIPIENT_UNREADABLE'
    | 'RECIPIENT_MISMATCH'
    | 'PROVIDER_NOT_ALLOWED';

export interface RecipientCheckResult {
    ok: boolean;
    /** Absent when ok. */
    reason?: RecipientFailureReason;
    error?: string;
    expectedAccount?: string;
    /** What the receipt actually named. Null when OCR could not read it. */
    foundAccount?: string | null;
}

/** A payout account's `providersAllowed` is a Json array, so it needs narrowing. */
export function payoutAccountAllowsProvider(providersAllowed: unknown, provider: string): boolean {
    if (!Array.isArray(providersAllowed)) return false;
    return (providersAllowed as unknown[]).some(
        (value) => typeof value === 'string' && value.trim().toLowerCase() === provider.trim().toLowerCase(),
    );
}

/**
 * Compare the account a receipt names against the payout account it was
 * expected to reach.
 *
 * `useCbeAccountRule` selects the padded CBE comparison, which strips
 * insignificant leading zeros before matching; every other provider compares
 * phones and account numbers directly.
 */
export function checkReceiptRecipient(params: {
    foundAccount: unknown;
    expectedAccount: string;
    useCbeAccountRule?: boolean;
}): RecipientCheckResult {
    const { expectedAccount, useCbeAccountRule = false } = params;
    const expected = expectedAccount.trim();

    const raw = typeof params.foundAccount === 'string' ? params.foundAccount.trim() : '';
    const found = raw === '' ? null : raw;

    if (found === null) {
        return {
            ok: false,
            reason: 'RECIPIENT_UNREADABLE',
            error:
                'The receipt image did not contain a legible destination account, so it cannot be ' +
                'confirmed as a payment to the selected payout account. Reject it, or have the ' +
                'payer supply a reference that can be checked against the provider directly.',
            expectedAccount: expected,
            foundAccount: null,
        };
    }

    const matches = useCbeAccountRule
        ? cbeAccountMatches(found, expected)
        : accountMatches(found, expected);

    if (!matches) {
        return {
            ok: false,
            reason: 'RECIPIENT_MISMATCH',
            error: `The payment was not sent to the selected payout account. Expected ${expected}, receipt shows ${found}.`,
            expectedAccount: expected,
            foundAccount: found,
        };
    }

    return { ok: true, foundAccount: found };
}