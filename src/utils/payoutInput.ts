/**
 * Shared validation for payout accounts.
 *
 * These lived privately in payouts.ts, so the dashboard's own
 * POST /dashboard/:workspaceId/payouts — which is what the UI actually calls —
 * validated nothing at all. You could save an account with a malformed phone
 * number, and it would then be offered as the expected recipient and quietly
 * never match a receipt. Both entry points now go through this one module.
 */

export const PHONE_PROVIDERS = ['telebirr', 'cbebirr', 'mpesa'] as const;
export const BANK_PROVIDERS = ['cbe', 'dashen', 'abyssinia'] as const;

export type PayoutType = 'PHONE' | 'BANK';

export function normaliseOptionalLabel(input: unknown): string | null | 'invalid' {
    if (input === undefined) return null;
    if (typeof input !== 'string') return 'invalid';
    const trimmed = input.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function normalisePayoutType(input: unknown): PayoutType | null {
    if (input === 'PHONE' || input === 'BANK') return input;
    return null;
}

export function normaliseAccount(input: unknown): string | 'invalid' {
    if (typeof input !== 'string') return 'invalid';
    const trimmed = input.trim();
    return trimmed.length > 0 ? trimmed : 'invalid';
}

export function normaliseProviders(input: unknown): string[] {
    if (!Array.isArray(input)) return [];
    return [
        ...new Set(
            input
                .filter((value): value is string => typeof value === 'string')
                .map((value) => value.trim().toLowerCase())
                .filter((value) => value.length > 0),
        ),
    ];
}

export function isValidPhone(account: string): boolean {
    return /^(09|07)\d{8}$/.test(account) || /^251(9|7)\d{8}$/.test(account);
}

export function isValidBankAccount(account: string): boolean {
    return /^\d{13,16}$/.test(account);
}

export function validatePayoutInput(
    type: PayoutType,
    account: string,
    providersAllowed: string[],
): string | null {
    if (providersAllowed.length === 0) {
        return 'providersAllowed must include at least one provider.';
    }

    if (type === 'PHONE') {
        if (!isValidPhone(account)) {
            return 'account must be a valid Ethiopian phone number (09/07/251 format).';
        }
        const bad = providersAllowed.filter((provider) => !PHONE_PROVIDERS.includes(provider as (typeof PHONE_PROVIDERS)[number]));
        if (bad.length > 0) {
            return `Phone accounts cannot accept: ${bad.join(', ')}. Valid: ${PHONE_PROVIDERS.join(', ')}.`;
        }
        return null;
    }

    if (!isValidBankAccount(account)) {
        return 'account must be a 13-16 digit bank account number.';
    }
    if (providersAllowed.length !== 1) {
        return 'Bank accounts must be assigned to exactly one bank provider.';
    }
    const bad = providersAllowed.filter((provider) => !BANK_PROVIDERS.includes(provider as (typeof BANK_PROVIDERS)[number]));
    if (bad.length > 0) {
        return `Bank accounts cannot accept: ${bad.join(', ')}. Valid: ${BANK_PROVIDERS.join(', ')}.`;
    }
    return null;
}

/** The fields a dashboard edit may change. */
export interface PayoutEditInput {
    label?: unknown;
    accountHolderName?: unknown;
    account?: unknown;
    providersAllowed?: unknown;
}

export interface PayoutEdit {
    /** Never null: a label is required, so a blank one is simply not sent. */
    label?: string;
    accountHolderName?: string | null;
    account?: string;
    providersAllowed?: string[];
}

/**
 * A stand-in used when one half of the (type, account, providers) triple is not
 * part of this edit and so cannot be checked against the real value. Chosen to
 * satisfy the format rules, so only the field actually being changed can fail.
 */
function placeholderAccount(type: PayoutType): string {
    return type === 'PHONE' ? '0911223344' : '1000123456789012';
}

function placeholderProviders(type: PayoutType): string[] {
    return [type === 'PHONE' ? 'telebirr' : 'cbe'];
}

/**
 * Validate a partial edit, re-checking the type/provider pairing when the
 * providers change. A bank account is pinned to exactly one bank, so swapping its
 * providers to two at once has to be refused rather than half-applied.
 */
export function validatePayoutEdit(
    current: { type: PayoutType },
    input: PayoutEditInput,
): { data: PayoutEdit } | { error: string } {
    const data: PayoutEdit = {};
    const type = current.type;

    const label = normaliseOptionalLabel(input.label);
    if (label === 'invalid') return { error: 'label must be a string.' };
    if (label !== null) data.label = label;

    if (input.accountHolderName !== undefined) {
        const holder = normaliseOptionalLabel(input.accountHolderName);
        if (holder === 'invalid') return { error: 'accountHolderName must be a string.' };
        data.accountHolderName = holder;
    }

    if (input.account !== undefined) {
        const account = normaliseAccount(input.account);
        if (account === 'invalid') return { error: 'account must be a non-empty string.' };
        data.account = account;
    }

    if (input.providersAllowed !== undefined) {
        const providers = normaliseProviders(input.providersAllowed);
        // Checked with the account this edit supplies, or a valid placeholder if
        // it is not part of it, so an untouched field cannot cause the failure.
        const problem = validatePayoutInput(type, data.account ?? placeholderAccount(type), providers);
        if (problem) return { error: problem };
        data.providersAllowed = providers;
    }

    // The account may also have been changed on its own.
    if (data.account !== undefined && input.providersAllowed === undefined) {
        const problem = validatePayoutInput(type, data.account, placeholderProviders(type));
        if (problem) return { error: problem };
    }

    return { data };
}
