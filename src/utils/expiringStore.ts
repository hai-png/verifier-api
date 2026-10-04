/**
 * expiringStore.ts
 *
 * Bounded in-memory sliding-window counters.
 *
 * The rate limiter and the public verification throttle used plain `Map`s that
 * only ever grew: every distinct client IP / key was kept forever, which is a
 * slow memory leak on a 512 MB instance and an unbounded one in front of a CDN
 * (every visitor arrives from a new edge IP). This store sweeps expired windows
 * opportunistically — no timers, no work on the hot path beyond a counter — and
 * hard-caps the key count.
 */

export interface Window {
    count: number;
    windowStart: number;
    /**
     * The window this entry was created with.
     *
     * Not passed to `increment` per call and then forgotten: the sweep has to
     * know each entry's own length. One store serves both the 60 s API-key
     * windows and the 1 h anonymous-window window, and a sweep driven by the
     * triggering key's `windowMs` expired entries belonging to *other* windows.
     * A `public:<ip>` bucket burned to its 6/hour cap was therefore deleted by
     * any API-key request 60 s later, silently turning the only throttle on
     * unauthenticated verification into 6/minute. Expiring per entry removes
     * the coupling entirely.
     */
    windowMs: number;
}

export interface MemoryWindowCounterOptions {
    /** Maximum number of live keys kept before the oldest are evicted. */
    maxEntries?: number;
    /** Keys between opportunistic sweeps. */
    sweepEvery?: number;
    /**
     * Maximum number of evicted keys whose count is remembered.
     *
     * Eviction used to delete the window outright, so the next request for that
     * key started again at 1. That is fail-open: a caller able to present
     * `RATE_LIMIT_MAX_KEYS` distinct identities (spoofed `CF-Connecting-IP`, or
     * simply many edge IPs in front of a CDN) exhausted its own bucket and
     * reset it, turning a 6/hour cap into no cap at all. Tombstoning the count
     * makes an evicted key resume where it left off. Set to 0 to restore the
     * previous reset-on-eviction behaviour.
     */
    maxTombstones?: number;
}

export class MemoryWindowCounter {
    private entries = new Map<string, Window>();
    private readonly tombstones = new Map<string, Window>();
    private readonly maxEntries: number;
    private readonly maxTombstones: number;
    private readonly sweepEvery: number;
    private sinceSweep = 0;
    private sweeps = 0;

    constructor(options: MemoryWindowCounterOptions = {}) {
        this.maxEntries = options.maxEntries ?? Number(process.env.RATE_LIMIT_MAX_KEYS ?? 20_000);
        this.sweepEvery = options.sweepEvery ?? 500;
        this.maxTombstones = options.maxTombstones
            ?? Math.max(0, Math.floor(this.maxEntries / 4));
    }

    /**
     * Count one hit against `key` in a window of `windowMs`.
     * Returns the window state (count includes this hit).
     *
     * A key reused with a different `windowMs` keeps the window it already has
     * rather than adopting the new length: changing a limit mid-window must not
     * hand the caller a fresh count.
     */
    increment(key: string, windowMs: number, now: number = Date.now()): Window {
        const existing = this.entries.get(key) ?? this.reviveTombstone(key, now);
        if (!existing || now - existing.windowStart >= existing.windowMs) {
            const fresh: Window = { count: 1, windowStart: now, windowMs };
            this.entries.set(key, fresh);
            this.maybeSweep(now);
            return fresh;
        }
        existing.count += 1;
        this.entries.set(key, existing);
        return existing;
    }

    /** Current window without counting a hit (undefined when absent/expired). */
    peek(key: string, windowMs: number, now: number = Date.now()): Window | undefined {
        const existing = this.entries.get(key) ?? this.reviveTombstone(key, now);
        if (!existing) return undefined;
        if (now - existing.windowStart >= existing.windowMs) {
            this.entries.delete(key);
            return undefined;
        }
        return existing;
    }

    /** Live windows. This is what `rateLimiterState` reports as tracked keys. */
    size(): number {
        return this.entries.size;
    }

    /** Live windows plus remembered evictions — the store's real footprint. */
    footprint(): number {
        return this.entries.size + this.tombstones.size;
    }

    sweepCount(): number {
        return this.sweeps;
    }

    clear(): void {
        this.entries.clear();
        this.tombstones.clear();
    }

    /**
     * Pull an evicted key's remembered window back into the live map, so an
     * identity that reappears continues its count instead of restarting at 1.
     */
    private reviveTombstone(key: string, now: number): Window | undefined {
        if (this.maxTombstones === 0) return undefined;
        const remembered = this.tombstones.get(key);
        if (!remembered) return undefined;
        this.tombstones.delete(key);
        if (now - remembered.windowStart >= remembered.windowMs) return undefined;
        return remembered;
    }

    private rememberAsTombstone(key: string): void {
        if (this.maxTombstones === 0) return;
        const entry = this.entries.get(key);
        if (!entry) return;
        if (this.tombstones.size >= this.maxTombstones) {
            const oldest = this.tombstones.keys().next();
            if (!oldest.done) this.tombstones.delete(oldest.value);
        }
        this.tombstones.set(key, entry);
    }

    /**
     * Drop expired entries and enforce the key cap. `windowMs` is deliberately
     * not a parameter: each entry carries its own, which is the point.
     */
    private maybeSweep(now: number): void {
        this.sinceSweep += 1;
        if (this.sinceSweep < this.sweepEvery) return;
        this.sinceSweep = 0;
        this.sweeps += 1;

        for (const [key, entry] of this.entries) {
            if (now - entry.windowStart >= entry.windowMs) this.entries.delete(key);
        }
        for (const [key, entry] of this.tombstones) {
            if (now - entry.windowStart >= entry.windowMs) this.tombstones.delete(key);
        }

        if (this.entries.size > this.maxEntries) {
            const overflow = this.entries.size - this.maxEntries;
            let removed = 0;
            for (const key of this.entries.keys()) {
                this.rememberAsTombstone(key);
                this.entries.delete(key);
                removed += 1;
                if (removed >= overflow) break;
            }
        }
    }
}
