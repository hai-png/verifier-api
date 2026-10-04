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

/**
 * Expand any IPv6 textual form into its 8 numeric hextets, or null if it is not
 * a well-formed address.
 *
 * A dotted-quad tail is accepted in either position the RFCs allow —
 * `::ffff:127.0.0.1` and `::ffff:7f00:1` denote the same address — because
 * `new URL()` normalises the former into the latter before this ever sees it:
 *
 *   new URL('http://[::ffff:169.254.169.254]/').hostname === '[::ffff:a9fe:a9fe]'
 *
 * Matching IPv4 with the regex /^::ffff:(\d+\.\d+\.\d+\.\d+)$/ therefore never
 * fires for a real request: it only matched hand-written test input. Working
 * from hextets makes the two spellings the same value, so there is no spelling
 * that slips past.
 */
export function ipv6ToHextets(ip: string): number[] | null {
    let address = ip.toLowerCase().split('%')[0];
    if (!address.includes(':')) return null;

    // Peel a trailing dotted-quad into two hextets before parsing the groups.
    const tail: number[] = [];
    const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
    if (dotted) {
        const octets = dotted[1].split('.').map(Number);
        if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
        tail.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
        address = address.slice(0, dotted.index);
    }

    const halves = address.split('::');
    if (halves.length > 2) return null;

    const parseGroup = (part: string): number[] | null => {
        if (part === '') return [];
        const out: number[] = [];
        for (const group of part.split(':')) {
            if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
            out.push(parseInt(group, 16));
        }
        return out;
    };

    const head = parseGroup(halves[0]);
    if (head === null) return null;
    if (halves.length === 1) {
        const rest = parseGroup('');
        return head.length + tail.length === 8 ? [...head, ...tail] : null;
    }

    const rest = parseGroup(halves[1]);
    if (rest === null) return null;
    // "::" must stand for at least one zero group, so 8 is never attainable
    // here when the address already supplies all eight.
    const written = head.length + rest.length + tail.length;
    if (written > 7) return null;
    return [...head, ...new Array(8 - written).fill(0), ...rest, ...tail];
}

function hextetsMatchPrefix(hextets: number[], prefixHex: string[]): boolean {
    return prefixHex.every((group, index) => hextets[index] === parseInt(group, 16));
}

/** The IPv4 address an IPv4-mapped/compatible IPv6 address carries. */
function hextetsToIpv4(hextets: number[]): string {
    return `${hextets[6] >> 8}.${hextets[6] & 0xff}.${hextets[7] >> 8}.${hextets[7] & 0xff}`;
}

function isBlockedIpv6(ip: string): boolean {
    const hextets = ipv6ToHextets(ip);
    // Unparseable means unrecognisable, and unrecognisable must not be dialed.
    if (!hextets) return true;

    // :: (unspecified) and ::1 (loopback)
    if (hextets.slice(0, 7).every((h) => h === 0) && (hextets[7] === 0 || hextets[7] === 1)) return true;

    // ::ffff:0:0/96 IPv4-mapped and ::/96 IPv4-compatible both wrap an IPv4
    // address that has to be judged by the IPv4 rules. `::` and `::1` were
    // handled above, so this is only reached with a real embedded address.
    const isV4Mapped = hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff;
    const isV4Compatible = hextets.slice(0, 6).every((h) => h === 0);
    if (isV4Mapped || isV4Compatible) return isPrivateAddress(hextetsToIpv4(hextets));

    // fe80::/10 link-local, fc00::/7 unique-local, ff00::/8 multicast.
    // Numeric masks, not string prefixes: `f[cd]` as a regex over the literal
    // also matched things it should not and missed the ones it should.
    if ((hextets[0] & 0xffc0) === 0xfe80) return true;
    if ((hextets[0] & 0xfe00) === 0xfc00) return true;
    if ((hextets[0] & 0xff00) === 0xff00) return true;

    // 2001:db8::/32 documentation, 64:ff9b:: NAT64, 0100::/16 discard-only.
    if (hextetsMatchPrefix(hextets, ['2001', 'db8'])) return true;
    if (hextetsMatchPrefix(hextets, ['0064', 'ff9b'])) return true;
    if (hextets[0] === 0x0100) return true;

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
