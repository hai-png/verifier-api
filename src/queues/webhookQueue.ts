import axios from 'axios';
import crypto from 'crypto';
import type { ConnectionOptions, Job } from 'bullmq';
import { Queue, Worker } from 'bullmq';
import { Prisma } from '@prisma/client';
import logger from '../utils/logger';
import { prisma } from '../utils/prisma';
import { emitWorkspaceEvent } from '../utils/workspaceEvents';
import { assertSafeOutboundUrl, UnsafeOutboundUrlError } from '../utils/safeUrl';
import { createRedisConnectionOptions, withRedisDeadline } from './redisConnection';

const QUEUE_NAME = 'webhook-deliveries';
const REQUEST_TIMEOUT_MS = 10_000;
// A webhook response is only stored as a short diagnostic snippet, so there is
// no reason to buffer an arbitrary amount of attacker-influenced data in RAM.
const MAX_RESPONSE_BYTES = 256 * 1024;
// Separately: what we are willing to *send*. The largest legitimate payload is a
// batch verification result, comfortably under a megabyte.
const MAX_REQUEST_BYTES = 1024 * 1024;

/**
 * A tenant-supplied URL with its credentials and secret-bearing query parameters
 * removed, for logging.
 *
 * `assertSafeOutboundUrl` rejects URL *userinfo*, so `https://user:pass@host` can
 * never be stored — but it does not reject `?api_key=…`, `?token=…` or a signed
 * path. The raw URL was interpolated into `logger.info("Webhook delivered to …")`
 * and into several warn/error lines, so a receiver's own secret ended up in
 * application logs. This is what those call sites log instead.
 */
export function scrubUrlForLog(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
    }
    for (const key of [...url.searchParams.keys()]) {
      if (/^(api[-_]?key|token|access[-_]?token|secret|signature|sig|key|password|auth)$/i.test(key)) {
        url.searchParams.set(key, '[redacted]');
      }
    }
    return url.toString();
  } catch {
    return '[unparseable webhook url]';
  }
}
const RETRY_DELAYS_MS = [5_000, 15_000, 45_000] as const;
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
const COMPLETED_JOB_RETENTION = 500;
const FAILED_JOB_RETENTION = 500;
const RECONCILIATION_INTERVAL_MS = 60_000;
const STALE_DELIVERY_AGE_MS = 60_000;
const ACTIVE_JOB_STATES = new Set([
  'active',
  'delayed',
  'prioritized',
  'waiting',
  'waiting-children',
]);

/**
 * `Math.max(1, parseInt(...))` is NaN when the variable is present but not a
 * number — an empty `WEBHOOK_QUEUE_CONCURRENCY=` in a .env, a typo, a value of
 * "auto". `Math.max(1, NaN)` is NaN, and BullMQ receives NaN as its concurrency
 * at construction. Falls back to the default.
 */
function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

/**
 * Retry schedule.
 *
 * Jittered by ±25%. Fixed 5s/15s/45s delays meant that after any worker or Redis
 * restart every RETRYING delivery in the fleet came due at the same instant —
 * a self-inflicted thundering herd against an endpoint that was already the reason
 * for the retries.
 */
function retryDelayMs(attemptIndex: number): number {
  const base = RETRY_DELAYS_MS[Math.min(attemptIndex, RETRY_DELAYS_MS.length - 1)]!;
  const jitter = base * 0.25 * (Math.random() * 2 - 1);
  return Math.max(1_000, Math.round(base + jitter));
}

export interface WebhookPayload {
  event: string;
  [key: string]: unknown;
}

interface WebhookDeliveryJobData {
  deliveryId: string;
  attemptNumber: number;
}

interface QueueDeliveryInput {
  webhookId: string;
  event: string;
  payload: WebhookPayload;
  replayOfDeliveryId?: string | null;
}

export interface WebhookQueueHealth {
  configured: boolean;
  workerRunning: boolean;
  workerConnected: boolean;
  queueName: string;
  /** Set when part of the health snapshot could not be read (e.g. Redis stalled). */
  note?: string;
  counts: {
    waiting: number;
    active: number;
    delayed: number;
    completed: number;
    failed: number;
    paused: number;
  };
}

