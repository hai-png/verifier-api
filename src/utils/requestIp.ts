import { Request } from 'express';

function headerValue(value: string | string[] | undefined): string | undefined {
    const raw = Array.isArray(value) ? value[0] : value;
    return typeof raw === 'string' ? raw : undefined;
}

/**
 * Client IP, used for rate limits, dashboard composite limits and usage logs.
 *
 * Never use the *leftmost* X-Forwarded-For entry. That value is supplied by the
 * caller, and it was the basis of every IP-based throttle in this service, so
 * rotating the header produced an unlimited number of fresh buckets: the
 * anonymous POST /verify/public cap (10/hour) and the anonymous rateLimiter cap
 * (6/hour) were both defeated with one header, and the per-IP stats map grew by
 * one entry per request.
 *
 * Resolution order:
 *  1. CF-Connecting-IP — Cloudflare overwrites this at the edge, so it is the
 *     true client when Cloudflare fronts the origin.
 *  2. The *rightmost* X-Forwarded-For entry. Each proxy in the chain appends
 *     the address it received the request from, so the last entry is written by
 *     the trusted hop nearest this process and a caller can only prepend
 *     entries ahead of it. That is the entry to trust.
 *  3. The socket address.
 *
 * This assumes the request reaches the app through a proxy that appends to
 * X-Forwarded-For (Render always does). If it is ever exposed without one, the
 * caller's own header is the only thing present and limit accuracy degrades —
 * but it never grants more than the configured limit to a single identity.
 */
export function getRequestIp(req: Request): string {
    const connectingIp = headerValue(req.headers['cf-connecting-ip'])?.trim();
    if (connectingIp) return connectingIp;

    const forwardedFor = headerValue(req.headers['x-forwarded-for']);
    if (forwardedFor) {
        // Rightmost = the entry appended by the nearest trusted proxy.
        const nearestHop = forwardedFor.split(',').pop()?.trim();
        if (nearestHop) return nearestHop;
    }

    return req.socket?.remoteAddress || 'unknown';
}
