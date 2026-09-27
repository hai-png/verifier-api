import express, { Request, Response, NextFunction, ErrorRequestHandler, RequestHandler } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

import CBERouter from './routes/verifyCBERoute';
import { closeCBEBrowser, getChromeExecutablePath } from './services/verifyCBE';
import telebirrRouter from './routes/verifyTelebirrRoute';
import dashenRouter from './routes/verifyDashenRoute';
import abyssiniaRouter from './routes/verifyAbyssiniaRoute';
import cbebirrRouter from './routes/verifyCBEBirrRoute';
import mpesaRouter from './routes/verifyMpesaRoute';
import awashRouter from './routes/verifyAwashRoute';
import zemenRouter from './routes/verifyZemenRoute';
import universalRouter from './routes/verifyUniversalRoute';
import batchRouter from './routes/verifyBatch';
import paymentLinksRouter from './routes/paymentLinks';
import payoutsRouter from './routes/payouts';
import productsRouter from './routes/products';
import ordersRouter from './routes/orders';
import webhooksRouter from './routes/webhooks';
import notificationsRouter from './routes/notifications';
import adminRouter from './routes/adminRoute';
import internalStatusRouter from './routes/internalStatus';
import publicStatusRouter from './routes/publicStatus';
import logger from './utils/logger';
import { verifyImageHandler } from "./services/verifyImage";
import { requestLogger, initializeStatsCache, flushUsageLogs, drainUsageLogs } from './middleware/requestLogger';
import { recordHttpRequest } from './utils/dbMetrics';
import { apiKeyAuth, flushKeyUsageCounters, drainKeyUsageCounters } from './middleware/apiKeyAuth';
import { quotaRefundHook } from './utils/quotaCharge';
import { invalidateWorkspaceDeliveryCache } from './utils/workspaceEvents';
import { getWorkspaceId } from './utils/workspaceContext';
import { singleFlight } from './utils/singleFlight';
import { rateLimiter } from './middleware/rateLimiter';
import { verifyImageGate, permissionGate } from './middleware/tierGate';
import { verifyWebhookHook } from './middleware/verifyWebhookHook';
import { getWebhookQueueHealth, startWebhookQueueWorker, stopWebhookQueueWorker } from './queues/webhookQueue';
import { getNotificationQueueHealth, startNotificationQueueWorker, stopNotificationQueueWorker } from './queues/notificationQueue';
import { prisma, disconnectPrisma } from './utils/prisma';
import { logTlsPolicy } from './utils/tlsPolicy';
import { startSessionMaintenance, stopSessionMaintenance, drainSessionMaintenance } from './utils/sessionMaintenance';
import { logSecretVaultState, migrateLegacyWebhookSecrets } from './utils/secretVault';

// Dashboard-facing routes (session-authenticated, not API-key-authenticated)
import authRouter from './routes/auth';
import workspacesRouter from './routes/workspaces';
import dashboardRouter from './routes/dashboard';

const app = express();
const PORT = process.env.PORT || 3001;
let server: ReturnType<typeof app.listen> | null = null;

const startupState = {
    initializing: true,
    ready: false,
    initializedAt: null as string | null,
    lastError: null as string | null,
};

const KEEP_ALIVE_INTERVAL_MS = 5 * 60 * 1000;
const KEEP_ALIVE_TIMEOUT_MS = 15 * 1000;
const keepAliveUrl =
    process.env.RENDER_EXTERNAL_URL || process.env.VERITAS_APP_URL || '';
let keepAliveTimer: NodeJS.Timeout | null = null;

const KEEP_ALIVE_PINGER_ENABLED = (process.env.KEEP_ALIVE_PINGER ?? 'true').toLowerCase() !== 'false';

