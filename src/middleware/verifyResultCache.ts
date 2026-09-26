/**
 * verifyResultCache.ts
 *
 * Two protections for the slowest part of the API — the upstream provider call:
 *
 *  1. Single-flight coalescing: identical verifications that arrive while one is
 *     already running share that upstream result instead of opening a second
 *     (third, tenth…) request to the bank or telecom. Mobile clients retry, and
 *     retries are exactly when this happens.
 *  2. A short positive-result cache: a completed receipt is immutable, so a
 *     successful verification can be replayed for a few seconds without asking
 *     the provider again. Failures are never cached (a receipt that does not
 *     exist yet may exist in a moment).
 *
 * Keys are scoped per workspace, so one tenant can never read another tenant's
 * verification result. Mounted after auth + quota, before the verify routers.
 */

import { Request, Response, NextFunction } from 'express';
import { getWorkspaceContext } from '../utils/workspaceContext';
import logger from '../utils/logger';

const CACHE_TTL_MS = Number(process.env.VERIFY_CACHE_TTL_MS ?? 60_000);
const MAX_ENTRIES = Number(process.env.VERIFY_CACHE_MAX_ENTRIES ?? 5_000);

// Single-reference verification endpoints. /verify-batch (array of results),
// /verify-image (file upload) and /verify/public (browser throttle + no quota)
// are deliberately excluded.
const CACHEABLE_PATHS = new Set<string>([
  '/verify',
  '/verify-cbe',
  '/verify-telebirr',
  '/verify-dashen',
  '/verify-abyssinia',
  '/verify-cbebirr',
  '/verify-mpesa',
  '/verify-awash',
  '/verify-zemen',
]);

interface CachedResponse {
  statusCode: number;
  body: unknown;
  expiresAt: number;
}

type Outcome = { statusCode: number; body: unknown } | null;

const cache = new Map<string, CachedResponse>();
const inflight = new Map<string, Promise<Outcome>>();

const stats = { hits: 0, coalesced: 0, stored: 0, skipped: 0 };

export function verifyCacheStats(): {
  enabled: boolean;
  ttlMs: number;
  entries: number;
  inFlight: number;
  hits: number;
  coalesced: number;
  stored: number;
} {
  return {
    enabled: CACHE_TTL_MS > 0,
    ttlMs: CACHE_TTL_MS,
    entries: cache.size,
    inFlight: inflight.size,
    hits: stats.hits,
    coalesced: stats.coalesced,
    stored: stats.stored,
  };
}

/** Exposed for tests. */
export function clearVerifyCache(): void {
  cache.clear();
  inflight.clear();
  stats.hits = 0;
  stats.coalesced = 0;
  stats.stored = 0;
  stats.skipped = 0;
}

function normalizeReference(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().toUpperCase();
}

/**
 * Mounted with `app.use('/verify-telebirr', …)`, so `req.path` is relative to
 * the mount point ('/'). Always key on the absolute path or two different
 * endpoints would share cache entries.
 */
function mountedPath(req: Request): string {
  // baseUrl + path, with the trailing slash removed so '/verify-telebirr' and
  // '/verify-telebirr/' share one cache key.
  const full = `${req.baseUrl || ''}${req.path || ''}`;
  return full.length > 1 && full.endsWith('/') ? full.slice(0, -1) : full;
}

function buildCacheKey(req: Request): string {
  const context = getWorkspaceContext(req);
  const tenant = context?.workspace.id ?? 'anonymous';
  const body = (req.body ?? {}) as Record<string, unknown>;
  return [
    req.method,
    mountedPath(req),
    tenant,
    normalizeReference(body.reference ?? body.receiptNumber ?? req.query.reference),
    String(body.suffix ?? req.query.suffix ?? ''),
    String(body.accountSuffix ?? '').trim(),
    String(body.phoneNumber ?? req.query.phoneNumber ?? '').trim(),
  ].join('|');
}

/** Only real, successful verification payloads are replayable. */
function isCacheableBody(body: unknown): boolean {
  if (body === null || typeof body !== 'object') return false;
  const success = (body as Record<string, unknown>).success;
  return success !== false;
}

function prune(now: number): void {
  if (cache.size < MAX_ENTRIES) return;
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  // Still full: drop the oldest insertions (Map preserves insertion order).
  while (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

export function verifyResultCache(req: Request, res: Response, next: NextFunction): void {
  if (CACHE_TTL_MS <= 0 || !CACHEABLE_PATHS.has(mountedPath(req))) {
    stats.skipped += 1;
    next();
    return;
  }

  const key = buildCacheKey(req);
  const now = Date.now();

  const cached = cache.get(key);
  if (cached) {
    if (cached.expiresAt > now) {
      stats.hits += 1;
      res.setHeader('x-verify-cache', 'hit');
      res.status(cached.statusCode).json(cached.body);
      return;
    }
    cache.delete(key);
  }

  const pending = inflight.get(key);
  if (pending) {
    // Coalesce: reuse the in-flight upstream call instead of starting another.
    stats.coalesced += 1;
    void pending
      .then((outcome) => {
        if (!outcome) {
          // The leader aborted before producing a result — fall through and run
          // this request normally rather than answering with nothing.
          next();
          return;
        }
        res.setHeader('x-verify-cache', 'coalesced');
        res.status(outcome.statusCode).json(outcome.body);
      })
      .catch((error) => {
        logger.warn(`verify result coalescing failed: ${error instanceof Error ? error.message : String(error)}`);
        next();
      });
    return;
  }

  let settle: (outcome: Outcome) => void = () => undefined;
  const leaderResult = new Promise<Outcome>((resolve) => {
    settle = resolve;
  });
  inflight.set(key, leaderResult);

  let settled = false;
  const finish = (outcome: Outcome): void => {
    if (settled) return;
    settled = true;
    inflight.delete(key);
    settle(outcome);
  };

  const originalJson = res.json.bind(res);
  res.json = (body: unknown): Response => {
    const response = originalJson(body);
    if (res.statusCode >= 200 && res.statusCode < 300 && isCacheableBody(body)) {
      cache.set(key, { statusCode: res.statusCode, body, expiresAt: Date.now() + CACHE_TTL_MS });
      stats.stored += 1;
      prune(Date.now());
    }
    finish({ statusCode: res.statusCode, body });
    return response;
  };

  // A client that disconnects mid-verification must not strand the coalesced
  // followers: release them so they can run their own request.
  res.on('close', () => {
    if (!res.writableEnded) finish(null);
  });
  res.on('finish', () => finish(null));

  next();
}
