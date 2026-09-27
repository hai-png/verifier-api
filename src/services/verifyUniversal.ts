/** One validation/planning and provider-dispatch engine for every entry point.
 * HTTP authentication/billing and commerce settlement remain outside this layer.
 */
import { verifyCBE } from './verifyCBE';
import { verifyTelebirr } from './verifyTelebirr';
import { verifyDashen } from './verifyDashen';
import { verifyAbyssinia } from './verifyAbyssinia';
import { verifyCBEBirr } from './verifyCBEBirr';
import { verifyAwash } from './verifyAwash';
import { verifyZemen } from './verifyZemen';
import { verifyMpesa } from './verifyMpesa';
import { extractLegacyCbeUrlData, extractNewCbeToken, isLegacyCbeReference } from '../utils/cbeReference';
import logger from '../utils/logger';

export interface SmartVerifyInput {
  reference: string;
  suffix?: string;
  phoneNumber?: string;
  provider?: string;
  /** Compatibility only; credentials are never sent to provider services. */
  apiKey?: string;
}
export type SmartVerifyProvider = 'CBE' | 'CBE_BIRR' | 'TELEBIRR' | 'DASHEN' | 'ABYSSINIA' | 'MPESA' | 'AWASH' | 'ZEMEN' | 'IMAGE';
export interface SmartVerifyResult {
  success: boolean;
  data?: unknown;
  error?: string;
  details?: unknown;
  provider?: SmartVerifyProvider;
  httpStatus: number;
}
export interface VerificationPlan {
  provider: Exclude<SmartVerifyProvider, 'IMAGE'> | 'AWASH_ZEMEN';
  reference: string;
  suffix?: string;
  phoneNumber?: string;
}
export type VerificationPreparation = { ok: true; plan: VerificationPlan } | { ok: false; result: SmartVerifyResult };
const providers: Record<string, VerificationPlan['provider']> = {
  cbe: 'CBE', cbebirr: 'CBE_BIRR', 'cbe-birr': 'CBE_BIRR', cbe_birr: 'CBE_BIRR',
  telebirr: 'TELEBIRR', dashen: 'DASHEN', abyssinia: 'ABYSSINIA', mpesa: 'MPESA',
  'm-pesa': 'MPESA', awash: 'AWASH', zemen: 'ZEMEN',
};

/** Pure: rejects malformed data before any quota mutation or provider I/O. */
export function prepareVerification(input: unknown): VerificationPreparation {
  const bad = (error: string): VerificationPreparation => ({ ok: false, result: { success: false, error, httpStatus: 400 } });
  if (!input || typeof input !== 'object' || Array.isArray(input)) return bad('Verification input must be an object.');
  const body = input as Record<string, unknown>;
  // Legacy aliases converge here, including GET query parameters. Reject
  // conflicting aliases rather than billing/caching a different receipt.
  const read = (key: string, alias?: string): string | undefined => {
    const values = [body[key], ...(alias ? [body[alias]] : [])].filter((v) => v !== undefined);
    if (values.some((v) => typeof v !== 'string')) throw new Error(`${key} must be a string.`);
    const strings = (values as string[]).map((v) => v.trim());
    if (strings.some((v) => v !== strings[0])) throw new Error(`Conflicting ${key} aliases.`);
    return strings[0] || undefined;
  };
  try {
    let reference = read('reference', 'receiptNumber');
    let suffix = read('suffix', 'accountSuffix');
    const phoneNumber = read('phoneNumber');
    const requested = read('provider')?.toLowerCase();
    if (!reference || reference.length > 2048) return bad('Missing or invalid reference.');
    if ((suffix?.length ?? 0) > 8 || (phoneNumber?.length ?? 0) > 12) return bad('Invalid suffix or phone number.');
    const explicit = requested && Object.prototype.hasOwnProperty.call(providers, requested) ? providers[requested] : undefined;
    if (requested && requested !== 'auto' && !explicit) return bad('Unsupported verification provider.');
    const legacyLink = extractLegacyCbeUrlData(reference);
    const newCbe = extractNewCbeToken(reference);
    let provider = explicit;
    if (!provider) {
      if (reference.length === 16 && /^\d{3}/.test(reference)) provider = 'DASHEN';
      else if (legacyLink) provider = 'CBE';
      else if (reference.length === 12 && reference.toUpperCase().startsWith('FT')) {
        if (suffix?.length === 8) provider = 'CBE';
        else if (suffix?.length === 5) provider = 'ABYSSINIA';
        else return bad('FT references require an 8-digit CBE or 5-digit Abyssinia suffix.');
      } else if (newCbe) provider = 'CBE';
      else if (/^[A-Za-z0-9]{10}$/.test(reference)) provider = phoneNumber ? 'CBE_BIRR' : 'TELEBIRR';
      else if (reference.length >= 10 && !suffix && !phoneNumber) provider = 'AWASH_ZEMEN';
      else return bad('The provided reference does not match a recognised provider format.');
    }
    if (provider === 'CBE') {
      if (phoneNumber) return bad('CBE verification does not use phoneNumber.');
      if (legacyLink) {
        if (suffix && suffix !== legacyLink.suffix) return bad('Suffix conflicts with the CBE receipt URL.');
        reference = legacyLink.reference;
        suffix = legacyLink.suffix;
      } else if (newCbe) {
        if (suffix) return bad('New CBE receipt verification does not use a suffix.');
        reference = newCbe; // Preserve case: new tokens can be case-sensitive.
      } else if (!isLegacyCbeReference(reference)) return bad('Invalid CBE reference format.');
      if (!newCbe) reference = reference.toUpperCase();
      if (!newCbe && !/^\d{8}$/.test(suffix ?? '')) return bad('Legacy CBE verification requires exactly 8 suffix digits.');
    } else if (provider === 'ABYSSINIA') {
      if (!/^\d{5}$/.test(suffix ?? '') || phoneNumber) return bad('Abyssinia requires a 5-digit suffix and no phoneNumber.');
    } else if (provider === 'CBE_BIRR') {
      if (!/^251\d{9}$/.test(phoneNumber ?? '') || suffix) return bad('CBE Birr requires a 12-digit phone number starting with 251 and no suffix.');
    } else if (suffix || phoneNumber) return bad(`${provider} verification expects only a reference.`);
    return { ok: true, plan: { provider, reference, suffix, phoneNumber } };
  } catch (error) {
    return bad(error instanceof Error ? error.message : 'Invalid verification input.');
  }
}

