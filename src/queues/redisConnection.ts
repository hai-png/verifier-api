import type { ConnectionOptions } from 'bullmq';

/**
 * Connection options shared by every BullMQ queue and worker.
 *
 * Both queues used to build their own copy of these options, and neither set a
 * retryStrategy. ioredis then fell back to its own default — min(times * 50,
 * 2000) — so a REDIS_URL whose host does not resolve was retried about once a
 * second, and every attempt logged. With a Queue and a Worker per queue that is
 * four connections each logging, which is how one deleted or mistyped Upstash
 * instance turned into a log line per second and a steadily draining log quota.
 *
 * The backoff is quadratic and capped. It starts fast enough to ride out a
 * brief blip, then stretches to one attempt every 30s, so a host that stays
 * wrong costs almost nothing and the logs stay readable. connectTimeout bounds
 * the other failure shape: a host that resolves but never finishes TLS.
 *
 * `maxRetriesPerRequest` differs by role, and the distinction matters:
 *
 *  - WORKER connections set it to `null`, which BullMQ requires — a worker must
 *    block on a command rather than reject it, or a long job gets abandoned
 *    mid-flight during a reconnect.
 *  - PRODUCER connections set it to a small number. With `null`, ioredis *buffers*
 *    the command forever instead of failing it, so a Redis blip did not surface
 *    as an error a caller could handle: `await queue.add(...)` simply never
 *    settled. That hung `POST /notifications/:id/test`,
 *    `POST /webhooks/:id/retry/:deliveryId`, and `GET /ready` — the last of which
 *    means Render never receives its 503 and restarts a healthy instance instead
 *    of being told the service is degraded. It also left a `QUEUED` delivery row
 *    behind with no job, because the row is committed before the add.
 */
export function createRedisConnectionOptions(usage: string, role: 'producer' | 'worker' = 'worker'): ConnectionOptions {
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl) {
    throw new Error(`REDIS_URL is required to use the ${usage} queue.`);
  }

  return {
    url: redisUrl,
    // Workers must block; producers must fail so the request can answer.
    maxRetriesPerRequest: role === 'worker' ? null : 1,
    enableReadyCheck: false,
    connectTimeout: 5_000,
    retryStrategy: (times: number) => Math.min(times * times * 200, 30_000),
  };
}

/**
 * Race a Redis operation against a deadline.
 *
 * Belt and braces with `maxRetriesPerRequest` above. That option bounds ioredis's
 * *own* command retries; it does not bound a command that is already queued
 * behind a reconnecting socket, and `commandTimeout` is not universally honoured
 * across the ioredis versions in the tree. Every caller on the request path uses
 * this so a Redis stall becomes a 503 the caller can retry rather than a socket
 * held open until the client gives up.
 */
export async function withRedisDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number = Number(process.env.REDIS_OPERATION_TIMEOUT_MS ?? 3_000),
  label = 'redis operation',
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} did not complete within ${timeoutMs}ms`)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