let queueConnection: ConnectionOptions | null = null;
let workerConnection: ConnectionOptions | null = null;
let deliveryQueue: Queue<WebhookDeliveryJobData, void, string> | null = null;
let deliveryWorker: Worker<WebhookDeliveryJobData, void, string> | null = null;
let workerConnected = false;
let reconciliationTimer: NodeJS.Timeout | null = null;
let reconciliationRunning = false;

function getRedisUrl(): string | null {
  return process.env.REDIS_URL?.trim() || null;
}

function isWebhookQueueConfigured(): boolean {
  return Boolean(getRedisUrl());
}

function getQueueConnection(): ConnectionOptions {
  if (!queueConnection) {
    queueConnection = createRedisConnectionOptions('webhook', 'producer');
  }
  return queueConnection;
}

function getWorkerConnection(): ConnectionOptions {
  if (!workerConnection) {
    workerConnection = createRedisConnectionOptions('webhook', 'worker');
  }
  return workerConnection;
}

function getWebhookQueue(): Queue<WebhookDeliveryJobData, void, string> {
  if (!deliveryQueue) {
    deliveryQueue = new Queue<WebhookDeliveryJobData, void, string>(QUEUE_NAME, {
      connection: getQueueConnection(),
    });
  }
  return deliveryQueue;
}

function serialiseResponseBody(data: unknown): string | null {
  if (data === undefined || data === null) return null;
  if (typeof data === 'string') return data.slice(0, 4000);

  try {
    return JSON.stringify(data).slice(0, 4000);
  } catch {
    return String(data).slice(0, 4000);
  }
}

/**
 * Signature format: `t=<unix seconds>,v1=<hex>`.
 *
 * The previous signature was HMAC(secret, body) with no timestamp, so a delivery
 * captured in transit stayed valid forever: anyone who could see one request
 * could replay it and the receiver had no way to tell a retry from a forgery.
 * Binding a timestamp into the signed material lets the receiver reject
 * anything outside its own tolerance window, which is what makes the scheme
 * worth the trouble.
 *
 * The version marker is not ceremony. It is what lets a receiver accept v1 today
 * and a v2 (different key derivation, say) later without guessing, and it is why
 * the legacy shape is still emitted alongside rather than replacing this
 * silently.
 */
export const WEBHOOK_SIGNATURE_VERSION = 'v1';

/** How old a delivery may be before a receiver should stop trusting it. */
export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

/**
 * Emit the replayable pre-timestamp header at all?
 *
 * The doc block above argues that binding a timestamp is "what makes the scheme
 * worth the trouble" — and then the same request ships `X-Veritas-Legacy-Signature`,
 * which is HMAC(secret, body) with nothing else, forever. Any receiver that
 * accepts that header has zero replay protection, and an observer of one delivery
 * holds an oracle that never expires.
 *
 * Off by default. `WEBHOOK_LEGACY_SIGNATURE=true` re-enables it for a receiver
 * mid-migration; set a removal date for that flag rather than leaving it. Until
 * then the recommended path is the deprecated one — the dashboard's own webhook
 * tester already verifies the timestamped form.
 */
const EMIT_LEGACY_SIGNATURE =
  (process.env.WEBHOOK_LEGACY_SIGNATURE ?? 'false').toLowerCase() === 'true';

/**
 * Serialise once and send these exact bytes. Previously the signature covered
 * `JSON.stringify(payload)` while axios serialised the object again on the way
 * out — two separate serialisations of the same value, which agree only while
 * nothing reorders keys. A receiver verifying the bytes it actually received
 * against a digest computed over a different string is a bug waiting for a
 * property order change.
 */
export function serialiseWebhookBody(payload: WebhookPayload): string {
  try {
    return JSON.stringify(payload);
  } catch {
    // A payload that will not serialise would otherwise throw here, outside the
    // delivery try/catch, and strand the job with no record of why.
    return JSON.stringify({ error: 'payload could not be serialised' });
  }
}

