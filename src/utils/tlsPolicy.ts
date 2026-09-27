/**
 * tlsPolicy.ts
 *
 * One place that decides whether an outbound provider call verifies the
 * server's TLS certificate.
 *
 * Four provider adapters used to hardcode `new https.Agent({ rejectUnauthorized: false })`
 * inline. For a payment-verification service that is the worst possible place to
 * be permissive: with verification off, anything able to sit between this process
 * and the bank can serve a receipt it wrote, and the API will report a successful
 * payment that never happened. It also rots silently — nothing logged it, nothing
 * reported it, and there was no way to turn it back on for one host once that
 * host's certificate chain was fixed.
 *
 * Verification is therefore ON by default and relaxation is an explicit,
 * per-hostname, operator-visible decision:
 *
 *   INSECURE_TLS_HOSTS=apps.cbe.com.et,mb.cbe.com.et
 *
 * The default seeds the four hosts that are known to need it today so that
 * relaxing them stays a deliberate act rather than a surprise regression, and so
 * existing deployments keep working. Remove a host from the list as soon as its
 * chain validates — `pnpm tls:report` (and the startup log) show what is still
 * relaxed, and /status/summary exposes it to an authorised operator.
 *
 * This does not make an unverified connection safe. It makes it named, logged,
 * bounded to one hostname, and reversible without a code change. Where a host
 * cannot present a valid chain, certificate pinning (see `pinnedCaFor`) is the
 * correct next step, not a permanent blanket disable.
 */

import fs from 'fs';
import https from 'https';
import logger from './logger';

/**
 * Hosts whose receipts are currently only reachable with certificate
 * verification relaxed. Each entry is a real, observed chain failure — not a
 * precaution. Track removal here.
 */
const KNOWN_BROKEN_CHAIN_HOSTS = [
    // CBE serves an incomplete/legacy chain on both the legacy receipt host
    // (port 100) and the mobile-banking API.
    'apps.cbe.com.et',
    'mb.cbe.com.et',
    // Awash's receipt endpoint on :8225 presents a chain Node does not accept.
    'awashpay.awashbank.com',
    // Zemen's share host likewise.
    'share.zemenbank.com',
];

function configuredInsecureHosts(env: NodeJS.ProcessEnv = process.env): Set<string> {
    const raw = env.INSECURE_TLS_HOSTS;
    const source = raw === undefined ? KNOWN_BROKEN_CHAIN_HOSTS.join(',') : raw;
    return new Set(
        source.split(',')
            .map((entry) => entry.trim().toLowerCase())
            .filter(Boolean),
    );
}

let cached: { hosts: Set<string>; agents: Map<string, https.Agent>; secureAgent: https.Agent } | null = null;

function state() {
    if (!cached) {
        cached = { hosts: configuredInsecureHosts(), agents: new Map(), secureAgent: new https.Agent({ keepAlive: true }) };
    }
    return cached;
}

/** Re-read INSECURE_TLS_HOSTS and drop cached agents. Tests and config reloads. */
export function resetTlsPolicyCache(): void {
    for (const agent of state().agents.values()) agent.destroy();
    state().agents.clear();
    cached = null;
}

export function isTlsVerificationDisabledFor(hostname: string, env: NodeJS.ProcessEnv = process.env): boolean {
    return configuredInsecureHosts(env).has(hostname.trim().toLowerCase());
}

/**
 * Hostnames currently fetched without certificate verification.
 * Surfaced in the startup log and on /status/summary so the exposure is visible
 * from outside the source tree.
 */
export function tlsPolicyState(env: NodeJS.ProcessEnv = process.env): {
    verificationDisabledFor: string[];
    defaultPolicy: string;
} {
    return {
        verificationDisabledFor: [...configuredInsecureHosts(env)].sort(),
        defaultPolicy: 'verify',
    };
}

/** Log the exposure once, loudly, at startup. */
export function logTlsPolicy(env: NodeJS.ProcessEnv = process.env): void {
    const { verificationDisabledFor } = tlsPolicyState(env);
    if (verificationDisabledFor.length === 0) {
        logger.info('TLS certificate verification enabled for every provider host.');
        return;
    }
    logger.warn(
        `⚠️ TLS certificate verification is DISABLED for ${verificationDisabledFor.length} provider host(s): ` +
        `${verificationDisabledFor.join(', ')}. Receipts from these hosts can be forged by anyone on the network ` +
        'path. Set INSECURE_TLS_HOSTS to change this list; remove a host as soon as its chain validates.',
    );
}

/**
 * Optional PEM bundle used to verify a host whose chain is fine but whose root
 * CA is simply missing from the container (the failure verify.php documents for
 * curl errno 60). Preferred over disabling verification:
 *
 *   TLS_CA_BUNDLE_PATH=/etc/ssl/certs/ethiopian-roots.pem
 */
function pinnedCaFor(): Buffer[] | undefined {
    const path = process.env.TLS_CA_BUNDLE_PATH?.trim();
    if (!path) return undefined;
    try {
        return [fs.readFileSync(path)];
    } catch (error) {
        logger.error(`TLS_CA_BUNDLE_PATH is set but could not be read (${path}); falling back to the system store.`, error);
        return undefined;
    }
}

/**
 * The https.Agent to use for `url`. Verification is on unless the hostname is on
 * the explicit relaxation list. Agents are cached per policy, not per call:
 * constructing one per request defeats connection reuse and leaks sockets.
 */
export function httpsAgentFor(url: string | URL): https.Agent {
    const hostname = (typeof url === 'string' ? new URL(url) : url).hostname.toLowerCase();
    const { agents, secureAgent } = state();
    const insecure = state().hosts.has(hostname);
    if (!insecure) return secureAgent;

    const existing = agents.get(hostname);
    if (existing) return existing;
    const agent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });
    agents.set(hostname, agent);
    return agent;
}

/**
 * An agent that verifies against an extra CA bundle, for hosts whose chain is
 * valid but whose root is absent from the image. Returns undefined when no
 * bundle is configured, meaning "use httpsAgentFor()".
 */
export function verifyingAgentWithExtraCa(url: string | URL): https.Agent | undefined {
    const ca = pinnedCaFor();
    if (!ca) return undefined;
    const hostname = (typeof url === 'string' ? new URL(url) : url).hostname.toLowerCase();
    const key = `ca:${hostname}`;
    const { agents } = state();
    const existing = agents.get(key);
    if (existing) return existing;
    const agent = new https.Agent({ keepAlive: true, ca });
    agents.set(key, agent);
    return agent;
}