export const providerVerifiers = {
  CBE: (p: VerificationPlan) => verifyCBE(p.reference, p.suffix),
  CBE_BIRR: (p: VerificationPlan) => verifyCBEBirr(p.reference, p.phoneNumber!),
  TELEBIRR: (p: VerificationPlan) => verifyTelebirr(p.reference),
  DASHEN: (p: VerificationPlan) => verifyDashen(p.reference),
  ABYSSINIA: (p: VerificationPlan) => verifyAbyssinia(p.reference, p.suffix!),
  MPESA: (p: VerificationPlan) => verifyMpesa(p.reference),
  AWASH: (p: VerificationPlan) => verifyAwash(p.reference),
  ZEMEN: (p: VerificationPlan) => verifyZemen(p.reference),
};
export type ProviderVerifiers = Record<keyof typeof providerVerifiers, (plan: VerificationPlan) => Promise<unknown>>;

export async function executeVerification(plan: VerificationPlan, verifiers: ProviderVerifiers = providerVerifiers): Promise<SmartVerifyResult> {
  if (plan.provider === 'AWASH_ZEMEN') {
    // Preserve automatic fallback, but explicit selections never fan out.
    const awash = await executeVerification({ ...plan, provider: 'AWASH' }, verifiers);
    if (awash.success) return awash;
    const zemen = await executeVerification({ ...plan, provider: 'ZEMEN' }, verifiers);
    if (zemen.success) return zemen;
    return { success: false, error: 'Receipt not found by the automatic fallback providers.', httpStatus: 404 };
  }
  const provider = plan.provider;
  try {
    const data = await verifiers[provider](plan);
    if (!data) return { success: false, error: 'Receipt not found or could not be processed.', httpStatus: 404, provider };
    const result = data as { success?: boolean; error?: string; statusCode?: number };
    if (result.success === false) return {
      success: false, data, error: result.error ?? 'Verification failed.',
      httpStatus: result.statusCode ?? 422, provider,
    };
    return { success: true, data, httpStatus: 200, provider };
  } catch (error) {
    logger.error('Provider verification failed', { provider, error: error instanceof Error ? error.message : 'Unknown error' });
    const e = error as { name?: string; message?: string; details?: unknown };
    return {
      success: false, provider, httpStatus: e?.name === 'TelebirrVerificationError' ? 502 : 500,
      error: e?.message ?? 'Provider verification failed.', details: e?.details,
    };
  }
}

/** Batch, public, OCR and commerce callers reuse the same validation/dispatch.
 * They intentionally do not inherit another product's billing or cache policy.
 */
export async function runSmartVerify(input: SmartVerifyInput): Promise<SmartVerifyResult> {
  const prepared = prepareVerification(input);
  return prepared.ok ? executeVerification(prepared.plan) : prepared.result;
}
