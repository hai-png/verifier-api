import { prisma } from '../utils/prisma';
import logger from '../utils/logger';

export interface BillingConfig {
  proPriceMonthlyETB: number;
  businessPriceMonthlyETB: number;
  discount3MonthsPercent: number;
  discount6MonthsPercent: number;
  discount12MonthsPercent: number;
  freeQuotaNewMonthly: number;
  freeQuotaLegacyMonthly: number;
  proQuotaMonthly: number;
  businessQuotaMonthly: number;
  freeRateLimit: number;
  proRateLimit: number;
  businessRateLimit: number;
  freeImageCredits: number;
  proImageCredits: number;
  businessImageCredits: number;
  freeBatchMaxReferences: number;
  proBatchMaxReferences: number;
  businessBatchMaxReferences: number;
  freeWebhookLimit: number;
  proWebhookLimit: number;
  businessWebhookLimit: number;
  freeNotificationChannelLimit: number;
  proNotificationChannelLimit: number;
  businessNotificationChannelLimit: number;
  businessUnlimitedVerifications: boolean;
}

export const DEFAULT_BILLING_CONFIG: BillingConfig = {
  proPriceMonthlyETB: Number(process.env.VERITAS_PRO_PRICE ?? 199),
  businessPriceMonthlyETB: Number(process.env.VERITAS_BUSINESS_PRICE ?? 499),
  discount3MonthsPercent: 10,
  discount6MonthsPercent: 18,
  discount12MonthsPercent: 30,
  freeQuotaNewMonthly: 100,
  freeQuotaLegacyMonthly: 250,
  proQuotaMonthly: 2000,
  businessQuotaMonthly: 50000,
  freeRateLimit: 10,
  proRateLimit: 60,
  businessRateLimit: 300,
  freeImageCredits: 0,
  proImageCredits: 100,
  businessImageCredits: 300,
  freeBatchMaxReferences: 0,
  proBatchMaxReferences: 20,
  businessBatchMaxReferences: 100,
  freeWebhookLimit: 0,
  proWebhookLimit: 20,
  businessWebhookLimit: 50,
  freeNotificationChannelLimit: 0,
  proNotificationChannelLimit: 0,
  businessNotificationChannelLimit: 20,
  businessUnlimitedVerifications: false,
};

const NON_NEGATIVE_INTEGER_FIELDS = [
  'freeQuotaNewMonthly',
  'freeQuotaLegacyMonthly',
  'proQuotaMonthly',
  'businessQuotaMonthly',
  'freeImageCredits',
  'proImageCredits',
  'businessImageCredits',
  'freeWebhookLimit',
  'proWebhookLimit',
  'businessWebhookLimit',
  'freeNotificationChannelLimit',
  'proNotificationChannelLimit',
  'businessNotificationChannelLimit',
] as const satisfies readonly (keyof BillingConfig)[];

const POSITIVE_INTEGER_FIELDS = [
  'proPriceMonthlyETB',
  'businessPriceMonthlyETB',
  'freeRateLimit',
  'proRateLimit',
  'businessRateLimit',
] as const satisfies readonly (keyof BillingConfig)[];

const BATCH_LIMIT_FIELDS = [
  'freeBatchMaxReferences',
  'proBatchMaxReferences',
  'businessBatchMaxReferences',
] as const satisfies readonly (keyof BillingConfig)[];

const DISCOUNT_FIELDS = [
  'discount3MonthsPercent',
  'discount6MonthsPercent',
  'discount12MonthsPercent',
] as const satisfies readonly (keyof BillingConfig)[];

const CONFIG_FIELDS = new Set<keyof BillingConfig>(Object.keys(DEFAULT_BILLING_CONFIG) as (keyof BillingConfig)[]);

export class BillingConfigValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(issues.join(' '));
    this.name = 'BillingConfigValidationError';
  }
}

export function validateBillingConfigUpdate(input: unknown): Partial<BillingConfig> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BillingConfigValidationError(['Configuration must be an object.']);
  }

  const candidate = input as Record<string, unknown>;
  const issues: string[] = [];
  const update: Partial<BillingConfig> = {};

  for (const key of Object.keys(candidate)) {
    if (!CONFIG_FIELDS.has(key as keyof BillingConfig)) {
      issues.push(`Unknown configuration field: ${key}.`);
    }
  }

  const validateInteger = (field: keyof BillingConfig, minimum: number, maximum?: number): void => {
    if (!(field in candidate)) return;
    const value = candidate[field];
    if (!Number.isInteger(value) || (value as number) < minimum || (maximum !== undefined && (value as number) > maximum)) {
      const range = maximum === undefined ? `${minimum} or greater` : `between ${minimum} and ${maximum}`;
      issues.push(`${field} must be an integer ${range}.`);
      return;
    }
    (update as Record<string, unknown>)[field] = value;
  };

  for (const field of NON_NEGATIVE_INTEGER_FIELDS) validateInteger(field, 0);
  for (const field of POSITIVE_INTEGER_FIELDS) validateInteger(field, 1);
  for (const field of BATCH_LIMIT_FIELDS) validateInteger(field, 0, 500);
  for (const field of DISCOUNT_FIELDS) validateInteger(field, 0, 100);

  if ('businessUnlimitedVerifications' in candidate) {
    if (typeof candidate.businessUnlimitedVerifications !== 'boolean') {
      issues.push('businessUnlimitedVerifications must be an explicit Boolean.');
    } else {
      update.businessUnlimitedVerifications = candidate.businessUnlimitedVerifications;
    }
  }

  if (issues.length > 0) throw new BillingConfigValidationError(issues);
  return update;
}