export function buildWebhookSignature(
  body: string,
  signingSecret: string,
  timestamp: number,
): string {
  return crypto
    .createHmac('sha256', signingSecret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
}

/** The pre-timestamp shape, still emitted so existing verifiers keep working. */
function buildLegacySignature(body: string, signingSecret: string): string {
  return crypto.createHmac('sha256', signingSecret).update(body).digest('hex');
}

async function enqueueAttempt(
  deliveryId: string,
  attemptNumber: number,
  delayMs: number,
): Promise<string | null> {
  // Deadline-bounded. `queue.add` runs on the request path (a verification's
  // delivery hook, POST /webhooks/:id/retry, the reconciler), and an unbounded
  // one pins the socket until the client gives up.
  const job = await withRedisDeadline(
    getWebhookQueue().add(
      'deliver',
      { deliveryId, attemptNumber },
      {
        delay: delayMs,
        jobId: `${deliveryId}__${attemptNumber}`,
        removeOnComplete: COMPLETED_JOB_RETENTION,
        removeOnFail: FAILED_JOB_RETENTION,
      },
    ),
    undefined,
    `enqueueing webhook delivery ${deliveryId}`,
  );

  return job.id?.toString() ?? null;
}

async function markCancelled(deliveryId: string, message: string): Promise<void> {
  await prisma.webhookDelivery.update({
    where: { id: deliveryId },
    data: {
      status: 'CANCELLED',
      success: false,
      lastError: message,
      nextRetryAt: null,
    },
  });
}

async function markReplayResolution(
  replayDeliveryId: string,
  originalDeliveryId: string,
  resolvedAt: Date,
): Promise<void> {
  await prisma.webhookDelivery.updateMany({
    where: {
      id: originalDeliveryId,
      status: 'DEAD_LETTER',
      resolvedByReplayId: null,
    },
    data: {
      resolvedByReplayId: replayDeliveryId,
      resolvedAt,
    },
  });
}

async function processWebhookDelivery(job: Job<WebhookDeliveryJobData>): Promise<void> {
  const { deliveryId, attemptNumber } = job.data;

  const delivery = await prisma.webhookDelivery.findUnique({
    where: { id: deliveryId },
    include: {
      webhook: {
        select: {
          id: true,
          url: true,
          signingSecret: true,
          active: true,
          workspaceId: true,
        },
      },
    },
  });

  if (!delivery) {
    logger.warn(`Webhook delivery ${deliveryId} no longer exists. Skipping queued job.`);
    return;
  }

  if (delivery.status === 'SUCCEEDED' || delivery.status === 'CANCELLED') {
    return;
  }

  if (!delivery.webhook) {
    await markCancelled(deliveryId, 'Webhook record no longer exists.');
    return;
  }

  if (!delivery.webhook.active) {
    await markCancelled(deliveryId, 'Webhook is inactive.');
    return;
  }

  await prisma.webhookDelivery.update({
    where: { id: deliveryId },
    data: {
      status: 'PROCESSING',
      attempts: Math.max(delivery.attempts, attemptNumber - 1),
      nextRetryAt: null,
      queueJobId: job.id?.toString() ?? delivery.queueJobId ?? null,
    },
  });

  const payload = delivery.payload as unknown as WebhookPayload;
  const body = serialiseWebhookBody(payload);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const signingSecret = delivery.webhook.signingSecret;
  if (signingSecret) {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = buildWebhookSignature(body, signingSecret, timestamp);
    headers['X-Veritas-Timestamp'] = String(timestamp);
    headers['X-Veritas-Signature'] = `t=${timestamp},${WEBHOOK_SIGNATURE_VERSION}=${signature}`;
    if (EMIT_LEGACY_SIGNATURE) {
      // Off by default — see EMIT_LEGACY_SIGNATURE. Logged whenever it is on, so
      // "we still emit the replayable header" is visible in the logs rather than
      // being a fact someone has to remember.
      logger.warn('Emitting the deprecated replayable webhook signature header (WEBHOOK_LEGACY_SIGNATURE=true).');
      headers['X-Veritas-Legacy-Signature'] = `sha256=${buildLegacySignature(body, signingSecret)}`;
    }
  }

  try {
    // Re-validate on every delivery, not only at registration: a public hostname
    // can start resolving to a private address (DNS rebinding), and a stored URL
    // may predate this check.
    //
    // What this does *not* do is close the rebinding window. `assertSafeOutboundUrl`
    // resolves the name with `dns.promises.lookup`; axios then performs a second,
    // independent resolution when it opens the socket. An attacker with a TTL-0
    // record can answer the validator with a public address and axios with
    // 127.0.0.1, milliseconds later. Per-attempt re-validation shrinks the window
    // from days to milliseconds — it does not remove it, and the previous comment
    // here claimed it did.
    //
    // Closing it properly means resolving once and connecting to the pinned address
    // (a custom `lookup` on an httpAgent, plus `servername` for SNI and a matching
    // Host header). That is a real change and is not made here; until then, treat
    // "re-validated every attempt" as what it is.
    //
    // Redirects are not followed. `maxRedirects: 0` makes axios use the raw http
    // module and *reject* on a 3xx rather than following it, which is the safe
    // choice but means any receiver that redirects (http→https, apex→www, a
    // trailing slash) fails four times and dead-letters with statusCode 302. That
    // is a deliberate trade: a manual redirect loop that re-validates each
    // Location is the correct fix, and silently following them is not.
    await assertSafeOutboundUrl(delivery.webhook.url);
    // `body`, not `payload`: the string that was signed must be the string that
    // is transmitted.
    const response = await axios.post(delivery.webhook.url, body, {
      headers,
      timeout: REQUEST_TIMEOUT_MS,
      maxRedirects: 0,
      // Two distinct limits, not one constant reused. `MAX_RESPONSE_BYTES` bounds
      // what the *receiver* sends back and is stored as a diagnostic snippet;
      // using it as `maxBodyLength` too meant any payload over 256 KB — a large
      // batch result, a verbose verification response — threw before a byte was
      // sent, four times, and dead-lettered. The name and the comment above it
      // described the response bound only.
      maxContentLength: MAX_RESPONSE_BYTES,
      maxBodyLength: MAX_REQUEST_BYTES,
    });

    const deliveredAt = new Date();

    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'SUCCEEDED',
        success: true,
        attempts: attemptNumber,
        statusCode: response.status,
        responseBody: serialiseResponseBody(response.data),
        lastError: null,
        nextRetryAt: null,
        deliveredAt,
      },
    });

    if (delivery.replayOfDeliveryId) {
      await markReplayResolution(deliveryId, delivery.replayOfDeliveryId, deliveredAt);
    }

    logger.info(
      `Webhook delivered to ${scrubUrlForLog(delivery.webhook.url)} [delivery=${deliveryId} attempt=${attemptNumber}] status=${response.status}`,
    );
  } catch (error: unknown) {
    const statusCode = axios.isAxiosError(error) ? (error.response?.status ?? null) : null;
    const responseBody = axios.isAxiosError(error)
      ? serialiseResponseBody(error.response?.data)
      : null;
    const message = error instanceof Error ? error.message : 'Unknown webhook delivery error';

    // An SSRF rejection is terminal, not a transient failure. The URL will not
    // become safe by trying again, so retrying it only spent four attempts —
    // and the delay between them — re-resolving a destination we already
    // refused. The error type was imported for exactly this and never used.
    if (error instanceof UnsafeOutboundUrlError) {
      logger.warn(
        `Webhook ${deliveryId} refused by outbound URL policy: ${message}. Not retrying.`,
      );
      await prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'DEAD_LETTER',
          success: false,
          attempts: attemptNumber,
          lastError: `Refused by outbound URL policy: ${message}`,
        },
      });
      await emitWorkspaceEvent(
        delivery.webhook.workspaceId,
        'webhook.dead_letter',
        {
          webhookId: delivery.webhook.id,
          webhookUrl: scrubUrlForLog(delivery.webhook.url),
          deliveryId,
          attempts: attemptNumber,
          lastError: `Refused by outbound URL policy: ${message}`,
        },
        delivery.webhook.id,
      );
      return;
    }

    if (attemptNumber < MAX_ATTEMPTS) {
      const delayMs = retryDelayMs(attemptNumber - 1);
      const nextRetryAt = new Date(Date.now() + delayMs);
      const nextJobId = await enqueueAttempt(deliveryId, attemptNumber + 1, delayMs);

      await prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'RETRYING',
          success: false,
          attempts: attemptNumber,
          statusCode,
          responseBody,
          lastError: message,
          nextRetryAt,
          queueJobId: nextJobId,
        },
      });

      logger.warn(
        `Webhook delivery failed and was requeued [delivery=${deliveryId} attempt=${attemptNumber}] ${message}`,
      );
      return;
    }

    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'DEAD_LETTER',
        success: false,
        attempts: attemptNumber,
        statusCode,
        responseBody,
        lastError: message,
        nextRetryAt: null,
      },
    });

    logger.error(
      `Webhook delivery dead-lettered [delivery=${deliveryId} attempt=${attemptNumber}] ${message}`,
    );

      // Not fanned out to webhooks at all.
    //
    // The old call passed `delivery.webhook.id` as `excludeWebhookId` with a
    // comment explaining that this stops "one failure becoming an unbounded retry
    // cascade". Excluding self only stops self-recursion. It does nothing for
    // mutual recursion: `webhook.dead_letter` is a valid event, so with two
    // webhooks in one workspace both subscribed to it, A dead-letters → the event
    // fires → B gets a delivery → B's URL is dead too → B dead-letters → the
    // event fires again (excluding B) → A gets a delivery → A dead-letters → …
    //
    // Each cycle costs a delivery row, a BullMQ job, four HTTP attempts spread
    // over ~65 s, and a group-by per list call, and it never terminates. There is
    // no depth limit anywhere in the event path to stop it.
    //
    // The fix is to send dead-letter notifications to *notification channels*
    // only — an email or a Telegram message is not itself a webhook and cannot
    // recurse. A workspace that wants a webhook told about dead letters can read
    // GET /webhooks/:id/deliveries, which is where an operator would look anyway.
    await emitWorkspaceEvent(delivery.webhook.workspaceId, 'webhook.dead_letter', {
      webhookId: delivery.webhook.id,
      webhookUrl: scrubUrlForLog(delivery.webhook.url),
      deliveryId,
      attempts: attemptNumber,
      lastError: message,
    }, null, { excludeWebhooks: true });
  }
}

