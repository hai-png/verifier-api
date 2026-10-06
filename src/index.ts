import express, { Request, Response, NextFunction, ErrorRequestHandler, RequestHandler } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';

// Load environment variables from .env file
dotenv.config();

import CBERouter from './routes/verifyCBERoute';
import { closeCBEBrowser, getChromeExecutablePath } from './services/verifyCBE';
import { resolvePublicApiUrl } from './config/publicApiUrl';
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
// Only RENDER_EXTERNAL_URL identifies this API, and resolvePublicApiUrl() is the
// single place that decides so. A missing URL is strictly better than the wrong
// one: the pinger disables itself below rather than reporting a keep-alive that
// never reaches Render.
const keepAliveUrl = resolvePublicApiUrl();
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
        logger.warn('Keep-alive pinger disabled — set RENDER_EXTERNAL_URL to this API’s public URL to enable it.');
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
                // Name the URL. "returned 404" on its own did not say which host
                // was wrong, and the wrong host was the entire bug.
                logger.warn(
                    `Keep-alive ping to ${keepAliveUrl}/ready returned ${res.status} — ` +
                    'set KEEP_ALIVE_URL to this API\u2019s public URL',
                );
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
 * Required configuration, reported together.
 *
 * The secrets default to empty and every comparison fails closed, so a missing
 * value disables those surfaces rather than falling back to a guessable constant.
 * In production the process refuses to start, which is the right call — but it
 * used to report only the secrets, while the real cause sat eleven seconds
 * earlier in the log as a demoted `WARNING: prisma db push failed`.
 *
 * That is backwards in a way that costs a deploy cycle. With DATABASE_URL and
 * both secrets unset — the signature of a service created from render.yaml and
 * never configured — the boot printed:
 *
 *   WARNING: prisma db push failed - starting the API anyway
 *   ERROR:   Refusing to start: ADMIN_SECRET, DASHBOARD_SECRET must be set ...
 *
 * so the operator fixed the secrets, redeployed, and only then met DATABASE_URL.
 * One boot now names every absent variable at once.
 */
const REQUIRED_SHARED_SECRETS = ['ADMIN_SECRET', 'DASHBOARD_SECRET'] as const;
const MIN_SHARED_SECRET_LENGTH = 16;
const REQUIRED_DATABASE_URL = 'DATABASE_URL';

/** Absent or too-short secrets. Fatal in production, a warning elsewhere. */
function missingSharedSecrets(): string[] {
    return REQUIRED_SHARED_SECRETS.filter((key) => {
        const value = process.env[key];
        return !value || value.length < MIN_SHARED_SECRET_LENGTH;
    });
}

