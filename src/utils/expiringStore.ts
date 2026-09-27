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
 *
 * Two correctness rules the earlier version broke, both of which turned a memory
 * bound into a rate-limit bypass:
 *
 *  1. Each entry remembers its OWN window length. The sweep used to be driven by
 *     the `windowMs` of whichever `increment()` happened to trigger it, so in a
 *     store mixing a 60 s plan window with a 1 h anonymous window, any 60 s
 *     increment that tripped the sweep deleted every live 1 h window — silently
 *     resetting the anonymous throttle for unrelated callers.
 *  2. Overflow eviction removes the entries closest to expiry, not the ones that
 *     happen to sit first in Map insertion order. Insertion order is not recency
 *     (`Map.set` on an existing key does not move it), so the old behaviour
 *     evicted long-lived *hot* keys and handed them a fresh full window while
 *     keeping genuinely stale ones.
 */

export interface Window {
    count: number;
    windowStart: number;
    /** The window length this entry was created with, kept so sweeps and
     *  eviction judge it against its own expiry rather than the caller's. */
    windowMs: number;
}

export interface MemoryWindowCounterOptions {
    /** Maximum number of keys kept before the closest-to-expiry are evicted. */
    maxEntries?: number;
    /** Keys between opportunistic sweeps. */
    sweepEvery?: number;
}

export class MemoryWindowCounter {
    private entries = new Map<string, Window>();
    private readonly maxEntries: number;
    private readonly sweepEvery: number;
    private sinceSweep = 0;
    private sweeps = 0;
    private evictions = 0;

    constructor(options: MemoryWindowCounterOptions = {}) {
        this.maxEntries = options.maxEntries ?? Number(process.env.RATE_LIMIT_MAX_KEYS ?? 20_000);
        this.sweepEvery = options.sweepEvery ?? 500;
    }

    /**
     * Count one hit against `key` in a window of `windowMs`.
     * Returns the window state (count includes this hit).
     */
    increment(key: string, windowMs: number, now: number = Date.now()): Window {
        const existing = this.entries.get(key);
        if (existing && now - existing.windowStart < existing.windowMs) {
            // Same window. A caller passing a different windowMs for an existing
            // key does not silently shorten or lengthen the window in force.
            existing.count += 1;
            return existing;
        }
        const fresh: Window = { count: 1, windowStart: now, windowMs };
        this.entries.set(key, fresh);
        this.maybeSweep(now);
        return fresh;
    }

    /** Current window without counting a hit (undefined when absent/expired). */
    peek(key: string, windowMs: number, now: number = Date.now()): Window | undefined {
        const existing = this.entries.get(key);
        if (!existing) return undefined;
        if (now - existing.windowStart >= existing.windowMs) {
            this.entries.delete(key);
            return undefined;
        }
        return existing;
    }

    size(): number {
        return this.entries.size;
    }

    sweepCount(): number {
        return this.sweeps;
    }

    /** How many live entries the hard cap has had to discard. */
    evictionCount(): number {
        return this.evictions;
    }

    clear(): void {
        this.entries.clear();
    }

    private maybeSweep(now: number): void {
        this.sinceSweep += 1;
        if (this.sinceSweep < this.sweepEvery) return;
        this.sinceSweep = 0;
        this.sweeps += 1;

        for (const [key, entry] of this.entries) {
            if (now - entry.windowStart >= entry.windowMs) this.entries.delete(key);
        }

        if (this.entries.size <= this.maxEntries) return;

        // Discard whatever expires soonest: that is the entry whose remaining
        // window — and therefore the extra capacity a reset can grant — is
        // smallest. This is an O(n log n) pass over the map, which is why it is
        // gated behind `sweepEvery` and only runs once the hard cap is actually
        // exceeded; in steady state the sweep above keeps the map well under it.
        const overflow = this.entries.size - this.maxEntries;
        const candidates = [...this.entries.entries()]
            .map(([key, entry]) => ({ key, remaining: entry.windowStart + entry.windowMs - now }))
            .sort((a, b) => a.remaining - b.remaining)
            .slice(0, overflow);
        for (const { key } of candidates) {
            this.entries.delete(key);
            this.evictions += 1;
        }
    }
}
