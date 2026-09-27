/**
 * sessionMaintenance.ts
 *
 * Expired credential rows were never deleted.
 *
 * `authenticateSession` and `requireSession` both reject a session whose
 * `expires` is in the past, so an expired row is not a *security* hole — but
 * nothing ever removed one either. Every login, and every signup, inserts a row
 * that lives forever once it lapses: the Session table grows monotonically with
 * traffic, every `findUnique` on it gets slower, and the table becomes an
 * archive of which users were active and when. `VerificationToken` had the same
 * problem — a password-reset token that is never clicked is only deleted if its
 * owner happens to submit it after expiry.
 *
 * Sessions now also store a SHA-256 of the bearer token instead of the token
 * itself (see `hashSessionToken` in routes/auth.ts). Rows written before that
 * change still hold plaintext credentials and can no longer be matched, so this
 * sweep is also what removes them from disk.
 *
 * The sweep is periodic rather than on-read: doing it per request would put a
 * DELETE on the hot path, and doing it only at startup would never run at all on
 * an instance that stays up for weeks.
 */

import { prisma } from './prisma';
import logger from './logger';

const SWEEP_INTERVAL_MS = (() => {
    const configured = Number(process.env.SESSION_SWEEP_INTERVAL_MS);
    return Number.isFinite(configured) && configured > 0
        ? Math.max(configured, 60_000)
        : 6 * 60 * 60 * 1000;
})();

/** Bounded so one unlucky backlog cannot lock the table for minutes. */
const MAX_ROWS_PER_SWEEP = Number(process.env.SESSION_SWEEP_BATCH ?? 5_000);

let timer: NodeJS.Timeout | null = null;
let inflight: Promise<SweepReport> | null = null;
const state = { sweeps: 0, expiredSessions: 0, expiredTokens: 0, legacySessions: 0, failures: 0, lastRunAt: null as string | null };

export interface SweepReport {
    expiredSessions: number;
    expiredTokens: number;
    legacySessions: number;
    durationMs: number;
}

/**
 * Delete sessions persisted before tokens were hashed.
 *
 * Their plaintext values can no longer be matched by `authenticateSession` —
 * routes/auth.ts now looks rows up by SHA-256 — so they are already inert. But
 * they are plaintext bearer credentials sitting in the database, and deciding
 * that should not be stored raw only pays off once the raw copies are gone.
 */
export async function purgeLegacyPlaintextSessions(): Promise<number> {
    try {
        const legacy = await prisma.session.findMany({
            where: { NOT: { sessionToken: { regexp: '^[a-f0-9]{64}$' } } },
            select: { id: true },
            take: MAX_ROWS_PER_SWEEP,
        });
        if (legacy.length === 0) return 0;
        const { count } = await prisma.session.deleteMany({ where: { id: { in: legacy.map((row) => row.id) } } });
        logger.warn(`Purged ${count} session row(s) stored as plaintext tokens. Those users must sign in again.`);
        return count;
    } catch (error) {
        // MySQL and TiDB both support REGEXP, but a failure here must not stop the
        // service or the rest of the sweep: the rows are already unusable.
        logger.error('Could not purge legacy plaintext sessions:', error);
        return 0;
    }
}

export function sessionMaintenanceState(): typeof state & { intervalMs: number; running: boolean } {
    return { ...state, intervalMs: SWEEP_INTERVAL_MS, running: inflight !== null };
}

/**
 * Delete lapsed sessions and unused, expired password-reset tokens.
 *
 * `deleteMany` with a `take`-style bound is not expressible in one Prisma call,
 * so the batch limit is applied by selecting ids first. That costs an extra round
 * trip but keeps a single statement bounded, which matters more than the round
 * trip on a table that has been growing since the service launched.
 */
export async function sweepExpiredCredentials(): Promise<SweepReport> {
    const startedAt = Date.now();
    const now = new Date();

    const expiredSessionIds = await prisma.session.findMany({
        where: { expires: { lt: now } },
        select: { id: true },
        take: MAX_ROWS_PER_SWEEP,
    });
    const expiredSessions = expiredSessionIds.length
        ? (await prisma.session.deleteMany({ where: { id: { in: expiredSessionIds.map((row) => row.id) } } })).count
        : 0;

    const expiredTokenIds = await prisma.verificationToken.findMany({
        where: { expires: { lt: now } },
        select: { token: true },
        take: MAX_ROWS_PER_SWEEP,
    });
    const expiredTokens = expiredTokenIds.length
        ? (await prisma.verificationToken.deleteMany({ where: { token: { in: expiredTokenIds.map((row) => row.token) } } })).count
        : 0;

    // Runs on every sweep but is a no-op once the legacy rows are gone.
    const legacySessions = await purgeLegacyPlaintextSessions();

    const report = { expiredSessions, expiredTokens, legacySessions, durationMs: Date.now() - startedAt };
    state.sweeps += 1;
    state.expiredSessions += expiredSessions;
    state.expiredTokens += expiredTokens;
    state.legacySessions += legacySessions;
    state.lastRunAt = new Date().toISOString();

    if (expiredSessions || expiredTokens || legacySessions) {
        logger.info('Expired credential sweep', report);
    } else {
        logger.debug('Expired credential sweep found nothing to remove.', { durationMs: report.durationMs });
    }
    return report;
}

/**
 * Start the periodic sweep.
 *
 * Concurrent invocations are collapsed: a sweep that outlives its interval must
 * not stack up behind itself, and `startSessionMaintenance` is idempotent so a
 * second call cannot create two timers.
 */
export function startSessionMaintenance(): void {
    if (timer) return;

    const run = (): void => {
        if (inflight) return;
        inflight = sweepExpiredCredentials()
            .catch((error) => {
                state.failures += 1;
                logger.error('Expired credential sweep failed:', error);
                return { expiredSessions: 0, expiredTokens: 0, legacySessions: 0, durationMs: 0 };
            })
            .finally(() => { inflight = null; });
        void inflight;
    };

    timer = setInterval(run, SWEEP_INTERVAL_MS);
    // Never let housekeeping hold the event loop open on its own: in tests, and
    // during shutdown, the process must be able to exit on the strength of its
    // real work alone.
    timer.unref?.();

    // First sweep shortly after boot rather than immediately: startup already runs
    // the stats-cache aggregation and the readiness probes against the same small
    // connection pool. Jittered so a fleet restarted together does not sweep
    // together.
    const firstRun = setTimeout(run, 30_000 + Math.floor(Math.random() * 30_000));
    firstRun.unref?.();

    logger.info(`Expired credential sweep scheduled every ${Math.round(SWEEP_INTERVAL_MS / 60_000)} minutes.`);
}

export function stopSessionMaintenance(): void {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}

/** Await a sweep that is already running, for shutdown and for tests. */
export async function drainSessionMaintenance(): Promise<void> {
    if (inflight) await inflight.catch(() => undefined);
}
