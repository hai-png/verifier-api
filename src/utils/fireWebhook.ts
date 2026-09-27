/**
 * fireWebhook.ts
 *
 * Shared utility for firing outbound webhooks.
 *
 * Every delivery goes through a registered Webhook record and the BullMQ queue,
 * because that is the only path that re-validates the destination with
 * `assertSafeOutboundUrl` before connecting, signs the payload, bounds the
 * response size, refuses to follow redirects and retries with backoff.
 *
 * A `fireSessionWebhook(url, payload)` helper used to live here for ad-hoc URLs.
 * It had no callers and none of those protections — an unvalidated, unsigned POST
 * to an arbitrary URL is exactly the SSRF shape the queued path exists to avoid,
 * so it was removed rather than left as a loaded gun for the next call site.
 */

import type { WebhookPayload } from '../queues/webhookQueue';
import { enqueueWebhookDelivery } from '../queues/webhookQueue';
import logger from './logger';

/**
 * Queue a registered webhook delivery.
 *
 * The signing secret and URL used to be passed in and then ignored — the queue
 * re-reads both from the Webhook row at delivery time, which is correct, because
 * a delivery can sit in the queue across a secret rotation. Carrying them here
 * meant four call sites selected a plaintext credential out of the database for
 * no reason, and a reader could reasonably assume the value passed was the value
 * used to sign.
 */
export function fireRegisteredWebhook(
  webhookId: string,
  payload: Record<string, unknown>,
): void {
  const event = typeof payload.event === 'string' ? payload.event : 'webhook.event';
  void enqueueWebhookDelivery({
    webhookId,
    event,
    payload: payload as WebhookPayload,
  }).catch((error) => {
    logger.error(`Failed to enqueue registered webhook ${webhookId}:`, error);
  });
}
