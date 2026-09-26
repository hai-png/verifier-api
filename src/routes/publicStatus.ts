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
import { usageLogStats } from '../middleware/requestLogger';
import { keyUsageStats } from '../middleware/apiKeyAuth';
import { rateLimiterState } from '../middleware/rateLimiter';
import { verifyCacheStats } from '../middleware/verifyResultCache';
import { billingConfigCacheState } from '../config/billingConfig';
import { workspaceDeliveryCacheState } from '../utils/workspaceEvents';
import { quotaRefundState } from '../utils/quotaCharge';

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
        config: {
            redisConfigured: Boolean(process.env.REDIS_URL),
            databaseConfigured: Boolean(process.env.DATABASE_URL),
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

router.get('/summary', (_req: Request, res: Response): void => {
    const capabilities = getStatusCapabilities();

    res.json({
        status: 'operational',
        timestamp: new Date().toISOString(),
        uptimeSeconds: Math.round(process.uptime()),
        diagnostics: buildDiagnostics(),
        providers: PROVIDERS,
        capabilities: {
            batchVerification: capabilities.batchVerification.configured,
            imageVerification: capabilities.imageVerification.configured,
            hostedCommerce: capabilities.hostedCommerce.configured,
        },
    });
});

export default router;
