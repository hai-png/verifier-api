/** Canonical provider-result cache, independent of HTTP route/envelope.
 * Call only after fresh authentication, authorization, throttling and charging.
 * No auth, membership or balance data is cached. No cross-workspace sharing.
 */
import { createHash } from 'crypto';
import type { SmartVerifyResult, VerificationPlan } from '../services/verifyUniversal';

function setting(value: string | undefined, fallback: number): number {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}
export type VerifyCacheOutcome = 'hit' | 'miss' | 'coalesced' | 'bypass';
export function createVerificationCache(options: { ttlMs?: number; maxEntries?: number; maxInFlight?: number; now?: () => number } = {}) {
  const ttlMs = options.ttlMs ?? setting(process.env.VERIFY_CACHE_TTL_MS, 60_000);
  const maxEntries = options.maxEntries ?? setting(process.env.VERIFY_CACHE_MAX_ENTRIES, 5_000);
  const maxInFlight = options.maxInFlight ?? setting(process.env.VERIFY_CACHE_MAX_INFLIGHT, 128);
  const now = options.now ?? Date.now;
  const cache = new Map<string, { expiresAt: number; result: SmartVerifyResult }>();
  const inflight = new Map<string, Promise<SmartVerifyResult>>();
  let hits = 0, coalesced = 0, stored = 0;
  const clone = (r: SmartVerifyResult): SmartVerifyResult => structuredClone(r);
  function prune(): void {
    for (const [key, value] of cache) if (value.expiresAt <= now()) cache.delete(key);
  }
  return {
    stats: () => {
      prune();
      return { enabled: ttlMs > 0 && maxEntries > 0, ttlMs, entries: cache.size, inFlight: inflight.size, hits, coalesced, stored };
    },
    clear: () => { cache.clear(); hits = 0; coalesced = 0; stored = 0; },
    async run(workspaceId: string | undefined, plan: VerificationPlan, execute: () => Promise<SmartVerifyResult>): Promise<{ result: SmartVerifyResult; cache: VerifyCacheOutcome }> {
      if (!workspaceId || ttlMs <= 0 || maxEntries <= 0) return { result: await execute(), cache: 'bypass' };
      // JSON tuples avoid delimiter collisions. Never uppercase opaque tokens.
      const key = createHash('sha256').update(JSON.stringify([
        workspaceId, plan.provider, plan.reference, plan.suffix ?? '', plan.phoneNumber ?? '',
      ])).digest('hex');
      const previous = cache.get(key);
      if (previous && previous.expiresAt > now()) {
        hits++;
        return { result: clone(previous.result), cache: 'hit' };
      }
      if (previous) cache.delete(key);
      const pending = inflight.get(key);
      if (pending) {
        coalesced++;
        return { result: clone(await pending), cache: 'coalesced' };
      }
      if (inflight.size >= maxInFlight) {
        return { result: { success: false, httpStatus: 503, error: 'Verification capacity reached. Retry shortly.' }, cache: 'bypass' };
      }
      const task = Promise.resolve().then(execute);
      inflight.set(key, task);
      try {
        const result = await task;
        // Negative/domain/transport results are never replayed after completion.
        const data = result.data as { transactionStatus?: unknown; success?: boolean } | undefined;
        const transactionStatus = data?.transactionStatus;
        const finalStatus = transactionStatus === undefined || /^(completed|success|successful|paid|settled)$/i.test(String(transactionStatus).trim());
        if (result.success === true && result.httpStatus >= 200 && result.httpStatus < 300 && data?.success !== false && finalStatus) {
          prune();
          while (cache.size >= maxEntries) cache.delete(cache.keys().next().value!);
          cache.set(key, { result: clone(result), expiresAt: now() + ttlMs });
          stored++;
        }
        return { result: clone(result), cache: 'miss' };
      } finally {
        inflight.delete(key); // A thrown provider error cannot strand followers.
      }
    },
  };
}
export const verificationResultCache = createVerificationCache();
export const verifyCacheStats = verificationResultCache.stats;
export const clearVerifyCache = verificationResultCache.clear;
