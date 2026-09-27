import net from 'net';
import { Request } from 'express';
import { safeSecretEquals } from './secretCompare';

function headerValue(value: string | string[] | undefined): string | undefined {
    const raw = Array.isArray(value) ? value[0] : value;
    return typeof raw === 'string' ? raw.trim() : undefined;
}

/**
 * Client IP, used for rate limits, dashboard composite limits and usage logs.
 *
 * Never use the *leftmost* X-Forwarded-For entry. That value is supplied by the
 * caller, and it was the basis of every IP-based throttle in this service, so
 * rotating the header produced an unlimited number of fresh buckets: the
 * anonymous POST /verify/public cap and the anonymous rateLimiter cap were both
 * defeated with one header, and the per-IP stats map grew by one entry per
 * request.
 *
 * Resolution order (see `resolveClientIpSource` for how the first step is
 * gated):
 *  1. CF-Connecting-IP — Cloudflare overwrites this at the edge, so it is the
 *     true client *when Cloudflare is the only way to reach this process*.
 *  2. The *rightmost* X-Forwarded-For entry. Each proxy in the chain appends
 *     the address it received the request from, so the last entry is written by
 *     the trusted hop nearest this process and a caller can only prepend
 *     entries ahead of it.
 *  3. The socket address.
 *
 * Step 1 is the weak link and is now explicit about it. A platform hostname
 * (Render's `*.onrender.com`) is reachable directly, bypassing Cloudflare, and
 * on such a request `CF-Connecting-IP` is just another caller-supplied header:
 * sending a random value per request hands out a fresh throttle bucket every
 * time. Two controls, either of which is sufficient:
 *
 *   - Set CLOUDFLARE_INGRESS_SECRET and have Cloudflare attach it (Transform
 *     Rule → Modify request header, or a Worker). Step 1 is then only honoured
 *     on requests carrying the secret, and a direct-to-origin request falls
 *     through to the unforgeable rightmost XFF entry. This is the real fix.
 *   - Or block direct access to the origin at the network layer (Cloudflare
 *     Authenticated Origin Pulls + a firewall rule allowing only Cloudflare
 *     IPs). See DEPLOYMENT.md.
 *
 * With neither in place the header is still honoured, because the alternative
 * (rightmost XFF) collapses every Cloudflare-fronted user onto a handful of
 * edge IPs and turns a per-visitor cap into a site-wide one. That trade-off is
 * reported by `clientIpTrustState()` so it is visible on /status/summary
 * instead of being assumed.
 */
export type ClientIpSource = 'auto' | 'cf-connecting-ip' | 'x-forwarded-for' | 'socket';

export const CF_INGRESS_HEADER = 'x-veritas-cf-ingress';

const VALID_SOURCES: readonly ClientIpSource[] = ['auto', 'cf-connecting-ip', 'x-forwarded-for', 'socket'];

function configuredSource(env: NodeJS.ProcessEnv = process.env): ClientIpSource {
    const raw = headerValue(env.CLIENT_IP_SOURCE)?.toLowerCase();
    return VALID_SOURCES.includes(raw as ClientIpSource) ? (raw as ClientIpSource) : 'auto';
}

/**
 * A throttle key is only as good as its format: an attacker-supplied
 * CF-Connecting-IP of `x`.repeat(10000) would otherwise be accepted verbatim and
 * stored in the in-memory counter map. Accept only address literals.
 */
function isAddressLiteral(value: string | undefined): value is string {
    return Boolean(value) && net.isIP(value!) !== 0;
}

function rightmostForwardedFor(req: Request): string | undefined {
    const forwardedFor = headerValue(req.headers['x-forwarded-for']);
    if (!forwardedFor) return undefined;
    // Rightmost = the entry appended by the nearest trusted proxy.
    const nearestHop = forwardedFor.split(',').pop()?.trim();
    return nearestHop || undefined;
}

/** True when a request claiming to come via Cloudflare is corroborated. */
function cfIngressCorroborated(req: Request, env: NodeJS.ProcessEnv): boolean {
    const expected = env.CLOUDFLARE_INGRESS_SECRET;
    if (!expected) return true; // no secret configured: nothing to corroborate with
    // safeSecretEquals is constant-time and fails closed on an unset expected
    // value, which is exactly why the guard above has to exist separately.
    return safeSecretEquals(headerValue(req.headers[CF_INGRESS_HEADER]), expected);
}

export function resolveClientIpSource(req: Request, env: NodeJS.ProcessEnv = process.env): 'cf-connecting-ip' | 'x-forwarded-for' | 'socket' {
    const source = configuredSource(env);
    if (source === 'socket') return 'socket';

    const connectingIp = headerValue(req.headers['cf-connecting-ip']);
    const cfUsable = (source === 'cf-connecting-ip' || source === 'auto')
        && isAddressLiteral(connectingIp)
        && cfIngressCorroborated(req, env);
    if (cfUsable) return 'cf-connecting-ip';
    if (source === 'cf-connecting-ip') return 'socket';

    if (rightmostForwardedFor(req)) return 'x-forwarded-for';
    return 'socket';
}

export function getRequestIp(req: Request, env: NodeJS.ProcessEnv = process.env): string {
    switch (resolveClientIpSource(req, env)) {
        case 'cf-connecting-ip':
            return headerValue(req.headers['cf-connecting-ip'])!;
        case 'x-forwarded-for':
            return rightmostForwardedFor(req)!;
        default:
            return req.socket?.remoteAddress || 'unknown';
    }
}

/**
 * Reported on /status/summary (authorised block) and logged at startup: whether
 * IP-based throttles currently rest on a header the caller can forge.
 */
export function clientIpTrustState(env: NodeJS.ProcessEnv = process.env): {
    source: ClientIpSource;
    cfHeaderCorroborated: boolean;
    ipThrottlesBypassableByHeader: boolean;
} {
    const source = configuredSource(env);
    const cfHeaderCorroborated = Boolean(env.CLOUDFLARE_INGRESS_SECRET);
    const honoursCfHeader = source === 'cf-connecting-ip'
        || (source === 'auto' && !cfHeaderCorroborated);
    return { source, cfHeaderCorroborated, ipThrottlesBypassableByHeader: honoursCfHeader };
}
