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

/**
 * What the `type` column stores. UNIFIED is derived from the provider set on
 * every write and never accepted from a client: it means the record's
 * destinations do not share one account number, so the PHONE/BANK distinction
 * no longer describes it.
 */
export type StoredPayoutType = PayoutType | 'UNIFIED';

export function allPayoutProviders(): string[] {
    return [...PHONE_PROVIDERS, ...BANK_PROVIDERS];
}

/** Which format `provider`'s destination must be in, or null when unsupported. */
export function providerCategory(provider: string): PayoutType | null {
    if ((PHONE_PROVIDERS as readonly string[]).includes(provider)) return 'PHONE';
    if ((BANK_PROVIDERS as readonly string[]).includes(provider)) return 'BANK';
    return null;
}

export function derivePayoutType(providers: string[]): StoredPayoutType {
    const categories = new Set(providers.map((provider) => providerCategory(provider)));
    if (categories.size > 1) return 'UNIFIED';
    return categories.has('BANK') ? 'BANK' : 'PHONE';
}

/**
 * The per-provider destination map.
 *
 * `undefined`/`null` normalises to `{}` — the legacy shape, where every
 * allowed provider falls back to the record's single `account`. A supplied
 * value must be a plain object whose keys name supported providers and whose
 * values are non-empty strings, or the whole write is 'invalid' rather than
 * half-applied.
 */
export function normaliseProviderAccounts(input: unknown): Record<string, string> | 'invalid' {
    if (input === undefined || input === null) return {};
    if (typeof input !== 'object' || Array.isArray(input)) return 'invalid';

    const map: Record<string, string> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
        const provider = canonicalProvider(key);
        if (providerCategory(provider) === null) return 'invalid';
        if (typeof value !== 'string' || value.trim() === '') return 'invalid';
        map[provider] = value.trim();
    }
    return map;
}

export function validateProviderDestination(provider: string, account: string): string | null {
    const category = providerCategory(provider);
    if (category === 'PHONE' && !isValidPhone(account)) {
        return `The ${provider} destination must be a valid Ethiopian phone number (09/07/251 format).`;
    }
    if (category === 'BANK' && !isValidBankAccount(account)) {
        return `The ${provider} destination must be a 13-16 digit bank account number.`;
    }
    return null;
}

export interface PayoutWriteInput {
    account?: unknown;
    providersAllowed?: unknown;
    providerAccounts?: unknown;
}

export interface ResolvedPayout {
    type: StoredPayoutType;
    account: string;
    providersAllowed: string[];
    providerAccounts: Record<string, string>;
}

/**
 * Resolve the (type, account, providers, providerAccounts) state a create or
 * edit results in under the unified model.
 *
 * `current` is null on create. Providers without an explicit entry in the
 * resulting map fall back to the plain `account` — the one supplied in this
 * write, or the stored one — because that is the legacy contract: one number
 * serving every provider it is allowed for. A provider with neither an entry
 * nor a fallback is refused rather than silently matched against another
 * provider's number.
 *
 * Only explicitly-supplied entries are stored. Auto-filling the map from the
 * fallback would freeze today's number into every provider, and a later
 * `account` edit would then change nothing.
 */
export function resolvePayoutState(
    current: { account: string; providersAllowed: unknown; providerAccounts: unknown } | null,
    input: PayoutWriteInput,
): { data: ResolvedPayout } | { error: string } {
    const providers = input.providersAllowed !== undefined
        ? normaliseProviders(input.providersAllowed)
        : (current ? normaliseProviders(current.providersAllowed) : []);

    if (providers.length === 0) {
        return { error: 'providersAllowed must include at least one provider.' };
    }
    const unsupported = providers.filter((provider) => providerCategory(provider) === null);
    if (unsupported.length > 0) {
        return { error: `providersAllowed contains unsupported providers: ${unsupported.join(', ')}. Valid: ${allPayoutProviders().join(', ')}.` };
    }

    const stored = normaliseProviderAccounts(current?.providerAccounts);
    if (stored === 'invalid') {
        return { error: 'providerAccounts must map provider → account number, with non-empty string values.' };
    }
    const incoming = normaliseProviderAccounts(input.providerAccounts);
    if (incoming === 'invalid') {
        return { error: 'providerAccounts must map provider → account number, with non-empty string values.' };
    }
    // When the field is absent this is a PATCH that did not touch the map, so
    // stored entries for still-selected providers apply. When it is present,
    // it is a partial update: entries it names override the stored ones, and
    // providers it does not mention keep theirs.
    const base = input.providerAccounts === undefined ? stored : { ...stored, ...incoming };

    let fallback: string | null = null;
    if (input.account !== undefined) {
        const normalised = normaliseAccount(input.account);
        if (normalised === 'invalid') return { error: 'account must be a non-empty string.' };
        if (!isValidPayoutAccount(normalised)) return { error: 'account must be at most 191 bytes.' };
        fallback = normalised;
    } else if (current) {
        fallback = current.account;
    }

    const map: Record<string, string> = {};
    const destinations: Record<string, string> = {};
    const missing: string[] = [];
    for (const provider of providers) {
        const explicit = base[provider];
        const destination = explicit ?? fallback;
        if (!destination) {
            missing.push(provider);
            continue;
        }
        const problem = validateProviderDestination(provider, destination);
        if (problem) return { error: problem };
        destinations[provider] = destination;
        if (explicit) map[provider] = explicit;
    }
    if (missing.length > 0) {
        return { error: `No account number for: ${missing.join(', ')}. Provide providerAccounts for each, or a single account.` };
    }

    return {
        data: {
            type: derivePayoutType(providers),
            // Derived, not defaulted: a create that gave only providerAccounts
            // still needs the legacy column filled, and the first provider's
            // destination is the least surprising stand-in.
            account: fallback ?? destinations[providers[0]],
            providersAllowed: providers,
            providerAccounts: map,
        },
    };
}

