import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';
import { prisma } from '../utils/prisma';
import { getWorkspaceContext } from '../utils/workspaceContext';
import { getRequestIp } from '../utils/requestIp';
import { createWriteBehind } from '../utils/writeBehind';

// ─── Usage-log write-behind ───────────────────────────────────────────────────
// One INSERT per request is 1 database round trip per request — ~150 ms against
// a cross-region database, on the same tiny connection pool the request path
// uses. Buffer them and insert with createMany instead.
const USAGE_LOG_FLUSH_MS = Number(process.env.USAGE_LOG_FLUSH_MS ?? 2_000);
const USAGE_LOG_MAX_BATCH = Number(process.env.USAGE_LOG_MAX_BATCH ?? 500);

export interface UsageLogEntry {
  apiKeyId: string;
  endpoint: string;
  method: string;
  statusCode: number;
  responseTime: number;
  ip: string;
}

const usageLogWriter = createWriteBehind<UsageLogEntry>({
  name: 'usage-log',
  intervalMs: USAGE_LOG_FLUSH_MS,
  maxBatchSize: USAGE_LOG_MAX_BATCH,
  flush: async (batch) => {
    await prisma.usageLog.createMany({ data: batch });
  },
});

/**
 * Queue usage-log rows through the same write-behind buffer the request logger
 * uses.
 *
 * `/verify-batch` used to write its rows with its own `void (async () =>
 * createMany(...))()`. That is fire-and-forget in the strictest sense: nothing
 * awaited it, so a graceful shutdown disconnected Prisma with the insert still in
 * flight and the rows were silently lost, and a failure was only visible as one
 * error line with no retry. Routing it through this buffer means batch rows are
 * flushed on the same interval and drained by the same shutdown path as every
 * other usage record.
 */
export function enqueueUsageLogs(entries: UsageLogEntry[]): void {
  for (const entry of entries) usageLogWriter.push(entry);
}

/** Persist buffered usage logs (called during graceful shutdown). */
export const flushUsageLogs = async (): Promise<void> => {
  await usageLogWriter.flush();
};

/**
 * Drain the buffer completely, for shutdown. A single flush() returns the
 * in-flight promise without writing whatever arrived during it, so the process
 * could disconnect Prisma and exit with rows still queued.
 */
export const drainUsageLogs = async (): Promise<void> => {
  await usageLogWriter.drain();
};

/** Observability for /status/summary. */
export const usageLogBufferSize = (): number => usageLogWriter.size();
export const usageLogStats = () => ({
  buffered: usageLogWriter.size(),
  flushedBatches: usageLogWriter.flushCount(),
  dropped: usageLogWriter.droppedCount(),
});

// In-memory cache for quick stats access.
//
// Both maps are hard-capped. They are written on every request from a middleware
// that runs before authentication, and their keys are attacker-controlled: the
// endpoint key embeds the request path and the IP key came from a header, so
// anonymous callers could otherwise grow these without bound until the 512 MB
// instance ran out of memory. The rate limiter's MemoryWindowCounter solved this
// for itself; these two were missed.
const STATS_MAX_KEYS = Number(process.env.STATS_MAX_KEYS ?? 5_000);

function setBounded<V>(map: Map<string, V>, key: string, value: V): void {
    // Re-insert so Map iteration order stays least-recently-used first.
    map.delete(key);
    map.set(key, value);
    if (map.size > STATS_MAX_KEYS) {
        const oldest = map.keys().next();
        if (!oldest.done) map.delete(oldest.value);
    }
}

/**
 * A path segment that is an identifier rather than a route component: a long
 * opaque token, a UUID, a run of digits. Collapsing these is what keeps the
 * endpoint label bounded when a request matched no route at all.
 */
const IDENTIFIER_SEGMENT = /^(?:\d+|[0-9a-fA-F][0-9a-fA-F-]{15,}|[A-Za-z0-9_-]{20,})$/;
const MAX_LABEL_SEGMENTS = 6;

