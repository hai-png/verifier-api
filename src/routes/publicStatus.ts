/**
 * Public status summary — no auth required.
 *
 * Deliberately abuse-safe: liveness + configuration flags only, no live
 * upstream probes (those stay behind the signed /internal/status routes).
 * Mounted BEFORE apiKeyAuth in index.ts.
 *
 * GET /status/summary
 */

import os from 'node:os';
import { Router, Request, Response } from 'express';
import { getStatusCapabilities } from '../services/statusProbeService';
import { resolvePublicApiUrl } from '../config/publicApiUrl';
import { usageLogStats } from '../middleware/requestLogger';
import { keyUsageStats } from '../middleware/apiKeyAuth';
import { rateLimiterState } from '../middleware/rateLimiter';
import { verifyCacheStats } from '../middleware/verifyResultCache';
import { billingConfigCacheState } from '../config/billingConfig';
import { workspaceDeliveryCacheState } from '../utils/workspaceEvents';
import { quotaRefundState } from '../utils/quotaCharge';
import { safeSecretEquals } from '../utils/secretCompare';
import { MemoryWindowCounter } from '../utils/expiringStore';
import { getRequestIp } from '../utils/requestIp';
import { dbMetricsSnapshot } from '../utils/dbMetrics';

/**
 * Lightweight process diagnostics.
 *
 * Ops visibility only — no secrets, no customer data: memory (so a soak test can
 * spot leaks on a 512 MB instance), CPU count (a Render free instance reports
 * the *host's* core count, which is what Prisma sizes its connection pool from),
 * and the state of the in-memory caches/buffers this service keeps.
 */
function buildDiagnostics() {
    const memory = process.memoryUsage();
    const cpus = os.cpus();
    const load = os.loadavg();
    return {
        memory: {
            rssMb: Math.round(memory.rss / 1024 / 1024),
            heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
            heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
        },
        process: {
            uptimeSeconds: Math.round(process.uptime()),
            node: process.version,
            pid: process.pid,
            reportedCpuCount: cpus.length,
            loadAverage1m: Number(load[0]?.toFixed(2) ?? 0),
            freeMemoryMb: Math.round(os.freemem() / 1024 / 1024),
        },
        caches: {
            billingConfig: billingConfigCacheState(),
            verificationResults: verifyCacheStats(),
            workspaceDelivery: workspaceDeliveryCacheState(),
        },
        buffers: {
            usageLogs: usageLogStats(),
            apiKeyUsage: keyUsageStats(),
        },
        rateLimiter: rateLimiterState(),
        quotaRefunds: quotaRefundState(),
        // The number that matters for capacity planning: how many SQL statements
        // one request costs, measured on this instance (see DEPLOYMENT.md).
        database: dbMetricsSnapshot(),
        config: {
            redisConfigured: Boolean(process.env.REDIS_URL),
            databaseConfigured: Boolean(process.env.DATABASE_URL),
            // Booleans only — enough to diagnose "the service ignored my
            // x-dashboard-key" or "why did it not sleep" from outside, without
            // disclosing any secret value.
            dashboardSecretConfigured: Boolean(process.env.DASHBOARD_SECRET),
            // Reports the same variable the pinger resolves, via the same helper.
            // It used to accept VERITAS_APP_URL as well, so it kept answering
            // true while the pinger was pointed at the dashboard and 404ing.
            keepAliveUrlConfigured: Boolean(resolvePublicApiUrl()),
            keepAlivePingerEnabled: (process.env.KEEP_ALIVE_PINGER ?? 'true').toLowerCase() !== 'false',
            telebirrRelays: (process.env.FALLBACK_PROXIES || '').split(',').map(v => v.trim()).filter(Boolean).length,
            primaryVerificationSkipped: process.env.SKIP_PRIMARY_VERIFICATION === 'true',
        },
    };
}

const router = Router();

const PROVIDERS = [
    'telebirr',
    'cbe',
    'cbebirr',
    'dashen',
    'abyssinia',
    'mpesa',
    'awash',
    'zemen',
];

/**
 * Resolve whether the caller is entitled to the diagnostics block.
 *
 * Everything in `diagnostics` was previously public: host memory, PID, node
 * version, cache sizes, buffer depths, which secrets are configured, and real
 * SQL statement text. That is a free reconnaissance and memory-pressure oracle
 * for anyone who can reach the URL, so it is now gated on a secret.
 *
 * Headers only. `req.query.secret` used to be accepted, which put a secret that
 * unlocks host memory, the PID, node version and buffer depths into every CDN
 * and proxy access log, every `Referer` header and browser history — reintroducing
 * exactly the pattern adminRoute.ts removed with the comment "Header only: the
 * key used to be accepted as ?adminKey=, which put it in access logs, Referer
 * headers and browser history."
 *
 * `x-admin-key` is also no longer accepted here. Using the admin secret as a
 * second key for a public endpoint widens its blast radius for no benefit, and
 * this route is unauthenticated and unrated.
 */
function diagnosticsAuthorised(req: Request): boolean {
    const secret = process.env.STATUS_MONITOR_SECRET;
    if (!secret) return false;
    const presented = req.headers['x-status-secret'] as string | undefined;
    return safeSecretEquals(presented, secret);
}

/**
 * Brute-force guard for the diagnostics gate.
 *
 * `safeSecretEquals` is constant-time, so the secret cannot be recovered by
 * timing — but an unrated endpoint still accepts unlimited guesses. Ten failures
 * per IP per hour, on top of the constant-time compare.
 */
const DIAGNOSTICS_WINDOW_MS = 60 * 60 * 1000;
const DIAGNOSTICS_MAX_FAILURES = 10;
const diagnosticsFailures = new MemoryWindowCounter({ maxEntries: 5_000 });

function diagnosticsThrottled(req: Request): boolean {
    const entry = diagnosticsFailures.increment(`status:${getRequestIp(req)}`, DIAGNOSTICS_WINDOW_MS);
    return entry.count > DIAGNOSTICS_MAX_FAILURES;
}

router.get('/summary', (req: Request, res: Response): void => {
    const capabilities = getStatusCapabilities();
    const authorised = diagnosticsAuthorised(req);

    // Throttle only the unauthorised case: a monitoring agent that has the
    // secret must never be locked out by someone else's guessing.
    if (!authorised && diagnosticsThrottled(req)) {
        res.status(429).json({ success: false, error: 'Too many status-secret attempts. Retry later.' });
        return;
    }

    res.json({
        status: 'operational',
        timestamp: new Date().toISOString(),
        uptimeSeconds: Math.round(process.uptime()),
        // Liveness and the provider/capability list stay public; the host and
        // database internals do not. `diagnostics: null` tells a caller the
        // block exists but is withheld, without leaking whether a secret is set.
        diagnostics: authorised ? buildDiagnostics() : null,
        providers: PROVIDERS,
        capabilities: {
            batchVerification: capabilities.batchVerification.configured,
            imageVerification: capabilities.imageVerification.configured,
            hostedCommerce: capabilities.hostedCommerce.configured,
        },
    });
});

export default router;