export async function enqueueWebhookDelivery(
  input: QueueDeliveryInput,
): Promise<{ deliveryId: string }> {
  if (!isWebhookQueueConfigured()) {
    throw new Error('Webhook queue is not configured. Set REDIS_URL to enable BullMQ.');
  }

  const delivery = await prisma.webhookDelivery.create({
    data: {
      webhookId: input.webhookId,
      event: input.event,
      payload: input.payload as Prisma.InputJsonValue,
      status: 'QUEUED',
      success: false,
      attempts: 0,
      maxAttempts: MAX_ATTEMPTS,
      replayOfDeliveryId: input.replayOfDeliveryId ?? null,
    },
    select: { id: true },
  });

  const queueJobId = await enqueueAttempt(delivery.id, 1, 0);

  await prisma.webhookDelivery.update({
    where: { id: delivery.id },
    data: { queueJobId },
  });

  return { deliveryId: delivery.id };
}

export async function replayWebhookDelivery(
  webhookId: string,
  deliveryId: string,
): Promise<{ deliveryId: string }> {
  const original = await prisma.webhookDelivery.findFirst({
    where: { id: deliveryId, webhookId },
    select: {
      id: true,
      event: true,
      payload: true,
    },
  });

  if (!original) {
    throw new Error('Webhook delivery record not found.');
  }

  return enqueueWebhookDelivery({
    webhookId,
    event: original.event,
    payload: original.payload as unknown as WebhookPayload,
    replayOfDeliveryId: original.id,
  });
}