export function normaliseOptionalLabel(input: unknown): string | null | 'invalid' {
    if (input === undefined) return null;
    if (typeof input !== 'string') return 'invalid';
    const trimmed = input.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function normalisePayoutType(input: unknown): PayoutType | null {
    if (input === 'PHONE' || input === 'BANK') return input;
    // Case-insensitive, because the dashboard previously sent neither and every
    // other value fell through to the bank branch, passed validation as a bank
    // account, and then reached prisma.payoutAccount.create({ data: { type } })
    // as an invalid enum — a 500 where the caller could have been told 400.
    if (typeof input === 'string') {
        const upper = input.trim().toUpperCase();
        if (upper === 'PHONE' || upper === 'BANK') return upper;
    }
    return null;
}

export function normaliseAccount(input: unknown): string | 'invalid' {
    if (typeof input !== 'string') return 'invalid';
    const trimmed = input.trim();
    return trimmed.length > 0 ? trimmed : 'invalid';
}

/** Length caps for the two PayoutAccount string columns. See utils/fieldLimits. */
export function isValidPayoutLabel(label: string): boolean {
    return Buffer.byteLength(label, 'utf8') <= 191;
}

export function isValidPayoutAccount(account: string): boolean {
    return Buffer.byteLength(account, 'utf8') <= 191;
}

/**
 * Provider spellings that mean the same provider.
 *
 * The verification engine accepts these aliases (verifyUniversal.ts maps
 * `m-pesa`, `cbe-birr` and `cbe_birr`), so a caller reading that vocabulary
 * naturally sends one. `normaliseProviders` lower-cased but did not canonicalise,
 * so `M-Pesa` was stored verbatim, rejected by validatePayoutInput's
 * allow-list *and* invisible to ensureProviderCoverage, which matches on
 * `'mpesa'`. The account then sat in the database accepted by nothing and matched
 * no receipt — while a test asserted the buggy output as correct.
 */
const PROVIDER_ALIASES: Record<string, string> = {
    'm-pesa': 'mpesa',
    'm pesa': 'mpesa',
    'mpesa': 'mpesa',
    'cbe-birr': 'cbebirr',
    'cbe_birr': 'cbebirr',
    'cbebirr': 'cbebirr',
    'cbe birr': 'cbebirr',
    telebirr: 'telebirr',
    cbe: 'cbe',
    dashen: 'dashen',
    abyssinia: 'abyssinia',
    zemen: 'zemen',
    awash: 'awash',
};

export function canonicalProvider(value: string): string {
    const key = value.trim().toLowerCase().replace(/\s+/g, '-');
    return PROVIDER_ALIASES[key] ?? key;
}

export function normaliseProviders(input: unknown): string[] {
    if (!Array.isArray(input)) return [];
    return [
        ...new Set(
            input
                .filter((value): value is string => typeof value === 'string')
                .map((value) => canonicalProvider(value))
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
    if (!isValidPayoutAccount(account)) {
        return 'account must be at most 191 bytes.';
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
    if (label !== null) {
        if (!isValidPayoutLabel(label)) return { error: 'label must be at most 191 bytes.' };
        data.label = label;
    }

    if (input.accountHolderName !== undefined) {
        const holder = normaliseOptionalLabel(input.accountHolderName);
        if (holder === 'invalid') return { error: 'accountHolderName must be a string.' };
        if (holder !== null && !isValidPayoutLabel(holder)) {
            return { error: 'accountHolderName must be at most 191 bytes.' };
        }
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
