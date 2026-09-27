import { PrismaClient } from '@prisma/client';
import logger from './logger';
import { recordDbStatement } from './dbMetrics';

// Declare global variable for PrismaClient
declare global {
    var prisma: PrismaClient | undefined;
}

// Create a singleton Prisma client that can be shared across files
// `emit: 'event'` costs nothing when nobody listens (no log file, no stdout):
// it feeds the rolling counters behind /status/summary diagnostics, which are
// how a deployed instance reports its own statements-per-request.
// Pool sizing. Against a cross-region database (~155 ms RTT) one connection
// serves only ~6 queries/s, so the commonly documented `connection_limit=5`
// caps DB-backed traffic near 32 queries/s — the live ramp (run 36288386311)
// queued readiness/auth queries at 10–25 workers while DB-free paths stayed
// flat. DB_CONNECTION_LIMIT overrides the URL; otherwise a URL without an
// explicit limit gets DEFAULT_CONNECTION_LIMIT instead of Prisma's CPU-derived
// default (which is 3–5 on a shared instance).
const DEFAULT_CONNECTION_LIMIT = 10;
export function resolveDatasourceUrl(url: string | undefined, override = process.env.DB_CONNECTION_LIMIT): string | undefined {
    if (!url) return url;
    try {
        const parsed = new URL(url);
        const forced = Number(override);
        if (override && Number.isInteger(forced) && forced > 0) {
            parsed.searchParams.set('connection_limit', String(forced));
        } else if (!parsed.searchParams.has('connection_limit')) {
            parsed.searchParams.set('connection_limit', String(DEFAULT_CONNECTION_LIMIT));
        } else {
            return url;
        }
        return parsed.toString();
    } catch {
        return url; // never block startup on an unparsable URL
    }
}

export function connectionLimitOf(url: string | undefined): number {
    try {
        const value = Number(new URL(url ?? '').searchParams.get('connection_limit'));
        return Number.isInteger(value) && value > 0 ? value : DEFAULT_CONNECTION_LIMIT;
    } catch {
        return DEFAULT_CONNECTION_LIMIT;
    }
}

export const datasourceUrl = resolveDatasourceUrl(process.env.DATABASE_URL);

export const prisma = global.prisma || new PrismaClient({
    ...(datasourceUrl ? { datasourceUrl } : {}),
    log:
        process.env.NODE_ENV === 'development'
            ? [{ level: 'query', emit: 'event' }, { level: 'error', emit: 'stdout' }, { level: 'warn', emit: 'stdout' }]
            : [{ level: 'query', emit: 'event' }, { level: 'error', emit: 'stdout' }],
});

// Prevent multiple instances during hot reloading in development
if (process.env.NODE_ENV !== 'production') global.prisma = prisma;

// Handle Prisma connection events
// Handle Prisma connection events with proper type assertions
(prisma as any).$on('query', (e: { query: string; duration: number }) => {
    // Always counted (cheap, bounded) so /status/summary can report the real
    // per-request database cost; only *logged* in development.
    recordDbStatement(e.query, e.duration);
    if (process.env.NODE_ENV === 'development') {
        logger.debug(`Query: ${e.query}`);
        logger.debug(`Duration: ${e.duration}ms`);
    }
});

(prisma as any).$on('error', (e: Error) => {
    logger.error('Prisma error:', e);
});

// Graceful shutdown function to close Prisma connections
export const disconnectPrisma = async () => {
    await prisma.$disconnect();
    logger.info('Disconnected from database');
};

/**
 * Open the whole pool up front. Prisma connects lazily, so the first burst
 * after boot (or after a concurrency step) paid a fresh TLS handshake to the
 * database per new connection — the 1.8–3.1 s p95 spikes at every stage
 * transition in the live ramp. Best effort; never throws.
 */
export const warmConnectionPool = async (): Promise<number> => {
    const size = connectionLimitOf(datasourceUrl);
    const results = await Promise.allSettled(
        Array.from({ length: size }, () => prisma.$queryRaw`SELECT 1`)
    );
    return results.filter((r) => r.status === 'fulfilled').length;
};