export async function reconcileWebhookDeliveries(): Promise<number> {
  if (!isWebhookQueueConfigured() || reconciliationRunning) return 0;

  reconciliationRunning = true;
  try {
  const queue = getWebhookQueue();
    const staleBefore = new Date(Date.now() - STALE_DELIVERY_AGE_MS);
    const deliveries = await prisma.webhookDelivery.findMany({
      where: {
        status: { in: ['QUEUED', 'PROCESSING', 'RETRYING'] },
        updatedAt: { lte: staleBefore },
      },
      orderBy: { updatedAt: 'asc' },
      take: 100,
      select: {
        id: true,
        attempts: true,
        maxAttempts: true,
        queueJobId: true,
      },
    });

    let recovered = 0;
    for (const delivery of deliveries) {
      const existingJob = delivery.queueJobId
        ? await queue.getJob(delivery.queueJobId)
        : null;
      const existingState = existingJob ? await existingJob.getState() : null;

      if (existingState && ACTIVE_JOB_STATES.has(existingState)) {
        continue;
      }

      if (delivery.attempts >= delivery.maxAttempts) {
        await prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: {
            status: 'DEAD_LETTER',
            success: false,
            lastError: 'Delivery exhausted its attempts before queue reconciliation.',
            nextRetryAt: null,
          },
        });
        continue;
      }

      if (existingJob) {
        const removed = await existingJob.remove().then(
          () => true,
          (error) => {
            logger.warn(`Could not remove stale webhook job ${existingJob.id}: ${String(error)}`);
            return false;
          },
        );
        if (!removed) continue;
      }

      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'QUEUED',
          success: false,
          nextRetryAt: null,
        },
      });

      const attemptNumber = Math.max(1, delivery.attempts + 1);
      const queueJobId = await enqueueAttempt(delivery.id, attemptNumber, 0);
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: { queueJobId },
      });
      recovered++;
    }

    if (recovered > 0) {
      logger.warn(`Requeued ${recovered} stale webhook deliver${recovered === 1 ? 'y' : 'ies'}.`);
    }
    return recovered;
  } finally {
    reconciliationRunning = false;
  }
}