function assertSharedSecretsConfigured(): void {
    const missing = missingSharedSecrets();
    if (missing.length === 0) return;

    // Named alongside the secrets even though DATABASE_URL is not itself fatal
    // here, because otherwise the message points at the symptom.
    const alsoMissing = !process.env[REQUIRED_DATABASE_URL]?.trim()
        ? ` ${REQUIRED_DATABASE_URL} is not set either — without it nothing can connect to the database.`
        : '';

    const detail = `${missing.join(', ')} must be set to a random value of at least ${MIN_SHARED_SECRET_LENGTH} characters (openssl rand -hex 32). Until then /admin/* and the dashboard-secret API reject every request.${alsoMissing}`;
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

        // Loud, early, and deliberately NOT fatal.
        //
        // ci.yml boots the image with no DATABASE_URL on purpose and asserts the
        // container stays up and `/ready` reports non-200 — "the container must
        // stay up rather than crash-loop on a missing DB". Making this throw
        // would break that, and a crash-loop is worse than a degraded service
        // anyway: `/health` would stop answering and Render would restart a
        // process that could at least have explained itself.
        //
        // What was missing is the signal. A missing DATABASE_URL previously only
        // surfaced as the Dockerfile's demoted `WARNING: prisma db push failed`,
        // eleven seconds before an unrelated-looking error about secrets.
        if (!process.env[REQUIRED_DATABASE_URL]?.trim()) {
            logger.error(
                `⚠️  ${REQUIRED_DATABASE_URL} is not set. Nothing can reach the database: ` +
                '/health will answer, /ready will report 503, and every verification and dashboard ' +
                'route will fail. Set it in Render → Environment.',
            );
        }

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
        if (process.env.SKIP_PRIMARY_VERIFICATION === 'true' && telebirrRelayCount === 0) {
            logger.warn('⚠️ Telebirr primary is disabled but FALLBACK_PROXIES is empty.');
        }
        if (telebirrRelayCount === 1) {
            // One relay leaves TELEBIRR_HEDGE_DELAY_MS, TELEBIRR_MAX_PARALLEL_PROXIES,
            // TELEBIRR_TOTAL_TIMEOUT_MS and the circuit breaker with nothing to act
            // on, so a single slow relay surfaces as a bare timeout with no
            // fallback. Say so at boot rather than leaving it to be discovered
            // during an incident.
            logger.warn('⚠️ Telebirr has only one relay configured; hedging and failover are inert. Add a second relay URL to FALLBACK_PROXIES.');
        }

        // A database that is unreachable or unconfigured must NOT end the boot.
        //
        // The Dockerfile says so explicitly — `prisma db push` failure is
        // non-fatal "deliberately: making it fatal turns a transient [failure into]
        // a crash-loop" — and it names healthCheckPath: /ready as the mechanism,
        // so a degraded instance reports 503 rather than disappearing. Then this
        // function made the connection fatal anyway, which is why the CI step
        // "The API boots and reports readiness" could never pass: it boots the
        // image with the secrets set and no DATABASE_URL on purpose, asserts the
        // container stays up, that /health answers 200 and that /ready is non-200
        // — and the container exited on `prisma.$connect()` before any of them.
        //
        // So: catch it, leave `ready` false, and let the existing readiness
        // plumbing do its job. `/health` answers, `/ready` runs its own
        // `SELECT 1` and reports 503, `waitForRuntime` holds non-guest requests
        // for STARTUP_WAIT_MS and then answers 503 with the detail, and Render
        // restarts on the health check rather than on a crash loop that explains
        // nothing. Every route that touches the database still fails — it just
        // fails as a 503 with a reason rather than as a dead process.
        let databaseReady = false;
        try {
            await prisma.$connect();
            await prisma.$queryRaw`SELECT 1`;
            logger.info('Connected to database successfully');
            databaseReady = true;
        } catch (error) {
            logger.error(
                `Database is not reachable: ${error instanceof Error ? error.message : String(error)}. ` +
                'Serving /health but reporting 503 from /ready until it recovers.',
            );
        }

        // Mark the runtime ready as soon as the DB is reachable. The stats
        // cache aggregates the whole UsageLog table (COUNT + GROUP BYs), which
        // can take several seconds on a cold database. Running it in the
        // critical path forces every dashboard request (held by waitForRuntime)
        // to block behind those heavy queries on cold start. Kick it off in the
        // background instead — it self-heals on error and the admin usage-stats
        // endpoint re-queries the DB directly anyway.
        void initializeStatsCache();

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
        // Only claim readiness when the database answered. Everything else about
        // the boot can succeed without it, and `/ready` independently re-probes,
        // so a false `ready` here is what makes waitForRuntime answer 503 with a
        // reason instead of letting traffic through to failing queries.
        startupState.ready = databaseReady;
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

// ─── CORS ─────────────────────────────────────────────────────────────────────
//
// `origin: true` reflected *any* Origin, which is only safe while every
// authenticated route takes a bearer token and nothing reads a cookie. That is
// now true by construction (auth.ts accepts Authorization only), but the
// combination was one `CORS_CREDENTIALS=true` away from full cross-origin
// account takeover on every dashboard route, and `origin: true` was what made
// that setting dangerous in the first place.
//
// So: an explicit allow-list. Set CORS_ALLOWED_ORIGINS to a comma-separated list
// (the dashboard's own origin(s)). Unset means same-origin only — the API and the
// dashboard on one host — which is the correct default for a self-hosted deploy
// and fails closed everywhere else.
//
// CORS_CREDENTIALS is refused outright. With an allow-list it is not needed: the
// dashboard authenticates with a bearer token, which a cross-origin request cannot
// read out of localStorage. If you have a genuine cookie-authenticated client,
// that is a design change, not an environment variable.
// Trailing slashes stripped. `VERITAS_APP_URL` in the environment is
// `https://dashboard.noveld.com.et/` and pasting that value straight into
// CORS_ALLOWED_ORIGINS — the obvious thing to do, since it is the dashboard's
// own configured URL — would produce the entry
// `https://dashboard.noveld.com.et/`, which never equals the `Origin` header
// `https://dashboard.noveld.com.et`. The symptom is a browser console CORS
// error with a 200 in the network tab, which reads as "the server is ignoring
// my header" rather than as a string-comparison mistake. Scheme and host are
// also lowercased, since an origin comparison is case-insensitive on the host
// and the scheme is normalised to lowercase by the browser.
const CORS_ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim().replace(/\/+$/, '').toLowerCase())
  .filter(Boolean);

