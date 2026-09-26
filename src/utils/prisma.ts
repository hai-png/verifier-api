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
export const prisma = global.prisma || new PrismaClient({
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