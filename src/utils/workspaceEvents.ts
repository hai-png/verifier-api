import { prisma } from './prisma';
import { enqueueNotificationDelivery } from '../queues/notificationQueue';
import { fireRegisteredWebhook } from './fireWebhook';
import logger from './logger';

export const WORKSPACE_EVENTS = [
    'payment_link.paid',
    'product.sold_out',
    'verification.success',
    'verification.failed',
    'webhook.dead_letter',
] as const;

export type WorkspaceEventName = (typeof WORKSPACE_EVENTS)[number];

export interface WorkspaceEventPayload {
    event: WorkspaceEventName;
    firedAt: string;
    [key: string]: unknown;
}

// ─── Delivery-target cache ────────────────────────────────────────────────────
// emitWorkspaceEvent runs after every verification outcome. Fetching the
// workspace's webhooks and notification channels costs two database round trips
// even for the vast majority of workspaces that have neither configured. Cache
// "this workspace has no delivery targets" briefly so those verifications cost
// zero extra queries; workspaces that do have targets keep the exact behaviour
// (fresh rows on every event).
const DELIVERY_CACHE_TTL_MS = Number(process.env.WORKSPACE_DELIVERY_CACHE_TTL_MS ?? 30_000);
const DELIVERY_CACHE_MAX_ENTRIES = 10_000;

const noTargetsCache = new Map<string, number>();

/** Invalidate after webhook/channel mutations (also called from index.ts). */
export function invalidateWorkspaceDeliveryCache(workspaceId?: string | null): void {
    if (!workspaceId) return;
    noTargetsCache.delete(workspaceId);
}

export function workspaceDeliveryCacheState(): { entries: number; ttlMs: number } {
    return { entries: noTargetsCache.size, ttlMs: DELIVERY_CACHE_TTL_MS };
}

function rememberNoTargets(workspaceId: string): void {
    if (DELIVERY_CACHE_TTL_MS <= 0) return;
    const now = Date.now();
    if (noTargetsCache.size >= DELIVERY_CACHE_MAX_ENTRIES) {
        for (const [key, expiry] of noTargetsCache) {
            if (expiry <= now) noTargetsCache.delete(key);
        }
        if (noTargetsCache.size >= DELIVERY_CACHE_MAX_ENTRIES) noTargetsCache.clear();
    }
    noTargetsCache.set(workspaceId, now + DELIVERY_CACHE_TTL_MS);
}

function hasNoTargets(workspaceId: string): boolean {
    if (DELIVERY_CACHE_TTL_MS <= 0) return false;
    const expiry = noTargetsCache.get(workspaceId);
    if (expiry === undefined) return false;
    if (expiry <= Date.now()) {
        noTargetsCache.delete(workspaceId);
        return false;
    }
    return true;
}

export async function emitWorkspaceEvent(
    workspaceId: string,
    event: WorkspaceEventName,
    payload: Record<string, unknown>,
): Promise<void> {
    try {
        // Fast path: this workspace had no webhooks or channels a moment ago,
        // so there is nothing to fan out to.
        if (hasNoTargets(workspaceId)) return;

        const [webhooks, notificationChannels] = await Promise.all([
            prisma.webhook.findMany({
                where: { workspaceId, active: true },
                select: { id: true, url: true, signingSecret: true, events: true },
            }),
            prisma.notificationChannel.findMany({
                where: { workspaceId, active: true },
                select: { id: true, events: true },
            }),
        ]);

        const eventPayload: WorkspaceEventPayload = {
            event,
            firedAt: new Date().toISOString(),
            ...payload,
        };

        for (const webhook of webhooks) {
            const events = Array.isArray(webhook.events) ? (webhook.events as string[]) : [];
            if (!events.includes(event)) continue;

            fireRegisteredWebhook(webhook.id, webhook.signingSecret, webhook.url, eventPayload);
        }

        if (webhooks.length === 0 && notificationChannels.length === 0) {
            rememberNoTargets(workspaceId);
        }

        for (const channel of notificationChannels) {
            const events = Array.isArray(channel.events) ? (channel.events as string[]) : [];
            if (!events.includes(event)) continue;

            void enqueueNotificationDelivery({
                channelId: channel.id,
                event,
                payload: eventPayload,
            }).catch((error) => {
                logger.error(`Failed to enqueue notification channel ${channel.id}:`, error);
            });
        }
    } catch (error) {
        logger.error(`Failed to emit workspace event ${event} for workspace ${workspaceId}:`, error);
    }
}
