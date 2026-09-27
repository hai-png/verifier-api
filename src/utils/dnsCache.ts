/**
 * dnsCache.ts
 *
 * The Telebirr relay hosts live behind the `.et` DNS zone, whose authoritative
 * nameservers regularly answer in 1–4 s (measured cold: 3.6 s for the relay
 * hostname alone). Node's HTTP stack resolves the hostname on every request
 * and keeps no cache, so every verification attempt re-pays that lookup —
 * inside a ~13 s relay budget, 2–4 s of pure DNS is the difference between a
 * slow success and a "relay timed out" failure.
 *
 * This module provides:
 *  - a TTL cache around `dns.lookup` (positive and negative entries), and
 *  - shared keep-alive HTTP(S) agents that use it, so repeated relay requests
 *    reuse both the DNS answer and the TLS connection.
 *
 * Correctness notes:
 *  - lookups in flight for a hostname are coalesced (one resolution, many
 *    callers).
 *  - the negative TTL is deliberately short: a transient resolver failure
 *    must not shadow a working relay for minutes.
 */

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';

export interface DnsCacheStats {
    entries: number;
    hits: number;
    misses: number;
    errors: number;
    evictions: number;
}

export interface CachedDnsLookupOptions {
    /** How long a successful resolution is reused. Default: 5 minutes. */
    ttlMs?: number;
    /** How long a failed resolution is remembered. Default: 10 seconds. */
    failureTtlMs?: number;
    /** Cache size cap; oldest entry is evicted first. Default: 512. */
    maxEntries?: number;
}

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_FAILURE_TTL_MS = 10_000;
const DEFAULT_MAX_ENTRIES = 512;

interface LookupAddress {
    address: string;
    family: number;
}

type ResolveFn = (hostname: string, family: number) => Promise<LookupAddress>;

const defaultResolve: ResolveFn = (hostname, family) =>
    dns.promises.lookup(hostname, { family });

interface CacheEntry {
    expiresAt: number;
    result: LookupAddress | null;
    error?: NodeJS.ErrnoException;
}

export interface CachedLookup {
    lookup: LookupFunction;
    stats: () => DnsCacheStats;
}

/**
 * Build a cached `dns.LookupFunction`. The resolver is injectable so tests
 * never touch the real resolver.
 */
export function createCachedDnsLookup(
    resolve: ResolveFn = defaultResolve,
    options: CachedDnsLookupOptions = {}
): CachedLookup {
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const failureTtlMs = options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS;
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;

    const cache = new Map<string, CacheEntry>();
    const inFlight = new Map<string, Promise<void>>();
    const stats: DnsCacheStats = { entries: 0, hits: 0, misses: 0, errors: 0, evictions: 0 };

    function evictIfNeeded(): void {
        while (cache.size >= maxEntries) {
            const oldest = cache.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            cache.delete(oldest);
            stats.evictions += 1;
        }
    }

    function store(entry: CacheEntry, hostname: string): void {
        evictIfNeeded();
        cache.set(hostname, entry);
    }

    function ensureResolved(hostname: string, family: number): Promise<void> {
        const cached = cache.get(hostname);
        if (cached) {
            if (cached.expiresAt <= Date.now()) {
                cache.delete(hostname);
            } else {
                // Serve whatever we have — including a negative entry, so a
                // failing resolver is not re-queried on every request.
                stats.hits += 1;
                return Promise.resolve();
            }
        }

        const pending = inFlight.get(hostname);
        if (pending) return pending;

        stats.misses += 1;
        const attempt = (async () => {
            try {
                const result = await resolve(hostname, family);
                store({ expiresAt: Date.now() + ttlMs, result }, hostname);
            } catch (error) {
                stats.errors += 1;
                store(
                    {
                        expiresAt: Date.now() + failureTtlMs,
                        result: null,
                        error: error as NodeJS.ErrnoException
                    },
                    hostname
                );
            } finally {
                inFlight.delete(hostname);
            }
        })();

        inFlight.set(hostname, attempt);
        return attempt;
    }

    const lookup = ((
        hostname: string,
        optionsOrCallback: unknown,
        maybeCallback?: unknown
    ): void => {
        const callback = (
            typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
        ) as (error: NodeJS.ErrnoException | null, address?: unknown, family?: number) => void;
        const options = (
            typeof optionsOrCallback === 'object' && optionsOrCallback !== null
                ? optionsOrCallback
                : {}
        ) as dns.LookupOptions;

        if (typeof callback !== 'function') {
            throw new TypeError('dnsCache lookup requires a callback.');
        }

        const family = options.family === 4 || options.family === 6 ? options.family : 0;

        ensureResolved(hostname, family).then(() => {
            const cached = cache.get(hostname);
            if (cached && cached.result !== null && (family === 0 || cached.result.family === family)) {
                const result: LookupAddress = cached.result;
                if (options.all) {
                    callback(null, [result]);
                } else {
                    callback(null, result.address, result.family);
                }
                return;
            }

            if (cached && cached.result === null) {
                // Fresh negative entry.
                const error: NodeJS.ErrnoException = cached.error
                    ?? Object.assign(new Error(`DNS lookup failed for ${hostname}`), {
                        code: 'EAI_AGAIN'
                    });
                callback(error);
                return;
            }

            // No usable entry (family mismatch or a race evicted it): resolve
            // directly rather than serving a wrong address family.
            resolve(hostname, family).then(
                (result) => {
                    if (options.all) {
                        callback(null, [result]);
                    } else {
                        callback(null, result.address, result.family);
                    }
                },
                (error: NodeJS.ErrnoException) => callback(error)
            );
        });
    }) as LookupFunction;

    return {
        lookup,
        stats: () => ({ ...stats, entries: cache.size })
    };
}

/** One shared instance backs the exported agents and the /status/summary counters. */
const shared = createCachedDnsLookup();

export function dnsCacheStats(): DnsCacheStats {
    return shared.stats();
}

/**
 * Keep-alive agents with cached DNS. Reusing the TLS session to a relay
 * saves ~0.6 s per verification on top of the DNS answer reuse.
 */
export const cachedHttpAgent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 30_000,
    lookup: shared.lookup
});

export const cachedHttpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 30_000,
    lookup: shared.lookup
});
