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
import { extractLegacyCbeUrlData, extractNewCbeToken, isLegacyCbeReference, normaliseReference, splitLegacyCbeCombinedId } from '../utils/cbeReference';
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
  //
  // null is treated as absent. It is the ordinary JSON way of saying "not
  // supplied" — a client building this body from nullable columns sends it
  // routinely — and rejecting it produced "suffix must be a string" for a field
  // the caller believed they had not mentioned at all. A required field sent as
  // null still fails, and now fails as missing rather than as the wrong type.
  const read = (key: string, alias?: string): string | undefined => {
    const values = [body[key], ...(alias ? [body[alias]] : [])]
      .filter((v) => v !== undefined && v !== null);
    if (values.some((v) => typeof v !== 'string')) {
      // Name the type actually received: "must be a string" alone sends people
      // looking for the wrong field when a number or object was the culprit.
      const offender = values.find((v) => typeof v !== 'string');
      throw new Error(`${key} must be a string (received ${Array.isArray(offender) ? 'array' : typeof offender}).`);
    }
    // Normalise rather than just trim: references are copied out of PDFs and
    // spreadsheets, so they arrive with newlines, runs of spaces, zero-width
    // characters and full-width digits. Case is left alone because new-format CBE
    // tokens are case-sensitive.
    const strings = (values as string[]).map((v) => normaliseReference(v));
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

    // Normalise a pasted reference-and-tail pair before anything else looks at
    // it. Done here so both auto-detection and an explicit provider see the same
    // 12-character reference, and so a combined paste stops being mistaken for a
    // long Awash/Zemen reference.
    let combined: ReturnType<typeof splitLegacyCbeCombinedId> = null;
    if (!legacyLink && !newCbe) {
      combined = splitLegacyCbeCombinedId(reference);
      if (combined) {
        if (suffix !== undefined && suffix !== combined.suffix) {
          // The pasted string already carries the tail, so a second value has to
          // agree with it or we would be verifying one receipt against another.
          return bad(
            'That reference already includes an account suffix, and it does not match the suffix you supplied. ' +
            'Send the reference on its own, or clear the suffix field.',
          );
        }
        reference = combined.reference;
        suffix = combined.suffix;
      }
    }

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
      if (!newCbe && suffix === undefined && combined === null) {
        return bad(
          'This looks like a legacy CBE reference (FT plus 10 characters), which needs the payer\'s ' +
          '8-digit account suffix — the digits printed after 1000 on the receipt. You can also paste ' +
          'the whole receipt URL, or the reference and suffix run together, and it will be read from those.',
        );
      }
      if (!newCbe && !/^\d{8}$/.test(suffix ?? '')) {
        // A 5-digit tail on an FT reference is an Abyssinia receipt, not a
        // mistyped CBE one, and saying so saves a round of guessing.
        if (/^\d{5}$/.test(suffix ?? '')) {
          return bad(
            'That is a 5-digit suffix, which is an Abyssinia reference rather than a legacy CBE one. ' +
            'Verify it as Abyssinia, or paste a full CBE receipt URL.',
          );
        }
        return bad(
          'Legacy CBE verification requires exactly 8 suffix digits — the digits printed after 1000 on ' +
          'the receipt. You can also paste the whole receipt URL, or the reference and suffix run ' +
          'together, and it will be read from those.',
        );
      }
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