function startWebhookReconciliation(): void {
  if (reconciliationTimer) return;

  reconciliationTimer = setInterval(() => {
    void reconcileWebhookDeliveries().catch((error) => {
      logger.error('Webhook delivery reconciliation failed:', error);
    });
  }, RECONCILIATION_INTERVAL_MS);
  reconciliationTimer.unref();
}

/**
 * Readiness without the Redis round trip.
 *
 * The readiness decision is `configured && workerRunning && workerConnected` —
 * three in-process booleans. The queue *counts* come from Redis and are pure
 * observability, so they are excluded here by default.
 *
 * This matters because `/ready` is render.yaml's `healthCheckPath`, so Render
 * calls it on a timer, and the app's own keep-alive pinger calls it every five
 * minutes. Each call used to run `getJobCounts` against Redis on both queues —
 * spending a provider's monthly command quota on a number no health check reads,
 * on a service whose Redis is on Upstash's free tier. `/status/summary` still
 * reports the counts; it is secret-gated and human-facing, which is the right
 * place for them.
 */
export async function getWebhookQueueHealth(options: { includeDepth?: boolean } = {}): Promise<WebhookQueueHealth> {
     if (!isWebhookQueueConfigured()) {
       return {
         configured: false,
         workerRunning: false,
         workerConnected: false,
         queueName: QUEUE_NAME,
         counts: {
           waiting: 0,
        active: 0,
        delayed: 0,
        completed: 0,
        failed: 0,
        paused: 0,
      },
    };
  }

  // Queue depth is an observability read, so it is opt-in. See the note above:
  // /ready is the platform's healthCheckPath and must not spend provider quota.
  if (options.includeDepth !== true) {
    return {
      configured: true,
      workerRunning: Boolean(deliveryWorker),
      workerConnected,
      queueName: QUEUE_NAME,
      counts: { waiting: 0, active: 0, delayed: 0, completed: 0, failed: 0, paused: 0 },
      note: 'queue depth omitted — readiness does not read Redis',
    };
  }

  const queue = getWebhookQueue();
  // Bounded. `getJobCounts` was awaited without a deadline, so a stalled Redis
  // meant the call never returned — Render never got its 503 and restarted a
  // healthy instance rather than being told it was degraded.
  const counts = await withRedisDeadline(
    queue.getJobCounts(
      'waiting',
      'active',
      'delayed',
      'completed',
      'failed',
      'paused',
    ),
    undefined,
    'reading webhook queue depth',
  ).catch((error) => {
    logger.warn(`Webhook queue depth unavailable: ${error instanceof Error ? error.message : error}`);
    return null;
  });

  if (!counts) {
    return {
      configured: true,
      workerRunning: Boolean(deliveryWorker),
      workerConnected,
      queueName: QUEUE_NAME,
      counts: { waiting: 0, active: 0, delayed: 0, completed: 0, failed: 0, paused: 0 },
      note: 'queue depth unavailable — Redis did not answer within the deadline',
    };
  }

  return {
    configured: true,
    workerRunning: Boolean(deliveryWorker),
    workerConnected,
    queueName: QUEUE_NAME,
    counts: {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      paused: counts.paused ?? 0,
    },
  };
}

