/**
 * writeBehind.ts
 *
 * Small write-behind buffer for high-frequency, non-critical writes.
 *
 * Verification traffic used to issue one `UsageLog` INSERT and one `ApiKey`
 * UPDATE per request. Against a database in another region that is ~150 ms of
 * round trip per write, and it competes with the request path for a tiny
 * Prisma connection pool. Batching those writes turns N round trips into one
 * `createMany`/`$transaction` per interval.
 *
 * Trade-off: a process crash can lose up to `intervalMs` of buffered writes.
 * Usage analytics tolerate that; anything billing-critical must not use this.
 */

import logger from './logger';

export interface WriteBehindOptions<T> {
    /** Persist a batch. Rejecting requeues the batch for the next flush. */
    flush: (batch: T[]) => Promise<void>;
    /** Stable name used in logs and diagnostics. */
    name: string;
    /** How often the buffer is drained. */
    intervalMs?: number;
    /** Flush immediately once the buffer reaches this size. */
    maxBatchSize?: number;
    /** Upper bound for a requeued buffer; the oldest entries are dropped first. */
    maxBufferSize?: number;
}

export interface WriteBehind<T> {
    push: (item: T) => void;
    /** Drain the buffer now (used on shutdown and by tests). */
    flush: () => Promise<void>;
    /** Stop the timer permanently; buffered items stay until `flush()` is called. */
    stop: () => void;
    size: () => number;
    flushCount: () => number;
    droppedCount: () => number;
}

export function createWriteBehind<T>(options: WriteBehindOptions<T>): WriteBehind<T> {
    const intervalMs = options.intervalMs ?? 2_000;
    const maxBatchSize = options.maxBatchSize ?? 500;
    const maxBufferSize = options.maxBufferSize ?? maxBatchSize * 4;

    let buffer: T[] = [];
    let timer: NodeJS.Timeout | null = null;
    let inFlight: Promise<void> | null = null;
    let stopped = false;
    let flushCount = 0;
    let droppedCount = 0;

    const stopTimer = () => {
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
    };

    const startTimer = () => {
        // After stop() the writer is shutting down: keep buffering so the final
        // flush() can persist everything, but never schedule new timers.
        if (timer || stopped) return;
        timer = setInterval(() => {
            void flush();
        }, intervalMs);
        // Never keep the process alive just to flush analytics.
        timer.unref?.();
    };

    async function flush(): Promise<void> {
        // Serialize flushes so two batches cannot be written out of order.
        if (inFlight) return inFlight;
        if (buffer.length === 0) return;

        const batch = buffer;
        buffer = [];
        inFlight = (async () => {
            try {
                await options.flush(batch);
                flushCount += 1;
            } catch (error) {
                // Requeue so a transient database error does not lose usage data.
                buffer = [...batch, ...buffer];
                if (buffer.length > maxBufferSize) {
                    const overflow = buffer.length - maxBufferSize;
                    buffer = buffer.slice(overflow);
                    droppedCount += overflow;
                    logger.warn(
                        `[write-behind:${options.name}] dropped ${overflow} buffered entries after repeated flush failures`
                    );
                }
                logger.error(
                    `[write-behind:${options.name}] flush failed (${batch.length} entries requeued): ${error instanceof Error ? error.message : String(error)}`
                );
            } finally {
                inFlight = null;
            }
        })();

        return inFlight;
    }

    return {
        push: (item: T) => {
            buffer.push(item);
            startTimer();
            if (buffer.length >= maxBatchSize) {
                void flush();
            }
        },
        flush,
        stop: () => {
            stopped = true;
            stopTimer();
        },
        size: () => buffer.length,
        flushCount: () => flushCount,
        droppedCount: () => droppedCount,
    };
}
