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
 */
export function createRedisConnectionOptions(usage: string): ConnectionOptions {
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl) {
    throw new Error(`REDIS_URL is required to use the ${usage} queue.`);
  }

  return {
    url: redisUrl,
    // BullMQ requires this for workers; leave it alone.
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    connectTimeout: 5_000,
    retryStrategy: (times: number) => Math.min(times * times * 200, 30_000),
  };
}