/** `/pl/cm3x9f2k0001abc/pay` → `/pl/:id/pay`. */
function normaliseRawPath(originalUrl: string): string {
  const path = originalUrl.split('?')[0].split('#')[0];
  const segments = path.split('/').filter(Boolean);
  const kept = segments.slice(0, MAX_LABEL_SEGMENTS).map((seg) => (IDENTIFIER_SEGMENT.test(seg) ? ':id' : seg));
  return `/${kept.join('/')}${segments.length > MAX_LABEL_SEGMENTS ? '/…' : ''}` || '/';
}

/**
 * The label a request is counted and logged under.
 *
 * This used to be the raw path, `${method} ${originalUrl.split('?')[0]}`. Every
 * distinct receipt reference, payment-link id and crawler probe therefore became
 * its own endpoint — in the in-memory stats map (where it evicted the real routes
 * within minutes) and, worse, in the `UsageLog.endpoint` column, which made the
 * table's cardinality grow with traffic forever and turned the startup
 * `GROUP BY method, endpoint` into a full scan of every URL ever requested.
 *
 * Express has matched a route by the time `finish` fires, so the route pattern is
 * available and is the correct label. Requests that matched nothing are counted
 * under their collapsed path for stats (useful — it is how a crawl shows up) but
 * recorded as `(unrouted)` in the database, where unbounded cardinality is
 * expensive.
 */
export function endpointLabels(req: Request): { statsKey: string; logEndpoint: string } {
  const method = req.method;
  const route = (req as Request & { route?: { path?: string } }).route;
  if (route?.path) {
    const label = `${method} ${req.baseUrl || ''}${route.path}`;
    return { statsKey: label, logEndpoint: label };
  }
  const collapsed = normaliseRawPath(req.originalUrl);
  return { statsKey: `${method} ${collapsed}`, logEndpoint: `${method} (unrouted)` };
}

const statsCache = {
  totalRequests: 0,
  endpointStats: new Map<string, {
    count: number,
    successCount: number,
    failureCount: number,
    avgResponseTime: number
  }>(),
  ipStats: new Map<string, number>()
};

/** Sizes of the in-memory stats maps, for /status and for leak assertions. */
export const statsCacheState = () => ({
  totalRequests: statsCache.totalRequests,
  endpointKeys: statsCache.endpointStats.size,
  ipKeys: statsCache.ipStats.size,
  maxKeys: STATS_MAX_KEYS,
});

// Initialize cache from database on startup
export const initializeStatsCache = async () => {
  try {
    // Get total requests
    statsCache.totalRequests = await prisma.usageLog.count();

    // Both of these aggregate the whole UsageLog table and every group they
    // return is loaded into memory. Without a LIMIT the row count is the number
    // of distinct endpoints/IPs the service has ever seen, which grows without
    // bound — on a 512 MB instance a busy table made this the thing that OOM'd
    // the process during boot, before it could serve a single request. The
    // busiest groups are the only ones worth preloading; the rest are counted
    // from the first request that touches them.
    // Clamped, and an integer by construction: this value goes into a LIMIT
    // clause, and a mistyped STATS_MAX_KEYS must not turn into "load the table".
    const limit = Number.isInteger(STATS_MAX_KEYS) && STATS_MAX_KEYS > 0
      ? Math.min(STATS_MAX_KEYS, 10_000)
      : 5_000;

    const endpointStats = await prisma.$queryRaw`
      SELECT
        CONCAT(method, ' ', endpoint) as endpoint,
        COUNT(*) as count,
        SUM(CASE WHEN statusCode < 400 THEN 1 ELSE 0 END) as successCount,
        SUM(CASE WHEN statusCode >= 400 THEN 1 ELSE 0 END) as failureCount,
        AVG(responseTime) as avgResponseTime
      FROM UsageLog
      GROUP BY method, endpoint
      ORDER BY count DESC
      LIMIT ${limit}
    `;

    if (Array.isArray(endpointStats)) {
      endpointStats.forEach((stat: any) => {
        setBounded(statsCache.endpointStats, String(stat.endpoint), {
          count: Number(stat.count),
          successCount: Number(stat.successCount),
          failureCount: Number(stat.failureCount),
          avgResponseTime: Number(stat.avgResponseTime)
        });
      });
    }

    const ipStats = await prisma.$queryRaw`
      SELECT ip, COUNT(*) as count
      FROM UsageLog
      GROUP BY ip
      ORDER BY count DESC
      LIMIT ${limit}
    `;

    if (Array.isArray(ipStats)) {
      ipStats.forEach((stat: any) => {
        setBounded(statsCache.ipStats, String(stat.ip), Number(stat.count));
      });
    }

    logger.info('Stats cache initialized from database', {
      endpointKeys: statsCache.endpointStats.size,
      ipKeys: statsCache.ipStats.size,
      limit,
    });
  } catch (error) {
    logger.error('Error initializing stats cache:', error);
  }
};

