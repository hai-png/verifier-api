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
}

export interface MemoryWindowCounterOptions {
    /** Maximum number of keys kept before the oldest are evicted. */
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
        if (!existing || now - existing.windowStart >= windowMs) {
            const fresh: Window = { count: 1, windowStart: now };
            this.entries.set(key, fresh);
            this.maybeSweep(now, windowMs);
            return fresh;
        }
        existing.count += 1;
        return existing;
    }

    /** Current window without counting a hit (undefined when absent/expired). */
    peek(key: string, windowMs: number, now: number = Date.now()): Window | undefined {
        const existing = this.entries.get(key);
        if (!existing) return undefined;
        if (now - existing.windowStart >= windowMs) {
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

    clear(): void {
        this.entries.clear();
    }

    private maybeSweep(now: number, windowMs: number): void {
        this.sinceSweep += 1;
        if (this.sinceSweep < this.sweepEvery) return;
        this.sinceSweep = 0;
        this.sweeps += 1;

        for (const [key, entry] of this.entries) {
            if (now - entry.windowStart >= windowMs) this.entries.delete(key);
        }

        if (this.entries.size > this.maxEntries) {
            const overflow = this.entries.size - this.maxEntries;
            let removed = 0;
            for (const key of this.entries.keys()) {
                this.entries.delete(key);
                removed += 1;
                if (removed >= overflow) break;
            }
        }
    }
}
