/**
 * USSD payout provider registry.
 *
 * A PayoutIntent names one of these providers; an Android device agent dials
 * the provider's USSD code on a SIM funded by the workspace and executes the
 * transfer. The registry is the single source of what can be paid out and how:
 * the dial root, the destination shape, the amount bounds. Agents treat the
 * actual menu navigation as theirs to adapt (menus drift), so the registry
 * deliberately does not encode per-menu step numbers.
 */

export interface PayoutUssdProvider {
    /** Canonical slug, matching src/utils/payoutInput.ts vocabulary. */
    provider: string;
    displayName: string;
    /** Root USSD code the agent starts dialling. */
    ussdCode: string;
    /** What `destination` holds. */
    destinationKind: 'msisdn' | 'bank' | 'any';
    enabled: boolean;
    minAmount: number;
    maxAmount: number;
}

const AMOUNT_CAP = Math.max(1, Number(process.env.PAYOUT_USSD_MAX_AMOUNT_ETB ?? 100_000));

const REGISTRY: Record<string, PayoutUssdProvider> = {
    telebirr: {
        provider: 'telebirr',
        displayName: 'Telebirr',
        ussdCode: '*127#',
        destinationKind: 'msisdn',
        enabled: true,
        minAmount: 1,
        maxAmount: AMOUNT_CAP,
    },
    cbebirr: {
        provider: 'cbebirr',
        displayName: 'CBE Birr',
        ussdCode: '*848#',
        destinationKind: 'msisdn',
        enabled: true,
        minAmount: 1,
        maxAmount: AMOUNT_CAP,
    },
    dashen: {
        provider: 'dashen',
        displayName: 'Dashen (HelloCash)',
        ussdCode: '*644#',
        destinationKind: 'any',
        enabled: true,
        minAmount: 1,
        maxAmount: AMOUNT_CAP,
    },
    mpesa: {
        provider: 'mpesa',
        displayName: 'M-Pesa',
        ussdCode: '*334#',
        destinationKind: 'msisdn',
        enabled: false,
        minAmount: 1,
        maxAmount: AMOUNT_CAP,
    },
    cbe: {
        provider: 'cbe',
        displayName: 'CBE bank account',
        ussdCode: '*848#',
        destinationKind: 'bank',
        enabled: true,
        minAmount: 1,
        maxAmount: AMOUNT_CAP,
    },
};

export function listUssdPayoutProviders(): PayoutUssdProvider[] {
    return Object.values(REGISTRY).map((entry) => ({ ...entry }));
}

export function getUssdPayoutProvider(provider: string): PayoutUssdProvider | null {
    const entry = REGISTRY[provider];
    return entry ? { ...entry } : null;
}

export function isUssdPayoutEnabled(provider: string): boolean {
    return REGISTRY[provider]?.enabled === true;
}

export function validatePayoutIntentDestination(provider: string, destination: string): string | null {
    const entry = REGISTRY[provider];
    if (!entry) return 'Unknown provider.';
    if (entry.destinationKind === 'msisdn' && !isValidPhone(destination)) {
        return `The ${entry.displayName} destination must be a valid Ethiopian phone number (09/07/251 format).`;
    }
    if (entry.destinationKind === 'bank' && !isValidBankAccount(destination)) {
        return `The ${entry.displayName} destination must be a 13-16 digit bank account number.`;
    }
    if (entry.destinationKind === 'any'
        && !isValidPhone(destination) && !isValidBankAccount(destination)) {
        return `The ${entry.displayName} destination must be a phone number or a 13-16 digit bank account number.`;
    }
    return null;
}

export function validatePayoutIntentAmount(provider: string, amount: number): string | null {
    const entry = REGISTRY[provider];
    if (!entry) return 'Unknown provider.';
    if (!Number.isFinite(amount) || amount <= 0) {
        return 'amount must be a positive number of ETB.';
    }
    if (amount < entry.minAmount) {
        return `amount must be at least ${entry.minAmount} ETB.`;
    }
    if (amount > entry.maxAmount) {
        return `amount must be at most ${entry.maxAmount} ETB.`;
    }
    return null;
}

function isValidPhone(account: string): boolean {
    return /^(09|07)\d{8}$/.test(account) || /^251(9|7)\d{8}$/.test(account);
}

function isValidBankAccount(account: string): boolean {
    return /^\d{13,16}$/.test(account);
}

/** The USSD specs an agent needs for a poll batch. */
export function dialSpec(provider: string): { ussdCode: string; destinationKind: string } | null {
    const entry = REGISTRY[provider];
    if (!entry) return null;
    return { ussdCode: entry.ussdCode, destinationKind: entry.destinationKind };
}
