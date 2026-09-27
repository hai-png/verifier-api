import dns from 'dns';
import net from 'net';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

// Protocols that are safe to place in an href the browser will follow. This is
// strictly narrower than ALLOWED_PROTOCOLS: a server-side fetch may legitimately
// speak http, but a rendered link must never be `javascript:`, `data:` or
// `vbscript:`. `new URL()` alone accepts all of them, which is how a merchant
// could hand a buyer a checkout link that runs script in the dashboard origin
// and reads the session token out of localStorage.
const BROWSER_NAVIGABLE_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Validate a URL that will be rendered as a link and clicked by a user.
 * Synchronous, scheme-only: no DNS here, because the browser resolves it.
 */
export function assertBrowserNavigableUrl(raw: unknown): URL {
    if (typeof raw !== 'string' || !raw.trim()) {
        throw new UnsafeOutboundUrlError('a non-empty URL string is required');
    }
    let url: URL;
    try {
        url = new URL(raw.trim());
    } catch {
        throw new UnsafeOutboundUrlError('not a valid absolute URL');
    }
    if (!BROWSER_NAVIGABLE_PROTOCOLS.has(url.protocol)) {
        throw new UnsafeOutboundUrlError(`protocol ${url.protocol} must be http or https`);
    }
    return url;
}

// Hostnames that reach infrastructure metadata or a single-label internal name.
const BLOCKED_HOSTNAMES = new Set([
    'metadata',
    'metadata.google.internal',
    'metadata.goog',
    'instance-data',
    'instance-data.ec2.internal',
]);

function ipv4ToInt(ip: string): number | null {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    let value = 0;
    for (const part of parts) {
        const octet = Number(part);
        if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
        value = value * 256 + octet;
    }
    return value;
}

// [network, prefix] pairs covering loopback, private, link-local (cloud
// metadata), CGNAT, documentation, benchmarking, multicast and reserved space.
const BLOCKED_IPV4: Array<[number, number]> = [
    [0x00000000, 8],       // 0.0.0.0/8        "this" network
    [0x0a000000, 8],       // 10.0.0.0/8       private
    [0x64400000, 10],      // 100.64.0.0/10    CGNAT
    [0x7f000000, 8],       // 127.0.0.0/8      loopback
    [0xa9fe0000, 16],      // 169.254.0.0/16   link-local (169.254.169.254)
    [0xac100000, 12],      // 172.16.0.0/12    private
    [0xc0000000, 24],      // 192.0.0.0/24     IETF protocol assignments
    [0xc0000200, 24],      // 192.0.2.0/24     documentation
    [0xc0586300, 24],      // 192.88.99.0/24   6to4 relay anycast
    [0xc0a80000, 16],      // 192.168.0.0/16   private
    [0xc6120000, 15],      // 198.18.0.0/15    benchmarking
    [0xc6336400, 24],      // 198.51.100.0/24  documentation
    [0xcb007100, 24],      // 203.0.113.0/24   documentation
    [0xe0000000, 4],       // 224.0.0.0/4      multicast
    [0xf0000000, 4],       // 240.0.0.0/4      reserved + broadcast
];

function isBlockedIpv6(ip: string): boolean {
    const address = ip.toLowerCase().split('%')[0];
    if (address === '::' || address === '::1') return true;
    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible forms carry an IPv4
    // address that must be checked with the IPv4 rules.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
    if (mapped) return isPrivateAddress(mapped[1]);
    if (address.startsWith('fe80')) return true;                 // link-local
    if (/^f[cd]/.test(address)) return true;                    // fc00::/7 unique-local
    if (address.startsWith('ff')) return true;                  // multicast
    if (address.startsWith('2001:db8')) return true;            // documentation
    if (address.startsWith('64:ff9b')) return true;              // NAT64
    if (address.startsWith('100:')) return true;                 // discard-only
    return false;
}

/** True when the address is anything other than a routable public address. */
export function isPrivateAddress(ip: string): boolean {
    const version = net.isIP(ip);
    if (version === 4) {
        const value = ipv4ToInt(ip);
        if (value === null) return true;
        return BLOCKED_IPV4.some(([network, prefix]) => {
            const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
            return (value & mask) >>> 0 === (network & mask) >>> 0;
        });
    }
    if (version === 6) return isBlockedIpv6(ip);
    // Not a recognisable IP literal.
    return true;
}

export class UnsafeOutboundUrlError extends Error {
    readonly reason: string;
    constructor(reason: string) {
        super(`Unsafe outbound URL: ${reason}`);
        this.name = 'UnsafeOutboundUrlError';
        this.reason = reason;
    }
}

/**
 * Validate a tenant-supplied URL before the server dereferences it.
 *
 * A webhook or redirect target is attacker-controlled, and the server performs
 * the request, so an unvalidated URL turns any tenant into an internal scanner:
 * `new URL()` alone accepts http://169.254.169.254/ (cloud credentials),
 * http://127.0.0.1:3001/admin/... and file:///etc/passwd. Every resolved address
 * is checked, not just the hostname, so a public name pointing at a private
 * address is rejected too.
 */
export async function assertSafeOutboundUrl(raw: unknown): Promise<URL> {
    if (typeof raw !== 'string' || !raw.trim()) {
        throw new UnsafeOutboundUrlError('a non-empty URL string is required');
    }

    let url: URL;
    try {
        url = new URL(raw.trim());
    } catch {
        throw new UnsafeOutboundUrlError('not a valid absolute URL');
    }

    if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
        throw new UnsafeOutboundUrlError(`protocol ${url.protocol} is not allowed`);
    }
    if (url.username || url.password) {
        throw new UnsafeOutboundUrlError('credentials in the URL are not allowed');
    }

    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!hostname) throw new UnsafeOutboundUrlError('missing hostname');
    if (BLOCKED_HOSTNAMES.has(hostname)) {
        throw new UnsafeOutboundUrlError(`host ${hostname} is not allowed`);
    }
    if (!hostname.includes('.') && net.isIP(hostname) === 0) {
        // Single-label names resolve through the internal resolver only.
        throw new UnsafeOutboundUrlError(`internal hostname ${hostname} is not allowed`);
    }

    if (net.isIP(hostname)) {
        if (isPrivateAddress(hostname)) {
            throw new UnsafeOutboundUrlError(`address ${hostname} is not a public address`);
        }
        return url;
    }

    let addresses: Array<{ address: string }>;
    try {
        addresses = await dns.promises.lookup(hostname, { all: true, verbatim: true });
    } catch {
        throw new UnsafeOutboundUrlError(`host ${hostname} could not be resolved`);
    }
    if (addresses.length === 0) {
        throw new UnsafeOutboundUrlError(`host ${hostname} could not be resolved`);
    }
    for (const { address } of addresses) {
        if (isPrivateAddress(address)) {
            throw new UnsafeOutboundUrlError(`host ${hostname} resolves to a non-public address`);
        }
    }
    return url;
}