export async function startWebhookQueueWorker(): Promise<void> {
  if (!isWebhookQueueConfigured()) {
    throw new Error('Webhook queue requires REDIS_URL.');
  }

  if (deliveryWorker) return;

  try {
    deliveryWorker = new Worker<WebhookDeliveryJobData, void, string>(
      QUEUE_NAME,
      processWebhookDelivery,
      {
        connection: getWorkerConnection(),
        concurrency: parsePositiveInt(process.env.WEBHOOK_QUEUE_CONCURRENCY, 5),
      },
    );

    deliveryWorker.on('error', (error) => {
      workerConnected = false;
      // Message only, never the error object.
      //
      // redis-parser attaches the command it was parsing to the error, and for a
      // failed AUTH that is `['auth', '<the Redis password>']`. Logging the object
      // therefore writes the credential to logs in plaintext — observed live on
      // the deployed instance during an Upstash plan-limit outage, repeating on
      // every reconnect. redactSecrets walks the object's own keys and none of
      // `command`/`args` is credential-shaped, and the bare password matches no
      // value pattern, so it passed straight through.
      //
      // The message alone identifies the failure ("This database has reached
      // current Fixed plan limits"), which is the whole diagnostic value.
      logger.error(`Webhook queue worker error: ${error instanceof Error ? error.message : String(error)}`);
    });

    deliveryWorker.on('ready', () => {
      workerConnected = true;
      logger.info('Webhook queue worker connected to Redis.');
    });

    deliveryWorker.on('closed', () => {
      workerConnected = false;
    });

    deliveryWorker.on('failed', (job, error) => {
      logger.error(`Webhook queue worker job failed unexpectedly [job=${job?.id ?? 'unknown'}]:`, error);
    });

    await Promise.all([
      getWebhookQueue().waitUntilReady(),
      deliveryWorker.waitUntilReady(),
    ]);

    workerConnected = true;
    await reconcileWebhookDeliveries();
    startWebhookReconciliation();
    logger.info('Webhook queue worker started.');
  } catch (error) {
    workerConnected = false;
    await stopWebhookQueueWorker().catch(() => undefined);
    throw error;
  }
}

export async function stopWebhookQueueWorker(): Promise<void> {
  if (reconciliationTimer) {
    clearInterval(reconciliationTimer);
    reconciliationTimer = null;
  }

  await deliveryWorker?.close();
  deliveryWorker = null;
  workerConnected = false;

  await deliveryQueue?.close();
  deliveryQueue = null;
  workerConnection = null;
  queueConnection = null;
}
