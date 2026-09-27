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

/** Raised when a single provider call outlives VERIFY_EXECUTE_TIMEOUT_MS. */
class ExecuteTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`verification exceeded ${timeoutMs}ms`);
    this.name = 'ExecuteTimeoutError';
  }
}

export function createVerificationCache(options: { ttlMs?: number; maxEntries?: number; maxInFlight?: number; executeTimeoutMs?: number; now?: () => number } = {}) {
  const ttlMs = options.ttlMs ?? setting(process.env.VERIFY_CACHE_TTL_MS, 60_000);
  const maxEntries = options.maxEntries ?? setting(process.env.VERIFY_CACHE_MAX_ENTRIES, 5_000);
  const maxInFlight = options.maxInFlight ?? setting(process.env.VERIFY_CACHE_MAX_INFLIGHT, 128);
  // Hard ceiling on one provider call. Provider fetchers carry their own
  // timeouts, but a hung undici socket or Puppeteer call would otherwise never
  // settle, so the `finally` that releases the in-flight slot would never run.
  // 128 stranded slots (maxInFlight) turn every later request into a 503 until
  // the process restarts, because a full inflight map short-circuits before the
  // provider is ever called.
  const executeTimeoutMs = options.executeTimeoutMs ?? setting(process.env.VERIFY_EXECUTE_TIMEOUT_MS, 90_000);
  const now = options.now ?? Date.now;
  const cache = new Map<string, { expiresAt: number; result: SmartVerifyResult }>();
  const inflight = new Map<string, Promise<SmartVerifyResult>>();
  let hits = 0, coalesced = 0, stored = 0, timeouts = 0;
  const clone = (r: SmartVerifyResult): SmartVerifyResult => structuredClone(r);
  function prune(): void {
    for (const [key, value] of cache) if (value.expiresAt <= now()) cache.delete(key);
  }
  return {
    stats: () => {
      prune();
      return { enabled: ttlMs > 0 && maxEntries > 0, ttlMs, entries: cache.size, inFlight: inflight.size, hits, coalesced, stored, timeouts, executeTimeoutMs };
    },
    clear: () => { cache.clear(); hits = 0; coalesced = 0; stored = 0; timeouts = 0; },
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
      // Always settle, so the `finally` below always releases the slot.
      const task = new Promise<SmartVerifyResult>((resolve, reject) => {
        const timer = setTimeout(() => reject(new ExecuteTimeoutError(executeTimeoutMs)), executeTimeoutMs);
        timer.unref?.();
        Promise.resolve().then(execute).then(
          (value) => { clearTimeout(timer); resolve(value); },
          (error) => { clearTimeout(timer); reject(error); },
        );
      });
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
      } catch (error) {
        // A hung provider call is a retryable capacity problem, not an internal
        // error: answer 503 so the caller gets a Retry-After rather than a 500,
        // and so the legacy envelope cannot downgrade it to a 200. The slot is
        // released by the `finally` below either way.
        if (error instanceof ExecuteTimeoutError) {
          timeouts += 1;
          return {
            result: { success: false, httpStatus: 503, error: 'Verification timed out. Retry shortly.' },
            cache: 'bypass',
          };
        }
        throw error;
      } finally {
        inflight.delete(key); // A thrown provider error cannot strand followers.
      }
    },
  };
}
export const verificationResultCache = createVerificationCache();
export const verifyCacheStats = verificationResultCache.stats;
export const clearVerifyCache = verificationResultCache.clear;