export const requestLogger = (req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  const requestId = Math.random().toString(36).substring(2, 15);
  const requestIp = getRequestIp(req);

  // Log request details.
  // Never log the raw body or query: this middleware runs before /auth and
  // apiKeyAuth, so a login body carried a plaintext password and a query string
  // could carry ?adminKey= or ?apiKey=. Bodies are opt-in via
  // LOG_REQUEST_BODIES for local debugging only.
  const logBodies = (process.env.LOG_REQUEST_BODIES ?? 'false').toLowerCase() === 'true';
  const url = req.originalUrl.split('?')[0];
  logger.info(`[${requestId}] Incoming ${req.method} request to ${url}`, {
    method: req.method,
    url,
    ip: requestIp,
    userAgent: req.get('user-agent'),
    body: logBodies && req.method === 'POST' ? JSON.stringify(req.body) : undefined,
    query: logBodies && Object.keys(req.query).length ? req.query : undefined,
    apiKeyWorkspaceId: (req as any).apiKeyData ? ((req as any).apiKeyData.workspaceId ?? (req as any).apiKeyData.workspace?.id ?? 'unknown') : 'none'
  });

  // Update in-memory cache for quick access
  statsCache.totalRequests++;

  // Track by IP address
  const ipCount = statsCache.ipStats.get(requestIp) || 0;
  setBounded(statsCache.ipStats, requestIp, ipCount + 1);

  // Use the 'finish' event to capture response completion
  res.on('finish', async () => {
    const responseTime = Date.now() - start;
    // Counted here rather than before routing because the route pattern — the
    // only bounded label available — does not exist until Express has matched.
    const { statsKey, logEndpoint } = endpointLabels(req);
    const endpointStat = statsCache.endpointStats.get(statsKey) ?? {
      count: 0, successCount: 0, failureCount: 0, avgResponseTime: 0,
    };
    endpointStat.count++;
    if (res.statusCode < 400) {
      endpointStat.successCount++;
    } else {
      endpointStat.failureCount++;
    }
    endpointStat.avgResponseTime =
      (endpointStat.avgResponseTime * (endpointStat.count - 1) + responseTime) / endpointStat.count;
    setBounded(statsCache.endpointStats, statsKey, endpointStat);

    // Get auth context for logging
    const context = getWorkspaceContext(req);
    const source = context?.source ?? ((req as any).publicVerify ? 'public' : 'unknown');
    const workspaceId = context?.workspace.id || 'none';
    
    // Only the stored, non-secret prefix identifies a key in a log line. Keys
    // created before prefixes existed fall back to a substring of the secret —
    // eight characters of a credential in an append-only log is enough to cut the
    // brute-force space substantially, and logs outlive the key rotation that was
    // supposed to retire it.
    const keyDetails = (req as any).apiKeyData;
    const safeKeyLog = keyDetails ? (keyDetails.prefix || 'legacy-key-no-prefix') : 'none';

    logger.info(`[${requestId}] Response sent in ${responseTime}ms with status ${res.statusCode}`, {
      statusCode: res.statusCode,
      responseTime,
      contentLength: res.get('Content-Length') || 'unknown',
      apiKey: safeKeyLog,
      source,
      workspaceId
    });

    if (res.statusCode >= 400) {
      logger.warn(`[${requestId}] Error occurred with status ${res.statusCode}`);
    }

    // Store usage log for API key auth only (not dashboard auth) — dashboard
    // requests are internal management calls, not billable API consumption.
    // Buffered and flushed in batches; see usageLogWriter above.
    if (context?.source === 'api_key' && (req as any).apiKeyData) {
      usageLogWriter.push({
        apiKeyId: (req as any).apiKeyData.id,
        endpoint: logEndpoint,
        method: req.method,
        statusCode: res.statusCode,
        responseTime,
        ip: requestIp,
      });
    }
  });

  next();
};

