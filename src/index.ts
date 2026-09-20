import express, { Request, Response, NextFunction, ErrorRequestHandler, RequestHandler } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';

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
import { requestLogger, initializeStatsCache } from './middleware/requestLogger';
import { apiKeyAuth } from './middleware/apiKeyAuth';
import { rateLimiter } from './middleware/rateLimiter';
import { verifyImageGate, permissionGate, verifyQuotaGate } from './middleware/tierGate';
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

// Keep-alive pinger. Render's free tier spins an instance down after ~15 min
// of no inbound traffic, so the first request pays a ~30s cold start. Hitting
// our own public /health every 5 min counts as inbound traffic and keeps the
// instance warm, making /health — and therefore the dashboard — fast.
const KEEP_ALIVE_INTERVAL_MS = 5 * 60 * 1000;
const KEEP_ALIVE_TIMEOUT_MS = 15 * 1000;
const keepAliveUrl =
    process.env.RENDER_EXTERNAL_URL || process.env.VERITAS_APP_URL || '';
let keepAliveTimer: NodeJS.Timeout | null = null;

function startKeepAlivePinger(): void {
    if (!keepAliveUrl) {
        logger.warn('Keep-alive pinger disabled — set RENDER_EXTERNAL_URL or VERITAS_APP_URL to enable it.');
        return;
    }
    const ping = async (): Promise<void> => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), KEEP_ALIVE_TIMEOUT_MS);
        try {
            const startedAt = Date.now();
            const res = await fetch(`${keepAliveUrl}/health`, { signal: controller.signal });
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

async function initializeRuntime(): Promise<void> {
    startupState.initializing = true;
    startupState.ready = false;
    startupState.lastError = null;

    try {
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

        await prisma.$connect();
        await prisma.$queryRaw`SELECT 1`;
        logger.info('Connected to database successfully');

        await initializeStatsCache();

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

app.use(cors({
    origin: true, // Allow all origins — the dashboard runs on a different domain
    credentials: true, // Allow cookies for session auth
}));
app.use(express.json());
app.use(cookieParser());

// Add request logging middleware
app.use(requestLogger);

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

// Capture verify-endpoint responses so we can fire registered webhooks
// after the response is sent. No-op on non-verify paths.
app.use(verifyWebhookHook);

// Rate limiting on all verify routes (applied after auth so apiKeyData is available)
app.use('/verify-batch', rateLimiter);
app.use('/verify', rateLimiter);
app.use('/verify-cbe', rateLimiter);
app.use('/verify-telebirr', rateLimiter);
app.use('/verify-dashen', rateLimiter);
app.use('/verify-abyssinia', rateLimiter);
app.use('/verify-cbebirr', rateLimiter);
app.use('/verify-mpesa', rateLimiter);
app.use('/verify-awash', rateLimiter);
app.use('/verify-zemen', rateLimiter);
app.use('/verify-image', rateLimiter);

// Monthly verification quotas (separate from per-minute rate limits)
// Validate batch entitlement/permissions before any quota is deducted.
app.use('/verify-batch', permissionGate('verify-batch'));
app.use('/verify-batch', verifyQuotaGate);
app.use('/verify', verifyQuotaGate);
app.use('/verify-cbe', verifyQuotaGate);
app.use('/verify-telebirr', verifyQuotaGate);
app.use('/verify-dashen', verifyQuotaGate);
app.use('/verify-abyssinia', verifyQuotaGate);
app.use('/verify-cbebirr', verifyQuotaGate);
app.use('/verify-mpesa', verifyQuotaGate);
app.use('/verify-awash', verifyQuotaGate);
app.use('/verify-zemen', verifyQuotaGate);

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
app.use('/webhooks', permissionGate('webhooks'), webhooksRouter);
app.use('/notifications', permissionGate('webhooks'), notificationsRouter);


// Gate: keep endpoints that don't need the DB reachable instantly even while
// the runtime is still starting (cold boot), and make DB-dependent routes wait
// (bounded) for init to finish instead of failing. Placed once, before routers.
const runtimeGuestPaths = ['/', '/health', '/ready', '/status'];
const waitForRuntime: RequestHandler = async (req, res, next) => {
    if (runtimeGuestPaths.some(p => req.path === p || req.path.startsWith(`${p}/`))) {
        return next();
    }
    if (startupState.ready) {
        return next();
    }
    const deadline = Date.now() + 90_000;
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
    return res.status(503).json({ success: false, error: 'Service still initializing' });
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
        await prisma.$queryRaw`SELECT 1`;
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
const gracefulShutdown = async () => {
    logger.info('Shutting down server...');
    stopKeepAlivePinger();
    await closeCBEBrowser();
    if (!server) {
        await stopWebhookQueueWorker();
        await stopNotificationQueueWorker();
        await disconnectPrisma();
        process.exit(0);
        return;
    }

    server.close(async () => {
        logger.info('HTTP server closed');
        await stopWebhookQueueWorker();
        await stopNotificationQueueWorker();
        await disconnectPrisma();
        process.exit(0);
    });

    // Force close after 10 seconds
    setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
    }, 10000);
};

// Listen for termination signals
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

async function bootstrap(): Promise<void> {
    // Listen immediately so /health (and other no-DB endpoints) respond the
    // moment the container is up, even while startup work (DB connect, stats
    // cache) is still running in the background. The waitForRuntime middleware
    // makes DB-dependent routes wait for init instead of failing.
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