const corsCredentialsRequested = (process.env.CORS_CREDENTIALS ?? 'false').toLowerCase() === 'true';
if (corsCredentialsRequested) {
  logger.warn(
    '⚠️ CORS_CREDENTIALS=true is ignored and should be removed from the environment. ' +
    'The dashboard authenticates with a bearer token; credentialed CORS on this API ' +
    'would expose every dashboard route to any origin.',
  );
}

app.use(cors({
    // Reflect the request origin when it is on the allow-list, otherwise send
    // nothing. `origin: []` is the cors package's way of omitting the header.
    origin: CORS_ALLOWED_ORIGINS.length === 0
        ? false
        : (origin: string | undefined, callback: (err: Error | null, origin?: boolean | string) => void) =>
            callback(
                null,
                origin && CORS_ALLOWED_ORIGINS.includes(origin.trim().replace(/\/+$/, '').toLowerCase())
                    ? origin
                    : false,
            ),
    credentials: false,
    maxAge: 600, // Cache successful preflight, never receipt responses.
    exposedHeaders: ['Server-Timing', 'X-Verify-Cache', 'Retry-After'],
    // Rate-limit and quota responses carry Retry-After; without this a browser
    // cannot read it, so an integration cannot back off correctly.
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Dashboard-Key',
        'X-Workspace-Id', 'X-Admin-Key', 'X-API-Key-Id', 'X-Veritas-Internal-Operation',
        'X-Status-Secret'],
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS', 'HEAD'],
}));
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT ?? '256kb' }));
app.use(cookieParser());

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


const runtimeGuestPaths = ['/', '/health', '/ready', '/status'];

// How long a non-guest request waits for the runtime before being told to
// retry. Both Render (free tier) and TiDB Serverless scale to zero, so the
// first request after an idle period can wait on a database resume. Holding the
// connection for 90s exceeded Cloudflare's origin timeout and turned a slow
// start into an opaque 524; a short wait plus Retry-After lets the client
// retry instead. Raise it with STARTUP_WAIT_MS if your platform is slower.
const STARTUP_WAIT_MS = Math.max(0, Number(process.env.STARTUP_WAIT_MS ?? 15_000));
const STARTUP_RETRY_AFTER_SECONDS = Math.max(1, Math.ceil(STARTUP_WAIT_MS / 1000));
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

const gracefulShutdown = async () => {
    logger.info('Shutting down server...');
    stopKeepAlivePinger();
    if (!server) {
        await closeCBEBrowser();
        await flushBufferedWrites();
        await stopWebhookQueueWorker();
        await stopNotificationQueueWorker();
        await disconnectPrisma();
        process.exit(0);
        return;
    }

    // Stop accepting new connections first, then release resources. Closing
    // Chromium before the server used to eat into the 10s budget, and
    // server.close() waits on keep-alive sockets that have no idle timeout.
    server.close(async () => {
        logger.info('HTTP server closed');
        await closeCBEBrowser();
        await flushBufferedWrites();
        await stopWebhookQueueWorker();
        await stopNotificationQueueWorker();
        await disconnectPrisma();
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
        stopKeepAlivePinger();
        await stopWebhookQueueWorker().catch(() => undefined);
        await stopNotificationQueueWorker().catch(() => undefined);
        await disconnectPrisma().catch(() => undefined);
        process.exit(1);
    }
}

void bootstrap();