// Get usage statistics with cache fallback
/**
 * How many groups an admin stats call may return.
 *
 * Both queries below used to be unbounded: one `GROUP BY` over every distinct
 * endpoint and every distinct IP the service had ever logged, serialised whole
 * into the JSON response. With the endpoint column historically storing raw
 * request paths, that was a multi-megabyte response and a full-table aggregation
 * on every call to /admin/usage-summary — and it handed the admin-key holder a
 * complete census of client IP addresses, which is personal data nobody needed
 * in bulk. An operator wants the busiest groups, so that is what is returned.
 */
const STATS_RESPONSE_LIMIT = Math.min(
  Number.isInteger(Number(process.env.STATS_RESPONSE_LIMIT)) && Number(process.env.STATS_RESPONSE_LIMIT) > 0
    ? Number(process.env.STATS_RESPONSE_LIMIT)
    : 200,
  1_000,
);

export const getUsageStats = async () => {
  try {
    // Try to get fresh data from database
    const totalLogs = await prisma.usageLog.count();

    const endpointStats = await prisma.$queryRaw`
      SELECT
        CONCAT(method, ' ', endpoint) as endpoint,
        COUNT(*) as count,
        SUM(CASE WHEN statusCode < 400 THEN 1 ELSE 0 END) as successCount,
        SUM(CASE WHEN statusCode >= 400 THEN 1 ELSE 0 END) as failureCount,
        AVG(responseTime) as avgResponseTime
      FROM UsageLog
      GROUP BY method, endpoint
      ORDER BY count DESC
      LIMIT ${STATS_RESPONSE_LIMIT}
    `;

    const ipStats = await prisma.$queryRaw`
      SELECT ip, COUNT(*) as count
      FROM UsageLog
      GROUP BY ip
      ORDER BY count DESC
      LIMIT ${STATS_RESPONSE_LIMIT}
    `;

    // Convert raw results to proper format
    const formattedEndpointStats: Record<string, any> = {};
    if (Array.isArray(endpointStats)) {
      endpointStats.forEach((stat: any) => {
        formattedEndpointStats[stat.endpoint] = {
          count: Number(stat.count),
          successCount: Number(stat.successCount),
          failureCount: Number(stat.failureCount),
          avgResponseTime: Number(stat.avgResponseTime)
        };
      });
    }

    const formattedIpStats: Record<string, number> = {};
    if (Array.isArray(ipStats)) {
      ipStats.forEach((stat: any) => {
        formattedIpStats[stat.ip] = Number(stat.count);
      });
    }

    return {
      totalRequests: totalLogs,
      endpointStats: formattedEndpointStats,
      ipStats: formattedIpStats,
      // Say out loud that these are the top groups, so nobody reads a truncated
      // list as a complete one.
      truncated: {
        endpoints: Object.keys(formattedEndpointStats).length >= STATS_RESPONSE_LIMIT,
        ips: Object.keys(formattedIpStats).length >= STATS_RESPONSE_LIMIT,
        limit: STATS_RESPONSE_LIMIT,
      },
    };
  } catch (error) {
    logger.error('Error fetching usage stats from database:', error);

    // Fallback to in-memory cache if database query fails
    logger.info('Falling back to in-memory cache for stats');

    // Convert Maps to objects for JSON serialization
    const endpointStatsObj: Record<string, any> = {};
    statsCache.endpointStats.forEach((value, key) => {
      endpointStatsObj[key] = value;
    });

    const ipStatsObj: Record<string, number> = {};
    statsCache.ipStats.forEach((value, key) => {
      ipStatsObj[key] = value;
    });

    return {
      totalRequests: statsCache.totalRequests,
      endpointStats: endpointStatsObj,
      ipStats: ipStatsObj
    };
  }
};
