/**
 * dbMetrics.ts
 *
 * Rolling counters for the question the load tests kept asking: how much
 * database work does one request actually cost, and how long does it take?
 *
 * The counters are fed by the Prisma `query` event (see utils/prisma.ts) and by
 * a one-line middleware in index.ts that counts handled requests, so
 * `statements per request` can be derived on a live deployment through
 * `GET /status/summary` — no lab tooling, no database access.
 *
 * Two views are kept:
 *   - totals since process start (stable, but includes warm-up)
 *   - a rolling 60 second window (what the deployment is doing *now*)
 */

export interface StatementClassification {
    verb: string;
    table: string | null;
}

const WINDOW_SECONDS = 60;
const TOP_TABLES = 5;
const SLOWEST_KEPT = 3;

const TOTALS_SLOWEST: { sql: string; ms: number }[] = [];

/** Pull the leading verb and the first table name out of a SQL statement. */
export function classifyStatement(sql: string): StatementClassification {
    const normalized = String(sql ?? '').replace(/\s+/g, ' ').trim();
    const verb = (normalized.match(/^([A-Za-z]+)/)?.[1] ?? 'OTHER').toUpperCase();
    // Prisma qualifies everything (`verifier`.`ApiKey`), so take the *last*
    // identifier of the first qualified name after FROM/INTO/UPDATE/JOIN.
    const match = normalized.match(
        /\b(?:FROM|INTO|UPDATE|JOIN|TABLE)\s+(?:`?[A-Za-z0-9_]+`?\s*\.\s*)*`?([A-Za-z0-9_]+)`?/i,
    );
    const table = match?.[1] ?? null;
    return { verb, table: table ? table.toLowerCase() : null };
}

const state = {
    startedAt: Date.now(),
    statements: 0,
    requests: 0,
    totalMs: 0,
    maxMs: 0,
    byTable: new Map<string, number>(),
    byVerb: new Map<string, number>(),
    buckets: new Map<number, { statements: number; requests: number; ms: number }>(),
    slowest: new Map<string, number>(),
};

const truncate = (sql: string, length = 120): string =>
    sql.length > length ? `${sql.slice(0, length)}…` : sql;

function bucketFor(second: number) {
    let bucket = state.buckets.get(second);
    if (!bucket) {
        bucket = { statements: 0, requests: 0, ms: 0 };
        state.buckets.set(second, bucket);
        if (state.buckets.size > WINDOW_SECONDS + 5) {
            for (const key of state.buckets.keys()) {
                if (key <= second - WINDOW_SECONDS) state.buckets.delete(key);
            }
        }
    }
    return bucket;
}

function noteSlowest(sql: string, ms: number): void {
    const key = truncate(sql);
    const previous = state.slowest.get(key) ?? 0;
    if (ms <= previous) return;
    state.slowest.set(key, ms);
    while (state.slowest.size > SLOWEST_KEPT) {
        // Drop the cheapest entry (the map keeps the slowest shapes only).
        let cheapestKey: string | null = null;
        let cheapest = Number.POSITIVE_INFINITY;
        for (const [candidate, value] of state.slowest) {
            if (value < cheapest) {
                cheapest = value;
                cheapestKey = candidate;
            }
        }
        if (cheapestKey === null) break;
        state.slowest.delete(cheapestKey);
    }
}

/** Called from the Prisma `query` event. Must stay cheap: it runs per statement. */
export function recordDbStatement(sql: string, durationMs: number): void {
    const { verb, table } = classifyStatement(sql);
    state.statements += 1;
    state.totalMs += durationMs;
    if (durationMs > state.maxMs) state.maxMs = durationMs;
    if (table) state.byTable.set(table, (state.byTable.get(table) ?? 0) + 1);
    state.byVerb.set(verb, (state.byVerb.get(verb) ?? 0) + 1);
    noteSlowest(sql, durationMs);
    bucketFor(Math.floor(Date.now() / 1000)).statements += 1;
}

/** Called once per handled HTTP request. */
export function recordHttpRequest(): void {
    state.requests += 1;
    bucketFor(Math.floor(Date.now() / 1000)).requests += 1;
}

export interface DbMetricsSnapshot {
    since: string;
    totals: {
        requests: number;
        statements: number;
        statementsPerRequest: number | null;
        meanStatementMs: number | null;
        maxStatementMs: number;
    };
    windowSeconds: number;
    window: {
        requests: number;
        statements: number;
        statementsPerRequest: number | null;
        meanStatementMs: number | null;
    };
    topTables: { table: string; statements: number }[];
    byVerb: Record<string, number>;
    slowestStatements: { sql: string; ms: number }[];
}

const ratio = (numerator: number, denominator: number): number | null =>
    denominator > 0 ? Number((numerator / denominator).toFixed(2)) : null;

export function dbMetricsSnapshot(): DbMetricsSnapshot {
    const now = Math.floor(Date.now() / 1000);
    let windowStatements = 0;
    let windowRequests = 0;
    let windowMs = 0;
    for (const [second, bucket] of state.buckets) {
        if (second <= now - WINDOW_SECONDS || second > now) continue;
        windowStatements += bucket.statements;
        windowRequests += bucket.requests;
        windowMs += bucket.ms;
    }

    return {
        since: new Date(state.startedAt).toISOString(),
        totals: {
            requests: state.requests,
            statements: state.statements,
            statementsPerRequest: ratio(state.statements, state.requests),
            meanStatementMs: state.statements > 0 ? Number((state.totalMs / state.statements).toFixed(2)) : null,
            maxStatementMs: Number(state.maxMs.toFixed(2)),
        },
        windowSeconds: WINDOW_SECONDS,
        window: {
            requests: windowRequests,
            statements: windowStatements,
            statementsPerRequest: ratio(windowStatements, windowRequests),
            // ms per statement inside the window, averaged over the buckets we saw
            meanStatementMs: windowStatements > 0 ? Number((windowMs / windowStatements).toFixed(2)) : null,
        },
        topTables: [...state.byTable.entries()]
            .map(([table, statements]) => ({ table, statements }))
            .sort((a, b) => b.statements - a.statements)
            .slice(0, TOP_TABLES),
        byVerb: Object.fromEntries([...state.byVerb.entries()].sort((a, b) => b[1] - a[1])),
        slowestStatements: [...state.slowest.entries()]
            .map(([sql, ms]) => ({ sql, ms: Number(ms.toFixed(2)) }))
            .sort((a, b) => b.ms - a.ms),
    };
}

/** Used by tests; harmless in production too. */
export function resetDbMetrics(): void {
    state.startedAt = Date.now();
    state.statements = 0;
    state.requests = 0;
    state.totalMs = 0;
    state.maxMs = 0;
    state.byTable.clear();
    state.byVerb.clear();
    state.buckets.clear();
    state.slowest.clear();
    TOTALS_SLOWEST.length = 0;
}
