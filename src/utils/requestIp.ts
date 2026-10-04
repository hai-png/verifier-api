import { Request } from 'express';
import net from 'net';

function headerValue(value: string | string[] | undefined): string | undefined {
    const raw = Array.isArray(value) ? value[0] : value;
    return typeof raw === 'string' ? raw : undefined;
}

/**
 * Honour forwarding headers from a peer we deployed, and only from one.
 *
 * A hop we control rewrites the forwarding headers it sets. A peer we do not
 * control passes them through unchanged, so a header arriving from one is
 * whatever the caller chose. `app.set('trust proxy', 1)` expresses exactly this
 * judgement for `req.ip`; getRequestIp() reads the headers directly and has to
 * make the same call itself.
 *
 * `CF-Connecting-IP` is the sharpest case. Cloudflare overwrites it at the edge —
 * but only for traffic that actually arrives through Cloudflare. If the origin is
 * reachable directly (a mis-scoped security group, a stale DNS record, an SSRF
 * from any tenant feature), the header is the caller's, and preferring it gave an
 * unlimited number of fresh rate-limit buckets. One `CF-Connecting-IP: <random>`
 * per request defeated the anonymous /verify/public cap, the anonymous
 * rateLimiter cap, the login and signup IP throttles and the payment-link
 * confirm throttle, and grew the per-IP key map by one entry per request.
 *
 * A private or loopback peer is our own infrastructure by definition. A public
 * peer is only trusted when the operator has said so, because that reintroduces
 * exactly the property the default removes.
 */
const TRUST_FORWARDED_HEADERS = (process.env.TRUST_FORWARDED_HEADERS ?? 'false').toLowerCase() === 'true';
const TRUST_PROXY_CACHE_TTL_MS = Number(process.env.TRUSTED_PROXY_CACHE_MS ?? 60_000);
const TRUST_PROXY_CACHE_MAX = 1_000;

const trustedPeerCache = new Map<string, { verdict: boolean; expiresAt: number }>();

/** Loopback and private ranges, i.e. "something I deployed". */
function isPrivatePeer(address: string): boolean {
    const bare = address.toLowerCase().split('%')[0].replace(/^\[|\]$/g, '');
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
    const candidate = mapped ? mapped[1]! : bare;

    if (net.isIP(candidate) === 4) {
        const octets = candidate.split('.').map(Number);
        if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return true;
        const [a, b] = octets as [number, number];
        return a === 0 || a === 10 || a === 127
            || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168)
            || (a === 169 && b === 254)
            || (a === 100 && b >= 64 && b <= 127);
    }

    if (net.isIP(bare) !== 6) return true; // unparseable peer: trust nobody
    if (bare === '::' || bare === '::1') return true;
    if ((parseInt(bare.slice(0, 4), 16) & 0xfe00) === 0xfc00) return true;   // fc00::/7
    if ((parseInt(bare.slice(0, 4), 16) & 0xffc0) === 0xfe80) return true;   // fe80::/10
    return false;
}

function isTrustedPeer(address: string | undefined): boolean {
    if (!address) return false;
    const now = Date.now();
    const cached = trustedPeerCache.get(address);
    if (cached && cached.expiresAt > now) return cached.verdict;

    const verdict = isPrivatePeer(address) || TRUST_FORWARDED_HEADERS;
    if (trustedPeerCache.size >= TRUST_PROXY_CACHE_MAX) trustedPeerCache.clear();
    trustedPeerCache.set(address, { verdict, expiresAt: now + TRUST_PROXY_CACHE_TTL_MS });
    return verdict;
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
 * Resolution order, each step gated on the peer being a proxy we deployed:
 *  1. CF-Connecting-IP — Cloudflare overwrites this at the edge.
 *  2. The *rightmost* X-Forwarded-For entry. Each proxy in the chain appends the
 *     address it received the request from, so the last entry is written by the
 *     trusted hop nearest this process and a caller can only prepend entries
 *     ahead of it.
 *  3. The socket address.
 *
 * When the peer is not trusted, steps 1 and 2 are skipped entirely and every
 * caller shares the socket address as its identity. That is coarser than before
 * for a misconfigured deployment — but it is a *bound*, which is what a rate
 * limit has to be. The previous behaviour granted an attacker a fresh bucket per
 * request.
 */
export function getRequestIp(req: Request): string {
    const peer = req.socket?.remoteAddress;

    if (isTrustedPeer(peer)) {
        const connectingIp = headerValue(req.headers['cf-connecting-ip'])?.trim();
        if (connectingIp) return connectingIp;

        const forwardedFor = headerValue(req.headers['x-forwarded-for']);
        if (forwardedFor) {
            const nearestHop = forwardedFor.split(',').pop()?.trim();
            if (nearestHop) return nearestHop;
        }
    }

    return peer || 'unknown';
}

/** Observability: how many peer addresses are currently cached. */
export function trustedPeerCacheState(): { entries: number; trustingForwardedHeaders: boolean } {
    return { entries: trustedPeerCache.size, trustingForwardedHeaders: TRUST_FORWARDED_HEADERS };
}