function startKeepAlivePinger(): void {
    // The ping goes out to the public URL, so Render counts it as traffic and
    // never idles the instance out. Set KEEP_ALIVE_PINGER=false when something
    // else does the pinging (an external monitor) or when you are measuring a
    // real cold start.
    if (!KEEP_ALIVE_PINGER_ENABLED) {
        logger.info('Keep-alive pinger disabled (KEEP_ALIVE_PINGER=false).');
        return;
    }
    if (!keepAliveUrl) {
        logger.warn('Keep-alive pinger disabled — set RENDER_EXTERNAL_URL or VERITAS_APP_URL to enable it.');
        return;
    }
    const ping = async (): Promise<void> => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), KEEP_ALIVE_TIMEOUT_MS);
        try {
            const startedAt = Date.now();
            const res = await fetch(`${keepAliveUrl}/ready`, { signal: controller.signal });
            if (res.ok) {
                logger.info(`Keep-alive ping OK in ${Date.now() - startedAt}ms`);
            } else {
                logger.warn(`Keep-alive ping returned ${res.status}`);
            }
        } catch (error) {
            logger.warn(`Keep-alive ping failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        } finally {
            clearTimeout(timeout);
        }
    };
    keepAliveTimer = setInterval(ping, KEEP_ALIVE_INTERVAL_MS);
    void ping();
}

function stopKeepAlivePinger(): void {
    if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
    }
}

// Add environment info to startup log
logger.info(`Starting server in ${process.env.NODE_ENV || 'development'} mode`);
logger.info(`Node version: ${process.version}`);
logger.info(`Platform: ${process.platform}`);

/**
 * Shared secrets gate /admin/*, the dashboard-secret API path and session
 * tokens. They default to empty and every comparison fails closed, so a missing
 * value disables those surfaces rather than falling back to a guessable
 * constant. That failure is silent, though, and on a free-tier deploy it looks
 * like "the admin key is just wrong". Surface it loudly, and refuse to come up
 * in production.
 */
const REQUIRED_SHARED_SECRETS = ['ADMIN_SECRET', 'DASHBOARD_SECRET'] as const;
const MIN_SHARED_SECRET_LENGTH = 16;

function assertSharedSecretsConfigured(): void {
    const missing = REQUIRED_SHARED_SECRETS.filter((key) => {
        const value = process.env[key];
        return !value || value.length < MIN_SHARED_SECRET_LENGTH;
    });
    if (missing.length === 0) return;

    const detail = `${missing.join(', ')} must be set to a random value of at least ${MIN_SHARED_SECRET_LENGTH} characters (openssl rand -hex 32). Until then /admin/* and the dashboard-secret API reject every request.`;
    if (process.env.NODE_ENV === 'production') {
        throw new Error(`Refusing to start: ${detail}`);
    }
    logger.warn(`⚠️ ${detail}`);
}

async function initializeRuntime(): Promise<void> {
    startupState.initializing = true;
    startupState.ready = false;
    startupState.lastError = null;

    try {
        assertSharedSecretsConfigured();

        // Verify Chrome is installed for the legacy CBE fallback. This checks
        // both system paths and the Puppeteer cache used by Render/Docker.
        const foundPath = getChromeExecutablePath();
        if (foundPath) {
            logger.info(`✅ Chrome/Chromium available for CBE fallback: ${foundPath}`);
            await import('child_process').then(({ execFile }) => {
                execFile(foundPath, ['--version'], { timeout: 5000 }, (err, stdout) => {
                    if (!err && stdout) logger.info(`🌐 Chrome/Chromium version: ${stdout.trim()}`);
                    else logger.warn('⚠️ Could not determine Chrome/Chromium version');
                });
            }).catch(() => logger.warn('⚠️ Could not determine Chrome/Chromium version'));
        } else {
            logger.warn('⚠️ Chrome/Chromium is unavailable; legacy CBE fallback will return a configuration error.');
        }

        const telebirrRelayCount = (process.env.FALLBACK_PROXIES || '')
            .split(',')
            .map(value => value.trim())
            .filter(Boolean)
            .length;
        logger.info(
            `Telebirr verification config: primary ${process.env.SKIP_PRIMARY_VERIFICATION === 'true' ? 'disabled' : 'enabled'}, fallback relays ${telebirrRelayCount}`
        );

        // Which provider hosts are fetched without certificate verification is a
        // security property of the running service, so it belongs in the boot log
        // rather than only in the source of four different adapters.
        logTlsPolicy();
        if (process.env.SKIP_PRIMARY_VERIFICATION === 'true' && telebirrRelayCount === 0) {
            logger.warn('⚠️ Telebirr primary is disabled but FALLBACK_PROXIES is empty.');
        }

        await prisma.$connect();
        await prisma.$queryRaw`SELECT 1`;
        logger.info('Connected to database successfully');

        // Mark the runtime ready as soon as the DB is reachable. The stats
        // cache aggregates the whole UsageLog table (COUNT + GROUP BYs), which
        // can take several seconds on a cold database. Running it in the
        // critical path forces every dashboard request (held by waitForRuntime)
        // to block behind those heavy queries on cold start. Kick it off in the
        // background instead — it self-heals on error and the admin usage-stats
        // endpoint re-queries the DB directly anyway.
        void initializeStatsCache();

        // Lapsed sessions and never-used password-reset tokens accumulate forever
        // otherwise, and sessions written before tokens were hashed still hold
        // plaintext credentials. Background, off the readiness path, same as the
        // stats cache above.
        startSessionMaintenance();

        // Webhook signing secrets are encrypted at rest when WEBHOOK_SECRET_KEY is
        // set. Say so either way, and re-encrypt any row that predates the key so
        // switching it on migrates the table without a script.
        logSecretVaultState();
        void migrateLegacyWebhookSecrets()
            .catch((error) => logger.error('Webhook secret migration failed:', error));

        // BullMQ queue workers require Redis. When REDIS_URL is unset (e.g. on
        // Render free tier without a Redis instance), skip the workers gracefully
        // instead of crashing the app. Verifications work fine without queues —
        // only webhook + notification delivery is affected.
        if (process.env.REDIS_URL) {
            await startWebhookQueueWorker();
            await startNotificationQueueWorker();
            logger.info('Webhook + notification queue workers started (Redis connected)');
        } else {
            logger.warn('REDIS_URL not set — skipping webhook + notification queue workers. Verifications will work; webhook delivery is disabled.');
        }

        startupState.initializing = false;
        startupState.ready = true;
        startupState.initializedAt = new Date().toISOString();
    } catch (error) {
        startupState.initializing = false;
        startupState.ready = false;
        startupState.lastError = error instanceof Error ? error.message : 'Unknown startup error';
        throw error;
    }
}

// Render terminates TLS in front of the app and Cloudflare usually sits in
// front of Render, so X-Forwarded-* is the only source of protocol information
// (req.protocol, req.secure, req.hostname). Trust a single hop rather than
// `true`: `true` makes Express treat every forwarded entry as trustworthy.
//
// Client *identity* does not come from req.ip at all. getRequestIp() resolves it
// from CF-Connecting-IP or the rightmost X-Forwarded-For entry — the one the
// nearest trusted proxy appended, which a caller cannot forge. See
// src/utils/requestIp.ts.
app.set('trust proxy', 1);

app.use(cors({
    origin: true, // Allow all origins — the dashboard runs on a different domain
    // Clients authenticate with an Authorization: Bearer token (or x-api-key),
    // never with cookies, so reflecting credentials to every origin is not
    // needed. Set CORS_CREDENTIALS=true only if you introduce cookie auth.
    credentials: (process.env.CORS_CREDENTIALS ?? 'false').toLowerCase() === 'true',
    maxAge: 600, // Cache successful preflight, never receipt responses.
    exposedHeaders: ['Server-Timing', 'X-Verify-Cache', 'Retry-After'],
}));
app.use(express.json());
// cookie-parser was mounted for a `req.cookies?.session` fallback in routes/auth.ts
// that nothing ever set — no code in the repository calls res.cookie(). Reading a
// session credential from a cookie means accepting one that a browser attaches
// automatically, which is the CSRF shape; the routes now take the token from the
// Authorization header only, so the parser is gone with them.

// Add request logging middleware
app.use(requestLogger);
// One integer increment per request; combined with the Prisma counters it
// yields "statements per request" on /status/summary without lab tooling.
app.use((_req, _res, next) => {
    recordHttpRequest();
    next();
});

// Refund the monthly verification credit when a charged request fails without
// ever reaching a provider (400/403/5xx). See utils/quotaCharge.ts.
app.use(quotaRefundHook);

const runtimeGuestPaths = ['/', '/health', '/ready', '/status'];

// How long a non-guest request waits for the runtime before being told to
// retry. Both Render (free tier) and TiDB Serverless scale to zero, so the
// first request after an idle period can wait on a database resume. Holding the
// connection for 90s exceeded Cloudflare's origin timeout and turned a slow
// start into an opaque 524; a short wait plus Retry-After lets the client
// retry instead. Raise it with STARTUP_WAIT_MS if your platform is slower.
const STARTUP_WAIT_MS = Math.max(0, Number(process.env.STARTUP_WAIT_MS ?? 15_000));
const STARTUP_RETRY_AFTER_SECONDS = Math.max(1, Math.ceil(STARTUP_WAIT_MS / 1000));

/**
 * Cold-start gate.
 *
 * Registration order is load-bearing: Express walks its middleware stack in the
 * order handlers were registered and a router that matches ends the chain. This
 * used to be registered *after* every router, so a request to /verify-cbe,
 * /products, /dashboard, /admin or any other mounted path was handled by its
 * router and never reached the gate — the cold-start protection was dead code
 * for exactly the routes it was written for, and a request arriving during a
 * TiDB scale-to-zero resume went straight into `prisma` and failed.
 *
 * It must therefore stay above every router and above apiKeyAuth (which itself
 * issues a database query), and below requestLogger so cold-start requests are
 * still logged.
 */
const waitForRuntime: RequestHandler = async (req, res, next) => {
    if (runtimeGuestPaths.some(p => req.path === p || req.path.startsWith(`${p}/`))) {
        return next();
    }
    if (startupState.ready) {
        return next();
    }
    const deadline = Date.now() + STARTUP_WAIT_MS;
    while (Date.now() < deadline) {
        if (startupState.ready) {
            return next();
        }
        if (!startupState.initializing && startupState.lastError) {
            return res.status(503).json({
                success: false,
                error: 'Service initialization failed',
                detail: startupState.lastError,
            });
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    res.set('Retry-After', String(STARTUP_RETRY_AFTER_SECONDS));
    return res.status(503).json({
        success: false,
        error: 'Service is starting up. Retry in a few seconds.',
        retryAfterSeconds: STARTUP_RETRY_AFTER_SECONDS,
    });
};
app.use(waitForRuntime);

// Register admin routes BEFORE API key authentication
app.use('/admin', adminRouter);

// Register dashboard-facing routes (session-authenticated)
// These must be BEFORE apiKeyAuth so they don't require an x-api-key header
app.use('/auth', authRouter);
app.use('/workspaces', workspacesRouter);
app.use('/dashboard', dashboardRouter);

// Signed status probes bypass customer auth, quotas, records, and delivery hooks.
app.use('/internal/status', internalStatusRouter);

// Public status summary (no auth — liveness + config flags only, no live probes).
app.use('/status', publicStatusRouter);

// Add API key authentication middleware (will not affect admin routes)
app.use(apiKeyAuth as express.RequestHandler);

// Single-receipt routers (including dashboard) own the shared pipeline.
// Batch and OCR retain their product-specific entitlement/credit gates.
app.use((req, res, next) => req.path === '/verify-image' ? verifyWebhookHook(req, res, next) : next());
app.use('/verify-image', rateLimiter);

// Error handling for JSON parsing - properly typed as an error handler
const jsonErrorHandler: ErrorRequestHandler = async (err, req, res, next): Promise<void> => {
    if (err instanceof SyntaxError && 'body' in err) {
        logger.error('JSON parsing error:', err);
        res.status(400).json({ success: false, error: 'Invalid JSON in request body' });
        return;
    }
    next(err);
};

app.use(jsonErrorHandler);

// ✅ Attach routers to paths
app.use('/verify-cbe', CBERouter);
app.use('/verify-telebirr', telebirrRouter);
app.use('/verify-dashen', dashenRouter);
app.use('/verify-abyssinia', abyssiniaRouter);
app.use('/verify-cbebirr', cbebirrRouter);
app.use('/verify-mpesa', mpesaRouter);
app.use('/verify-awash', awashRouter);
app.use('/verify-zemen', zemenRouter);
app.post('/verify-image', verifyImageGate, verifyImageHandler);
app.use('/verify-batch', batchRouter);
app.use('/verify', universalRouter);
app.use('/products', permissionGate('webhooks'), productsRouter);
app.use('/orders', permissionGate('webhooks'), ordersRouter);
app.use('/payouts', permissionGate('webhooks'), payoutsRouter);
app.use('/payment-links', permissionGate('webhooks'), paymentLinksRouter);
// Webhook/channel mutations must invalidate the "this workspace has no delivery
// targets" cache used by emitWorkspaceEvent.
const invalidateDeliveryCacheAfterMutation: RequestHandler = (req, res, next) => {
    if (req.method !== 'GET') {
        res.on('finish', () => {
            if (res.statusCode < 400) invalidateWorkspaceDeliveryCache(getWorkspaceId(req));
        });
    }
    next();
};
app.use('/webhooks', permissionGate('webhooks'), invalidateDeliveryCacheAfterMutation, webhooksRouter);
app.use('/notifications', permissionGate('webhooks'), invalidateDeliveryCacheAfterMutation, notificationsRouter);

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
    res.json({
        status: 'ok',
        uptimeSeconds: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
    });
});

// Concurrent readiness probes must not each occupy a database connection.
// No TTL: the next probe after completion always checks current DB health.
const checkReadinessDatabase = singleFlight(async () => { await prisma.$queryRaw`SELECT 1`; });

app.get('/ready', async (req: Request, res: Response) => {
    const timestamp = new Date().toISOString();

    const checks = {
        startup: {
            initializing: startupState.initializing,
            ready: startupState.ready,
            initializedAt: startupState.initializedAt,
            lastError: startupState.lastError,
        },
        database: {
            ready: false,
            error: null as string | null,
        },
        webhookQueue: {
            ready: false,
            data: null as Awaited<ReturnType<typeof getWebhookQueueHealth>> | null,
            error: null as string | null,
        },
        notificationQueue: {
            ready: false,
            data: null as Awaited<ReturnType<typeof getNotificationQueueHealth>> | null,
            error: null as string | null,
        },
    };

    try {
        await checkReadinessDatabase();
        checks.database.ready = true;
    } catch (error) {
        checks.database.error = error instanceof Error ? error.message : 'Database readiness check failed.';
    }

    // When REDIS_URL is unset (free-tier deploy without Redis), the queue
    // workers are intentionally not started. Treat this as "not applicable"
    // (ready=true) rather than "not ready", so /ready returns 200 and Render
    // doesn't think the service is unhealthy.
    const redisEnabled = !!process.env.REDIS_URL;

    if (redisEnabled) {
        try {
            const webhookQueue = await getWebhookQueueHealth();
            checks.webhookQueue.data = webhookQueue;
            checks.webhookQueue.ready = webhookQueue.configured && webhookQueue.workerRunning && webhookQueue.workerConnected;
        } catch (error) {
            checks.webhookQueue.error = error instanceof Error ? error.message : 'Webhook queue readiness check failed.';
        }

        try {
            const notificationQueue = await getNotificationQueueHealth();
            checks.notificationQueue.data = notificationQueue;
            checks.notificationQueue.ready = notificationQueue.configured && notificationQueue.workerRunning && notificationQueue.workerConnected;
        } catch (error) {
            checks.notificationQueue.error = error instanceof Error ? error.message : 'Notification queue readiness check failed.';
        }
    } else {
        // No Redis configured — queues are intentionally disabled. Mark as
        // ready=true so the overall /ready check passes.
        checks.webhookQueue.ready = true;
        checks.notificationQueue.ready = true;
        (checks.webhookQueue as any).data = { configured: false, note: 'REDIS_URL not set — queues disabled' };
        (checks.notificationQueue as any).data = { configured: false, note: 'REDIS_URL not set — queues disabled' };
    }

    const ready =
        checks.startup.ready
        && checks.database.ready
        && checks.webhookQueue.ready
        && checks.notificationQueue.ready;

    res.status(ready ? 200 : 503).json({
        ready,
        timestamp,
        checks,
    });
});

// Root endpoint
app.get('/', (req: Request, res: Response) => {
    res.json({
        name: 'Payment Verification API',
        version: '3.0.3',
        endpoints: [
            '/verify-cbe',
            '/verify-telebirr',
            '/verify-dashen',
            '/verify-abyssinia',
            '/verify-cbebirr',
            '/verify-mpesa',
            '/verify-awash',
            '/verify-zemen',
            '/verify',
            '/verify-image',
            '/products',
            '/orders',
            '/payment-links',
            '/notifications'
        ]
    });
});

// Global error handler
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    logger.error('Unhandled error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
});

// Graceful shutdown
const flushBufferedWrites = async () => {
    // Write-behind buffers hold usage logs + API key counters; drain them fully
    // before the database connection is closed so no analytics are lost on
    // redeploy. A single flush() call can return while rows are still queued.
    await Promise.all([
        drainUsageLogs().catch((error) => logger.error('Failed to flush usage logs:', error)),
        drainKeyUsageCounters().catch((error) => logger.error('Failed to flush key usage counters:', error)),
    ]);
};

/**
 * Stop every background worker and flush every buffered write, in one place.
 *
 * This sequence was written out twice — once for the "no HTTP server" path and
 * once inside the `server.close()` callback — and the two had already drifted in
 * what they awaited. Teardown that exists in two copies is teardown that gets one
 * of them wrong on the day it matters, which is the day the process is being
 * killed.
 */
const releaseResources = async (): Promise<void> => {
    stopKeepAlivePinger();
    // Stop scheduling sweeps before draining, so a sweep cannot start while the
    // one in flight is being awaited.
    stopSessionMaintenance();
    await drainSessionMaintenance();
    await closeCBEBrowser();
    await flushBufferedWrites();
    await stopWebhookQueueWorker();
    await stopNotificationQueueWorker();
    await disconnectPrisma();
};

const gracefulShutdown = async () => {
    logger.info('Shutting down server...');
    if (!server) {
        await releaseResources();
        process.exit(0);
        return;
    }

    // Stop accepting new connections first, then release resources. Closing
    // Chromium before the server used to eat into the 10s budget, and
    // server.close() waits on keep-alive sockets that have no idle timeout.
    server.close(async () => {
        logger.info('HTTP server closed');
        await releaseResources();
        process.exit(0);
    });
    (server as unknown as { closeIdleConnections?: () => void }).closeIdleConnections?.();

    // Force close after 10 seconds
    setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
    }, 10000).unref?.();
};

// Node treats an unhandled rejection as fatal and exits immediately, which skips
// the drain above and loses buffered usage rows. Log, then shut down cleanly.
process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection:', reason);
    void gracefulShutdown();
});
process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception:', error);
    void gracefulShutdown();
});

// Listen for termination signals
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

async function bootstrap(): Promise<void> {
    server = app.listen(PORT, () => {
        logger.info(`Server listening on port ${PORT} (runtime initializing in background)`);
    });

    await new Promise<void>((resolve) => server!.once('listening', resolve));

    try {
        await initializeRuntime();
        startKeepAlivePinger();
    } catch (error) {
        logger.error('Startup failed. Exiting.', error);
        // releaseResources() assumes a healthy runtime; on a failed boot some of
        // these may never have started, so each is guarded.
        stopKeepAlivePinger();
        stopSessionMaintenance();
        await drainSessionMaintenance();
        await closeCBEBrowser().catch(() => undefined);
        await flushBufferedWrites().catch(() => undefined);
        await stopWebhookQueueWorker().catch(() => undefined);
        await stopNotificationQueueWorker().catch(() => undefined);
        await disconnectPrisma().catch(() => undefined);
        process.exit(1);
    }
}

void bootstrap();
