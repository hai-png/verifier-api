/**
 * fireWebhook.ts
 *
 * Shared utility for firing outbound webhooks.
 *
 * Two flavours:
 *   fireSessionWebhook  – one-off ad-hoc webhook URL.
 *                         Fire-and-forget; not tied to a registered Webhook record.
 *   fireRegisteredWebhook – queues a registered webhook delivery through BullMQ.
 */

import axios from 'axios';
import type { WebhookPayload } from '../queues/webhookQueue';
import { enqueueWebhookDelivery, scrubUrlForLog } from '../queues/webhookQueue';
import { assertSafeOutboundUrl } from './safeUrl';
import logger from './logger';

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_REQUEST_BYTES = 1024 * 1024;

/**
 * Fire-and-forget POST to a raw webhook URL.
 * This remains process-local because it is not backed by a registered webhook record.
 *
 * ⚠ DEAD CODE WITH NO CALLERS. It is a trap for whoever wires it up next: it took
 * a URL and dereferenced it with none of the controls the registered path has —
 * no `assertSafeOutboundUrl` (so any tenant-supplied target reached an internal
 * address), no `maxRedirects: 0` (so a 302 to 169.254.169.254 was followed), no
 * response-size cap, and no `WEBHOOK_TIMEOUT` beyond the plain request timeout.
 *
 * It is kept only because deleting an exported symbol is a bigger change than
 * making it safe. If you are here to use it, use fireRegisteredWebhook instead;
 * if you are here to delete it, delete it.
 */
export function fireSessionWebhook(url: string, payload: Record<string, unknown>): void {
  void (async () => {
    try {
      await assertSafeOutboundUrl(url);
    } catch (error) {
      logger.warn(`Session webhook refused: ${error instanceof Error ? error.message : 'unsafe destination'}`);
      return;
    }
    try {
      await axios.post(url, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT_MS,
        maxRedirects: 0,
        maxContentLength: MAX_RESPONSE_BYTES,
        maxBodyLength: MAX_REQUEST_BYTES,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown session webhook error';
      logger.warn(`Session webhook delivery failed to ${scrubUrlForLog(url)}: ${message}`);
    }
  })();
}

/**
 * Queue a registered webhook delivery.
 * Legacy signature preserved so existing call sites remain simple during the migration.
 */
export function fireRegisteredWebhook(
  webhookId: string,
  _signingSecret: string | null,
  _url: string,
  payload: Record<string, unknown>,
): void {
  const event = typeof payload.event === 'string' ? payload.event : 'webhook.event';
  void enqueueWebhookDelivery({
    webhookId,
    event,
    payload: payload as WebhookPayload,
  }).catch((error: unknown) => {
    // `error.code` and `error.meta` only. Logging the error object itself hands
    // Prisma the invocation arguments, and Prisma embeds them in its message — so
    // a delivery whose payload exceeded the JSON column, or that hit a deadlock,
    // wrote the entire webhook payload to logs/error-*.log. For
    // `payment_link.paid` that payload carries buyerName, buyerEmail, buyerPhone
    // and the reference, on every transient database error.
    const code = (error as { code?: string })?.code;
    logger.error(`Failed to enqueue registered webhook ${webhookId}${code ? ` (${code})` : ''}: ${
      error instanceof Error ? error.message : 'unknown error'
    }`);
  });
}