// ─── Cache ────────────────────────────────────────────────────────────────────
// getBillingConfig() is called on every authenticated request — twice per
// verification (rate limiter + quota gate). Each call is a database round trip,
// which is ~150 ms against a cross-region database. The pricing row changes
// rarely, so cache it briefly and invalidate on write.
const BILLING_CONFIG_CACHE_TTL_MS = Number(process.env.BILLING_CONFIG_CACHE_TTL_MS ?? 30_000);

let cachedBillingConfig: { value: BillingConfig; expiresAt: number; loadedAt: number } | null = null;
let cacheGeneration = 0;
let inflightBillingConfig: Promise<BillingConfig> | null = null;

/** Drop the cached pricing row (called after an admin update). */
export function invalidateBillingConfigCache(): void {
  cachedBillingConfig = null;
  inflightBillingConfig = null;
  cacheGeneration += 1;
}

export function billingConfigCacheState(): { cached: boolean; expiresInMs: number | null; ttlMs: number } {
  return {
    cached: cachedBillingConfig !== null,
    expiresInMs: cachedBillingConfig ? Math.max(0, cachedBillingConfig.expiresAt - Date.now()) : null,
    ttlMs: BILLING_CONFIG_CACHE_TTL_MS,
  };
}

// Stale-while-revalidate: once a value is cached, an expired entry is still
// served immediately while ONE background refresh runs. Only a cold cache (or
// one older than the max-stale bound) makes a request wait on the database.
// Admin updates on this instance invalidate synchronously; other instances pick
// the change up within TTL + one refresh round trip.
const BILLING_CONFIG_MAX_STALE_MS = Number(process.env.BILLING_CONFIG_MAX_STALE_MS ?? 5 * 60_000);

async function loadBillingConfig(): Promise<BillingConfig> {
  const record = await prisma.planPricingConfig.findUnique({
    where: { id: 'default' },
    select: {
      proPriceMonthlyETB: true,
      businessPriceMonthlyETB: true,
      discount3MonthsPercent: true,
      discount6MonthsPercent: true,
      discount12MonthsPercent: true,
      freeQuotaNewMonthly: true,
      freeQuotaLegacyMonthly: true,
      proQuotaMonthly: true,
      businessQuotaMonthly: true,
      freeRateLimit: true,
      proRateLimit: true,
      businessRateLimit: true,
      freeImageCredits: true,
      proImageCredits: true,
      businessImageCredits: true,
      freeBatchMaxReferences: true,
      proBatchMaxReferences: true,
      businessBatchMaxReferences: true,
      freeWebhookLimit: true,
      proWebhookLimit: true,
      businessWebhookLimit: true,
      freeNotificationChannelLimit: true,
      proNotificationChannelLimit: true,
      businessNotificationChannelLimit: true,
      businessUnlimitedVerifications: true,
    },
  });
  return record ?? DEFAULT_BILLING_CONFIG;
}

function refreshBillingConfig(): Promise<BillingConfig> {
  if (inflightBillingConfig) return inflightBillingConfig;
  const generation = cacheGeneration;
  const pending: Promise<BillingConfig> = loadBillingConfig()
    .then((value) => {
      // An invalidation during the load means this value may predate an admin
      // write; do not let it overwrite the cache.
      if (generation === cacheGeneration) {
        cachedBillingConfig = { value, expiresAt: Date.now() + BILLING_CONFIG_CACHE_TTL_MS, loadedAt: Date.now() };
      }
      return value;
    })
    .finally(() => {
      if (inflightBillingConfig === pending) inflightBillingConfig = null;
    });
  inflightBillingConfig = pending;
  return pending;
}

export async function getBillingConfig(): Promise<BillingConfig> {
  if (BILLING_CONFIG_CACHE_TTL_MS <= 0) return loadBillingConfig();

  const now = Date.now();
  const cached = cachedBillingConfig;
  if (cached && cached.expiresAt > now) return cached.value;

  if (cached && now - cached.loadedAt < BILLING_CONFIG_MAX_STALE_MS) {
    refreshBillingConfig().catch((error) => {
      logger.warn('Background billing config refresh failed; serving cached value.', { error: (error as Error)?.message });
    });
    return cached.value;
  }

  // Cold (or too stale): wait, coalescing concurrent misses into one query.
  return refreshBillingConfig();
}

export async function updateBillingConfig(input: unknown): Promise<BillingConfig> {
  const update = validateBillingConfigUpdate(input);
  if (Object.keys(update).length === 0) {
    throw new BillingConfigValidationError(['Provide at least one configuration field.']);
  }

  const record = await prisma.planPricingConfig.upsert({
    where: { id: 'default' },
    update,
    create: { id: 'default', ...DEFAULT_BILLING_CONFIG, ...update },
  });

  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...config } = record;
  invalidateBillingConfigCache();
  return config;
}
