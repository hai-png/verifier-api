#!/usr/bin/env node
/**
 * Counts the SQL statements one API request costs.
 *
 * Prisma talks to MySQL with prepared statements, so the general log alone is
 * misleading (an Execute row logs parameter placeholders, not SQL). We therefore
 * diff two sources around the measured requests:
 *
 *   performance_schema.events_statements_summary_by_digest — COUNT_STAR per
 *   DIGEST_TEXT gives both the number of statements and their shapes.
 *   SHOW GLOBAL STATUS Com_* — a protocol-independent cross-check.
 *
 * The tool's own snapshot queries also land in those counters, so an empty
 * control window is measured first and subtracted — otherwise a 5-request
 * sample would report ~0.2 phantom statements per request.
 *
 * Requires a server that implements performance_schema (MySQL/Percona/MariaDB
 * with it enabled). TiDB Cloud does not, so this is a lab-only tool.
 *
 *   node loadtest/db-traffic.mjs --base-url http://127.0.0.1:3001 \
 *        --api-key "$KEY" --scenario verify_telebirr_external --requests 5
 *   node loadtest/db-traffic.mjs --dashboard-key "$DASHBOARD_SECRET" \
 *        --workspace-id "$WORKSPACE_ID" --scenario verify_validate_400
 */
import { parseArgs } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { createClient, classify } from './lib/http.mjs';
import { SCENARIOS, resolveAuth } from './lib/scenarios.mjs';

const { values } = parseArgs({
  options: {
    'base-url': { type: 'string' },
    'api-key': { type: 'string' },
    'dashboard-key': { type: 'string' },
    'dashboard-secret': { type: 'string' },
    'workspace-id': { type: 'string' },
    scenario: { type: 'string', default: 'verify_telebirr_external' },
    requests: { type: 'string', default: '5' },
    // The API batches analytics writes (2s interval by default), so wait for a
    // flush before reading the counters or the request cost looks too low.
    'settle-ms': { type: 'string', default: '4000' },
    // Ordered SQL sequence (text + duration) for the measured window, from
    // performance_schema.events_statements_history_long. Only meaningful for
    // small samples — it is a server-wide ring buffer.
    timeline: { type: 'boolean', default: false },
    out: { type: 'string' },
  },
});

const baseUrl = values['base-url'] || process.env.LOADTEST_BASE_URL || 'http://127.0.0.1:3001';
const scenarioName = values.scenario;
const requests = Number(values.requests);
const settleMs = Number(values['settle-ms']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const auth = resolveAuth({
  apiKey: values['api-key'] || process.env.LOADTEST_API_KEY || null,
  dashboardKey:
    values['dashboard-key'] ||
    values['dashboard-secret'] ||
    process.env.LOADTEST_DASHBOARD_SECRET ||
    null,
  workspaceId: values['workspace-id'] || process.env.LOADTEST_WORKSPACE_ID || null,
});
if (!auth) throw new Error('Provide --api-key, or --dashboard-key + --workspace-id');

const prisma = new PrismaClient();

const COM_COUNTERS = [
  'Com_select',
  'Com_insert',
  'Com_update',
  'Com_delete',
  'Com_stmt_execute',
  'Com_stmt_prepare',
  'Com_stmt_fetch',
];

async function snapshotDigests() {
  const rows = await prisma.$queryRawUnsafe(
    'SELECT DIGEST_TEXT AS sqlText, COUNT_STAR AS count FROM performance_schema.events_statements_summary_by_digest WHERE DIGEST_TEXT IS NOT NULL',
  );
  const map = new Map();
  for (const row of rows) {
    map.set(String(row.sqlText), Number(row.count));
  }
  return map;
}

async function snapshotCom() {
  const rows = await prisma.$queryRawUnsafe('SHOW GLOBAL STATUS');
  const map = new Map();
  for (const row of rows) {
    const name = String(row.Variable_name ?? row.variable_name ?? '');
    const value = Number(row.Value ?? row.value ?? 0);
    if (COM_COUNTERS.includes(name)) map.set(name, value);
  }
  return map;
}

const LONG_HISTORY = 'events_statements_history_long';
const THREAD_HISTORY = 'events_statements_history';

/**
 * Which statement-history table can we read?
 *
 * `events_statements_history_long` is DISABLED by default in MySQL (only the
 * per-thread `events_statements_history` ring is on), which is why a timeline
 * silently came back empty. Try to switch the consumer on; if that is not
 * permitted, fall back to the per-thread ring (10 statements by default, so it
 * may only show part of a request — the caller is told which one was used).
 */
async function historyCapabilities() {
  const consumers = await prisma.$queryRawUnsafe(
    'SELECT NAME AS name, ENABLED AS enabled FROM performance_schema.setup_consumers WHERE NAME IN (?, ?)',
    LONG_HISTORY,
    THREAD_HISTORY,
  );
  const enabled = new Map(consumers.map((row) => [String(row.name), String(row.enabled).toUpperCase()]));

  if (enabled.get(LONG_HISTORY) !== 'YES') {
    try {
      await prisma.$queryRawUnsafe(
        `UPDATE performance_schema.setup_consumers SET ENABLED = 'YES' WHERE NAME = ?`,
        LONG_HISTORY,
      );
      enabled.set(LONG_HISTORY, 'YES');
      console.error('enabled the events_statements_history_long consumer for this run');
    } catch (error) {
      console.error(
        `warning: cannot enable ${LONG_HISTORY} (${error.message}); falling back to ${THREAD_HISTORY} (per-thread ring, may truncate)`,
      );
    }
  }

  const source = enabled.get(LONG_HISTORY) === 'YES' ? LONG_HISTORY : THREAD_HISTORY;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT (SELECT COALESCE(MAX(EVENT_ID), 0) FROM performance_schema.${source}) AS maxEventId, (SELECT THREAD_ID FROM performance_schema.threads WHERE PROCESSLIST_ID = CONNECTION_ID()) AS threadId`,
  );
  return {
    source,
    fallback: source === THREAD_HISTORY,
    maxEventId: Number(rows?.[0]?.maxEventId ?? 0),
    threadId: Number(rows?.[0]?.threadId ?? 0),
  };
}

/**
 * Every statement the *application* ran after `cursor`, in order. The tool's own
 * queries are filtered out (by thread id for the long ring, by keeping only our
 * thread for the per-thread one), so this is the app's real sequence — the thing
 * you need to explain a request that costs six round trips.
 */
async function historySince(cursor) {
  const rows =
    cursor.source === THREAD_HISTORY
      ? await prisma.$queryRawUnsafe(
          `SELECT SQL_TEXT AS sql, ROUND(TIMER_WAIT / 1000000000, 3) AS ms
           FROM performance_schema.${THREAD_HISTORY}
           WHERE THREAD_ID = ? AND EVENT_ID > ? AND SQL_TEXT IS NOT NULL
           ORDER BY EVENT_ID`,
          cursor.threadId,
          cursor.maxEventId,
        )
      : await prisma.$queryRawUnsafe(
          `SELECT SQL_TEXT AS sql, ROUND(TIMER_WAIT / 1000000000, 3) AS ms
           FROM performance_schema.${LONG_HISTORY}
           WHERE EVENT_ID > ? AND THREAD_ID <> ? AND SQL_TEXT IS NOT NULL
           ORDER BY EVENT_ID`,
          cursor.maxEventId,
          cursor.threadId,
        );
  return rows.map((row) => ({
    sql: normalize(String(row.sql)),
    ms: Number(row.ms ?? 0),
  }));
}

/** Collapse literals and whitespace so shapes aggregate. */
function normalize(sql) {
  return sql
    .replace(/\s+/g, ' ')
    .replace(/\b\d+\b/g, '?')
    .trim()
    .slice(0, 180);
}

/** Values that grew between two snapshots. */
function diff(before, after) {
  const result = new Map();
  for (const [key, value] of after) {
    const delta = value - (before.get(key) ?? 0);
    if (delta > 0) result.set(key, delta);
  }
  return result;
}

/** Subtract control noise (the tool's own queries) from a measured delta. */
function subtractNoise(delta, noise) {
  const result = new Map();
  for (const [key, value] of delta) {
    const net = value - (noise.get(key) ?? 0);
    // Digest text for the snapshot queries can differ from the ones counted
    // during the window, so never let noise push a shape below zero.
    if (net > 0) result.set(key, net);
  }
  return result;
}

function sum(map) {
  let total = 0;
  for (const value of map.values()) total += value;
  return total;
}

/**
 * Run `fn` between two counter snapshots and return the raw deltas.
 * `fn` returns { elapsed, value }.
 */
async function measureWindow(fn, { withHistory = false } = {}) {
  let cursor = null;
  if (withHistory) {
    // performance_schema history is a convenience, not a requirement: if the
    // server has it disabled the counts must still be reported.
    try {
      cursor = await historyCapabilities();
    } catch (error) {
      console.error(`warning: statement timeline unavailable (${error.message})`);
      cursor = null;
    }
  }
  const digestsBefore = await snapshotDigests();
  const comBefore = await snapshotCom();
  const outcome = await fn();
  await sleep(settleMs);
  const digestsAfter = await snapshotDigests();
  const comAfter = await snapshotCom();
  return {
    digests: diff(digestsBefore, digestsAfter),
    com: diff(comBefore, comAfter),
    elapsedMs: outcome.elapsed,
    result: outcome.value,
    timeline: cursor ? await historySince(cursor).catch((error) => {
      console.error(`warning: could not read the statement timeline: ${error.message}`);
      return null;
    }) : null,
    timelineSource: cursor?.source ?? null,
  };
}

async function main() {
  const scenario = SCENARIOS[scenarioName];
  if (!scenario) {
    throw new Error(`unknown scenario ${scenarioName}. Known: ${Object.keys(SCENARIOS).join(', ')}`);
  }

  // Fail loudly when performance_schema is unavailable instead of silently
  // reporting zero statements.
  const probe = await prisma.$queryRawUnsafe('SELECT @@performance_schema AS enabled');
  const enabled = Number(probe?.[0]?.enabled ?? 0);
  if (!enabled) {
    throw new Error(
      'performance_schema is disabled on this server — statement counts would be meaningless (TiDB does not implement it).',
    );
  }

  const client = createClient({ baseUrl });

  // Warm the pools and prepared statements so we measure steady state.
  await client.request({ ...scenario.request({ auth }), label: scenarioName });
  await sleep(300);

  // Control window: no requests in between, so every statement counted here
  // belongs to the tool itself.
  const control = await measureWindow(async () => ({ elapsed: 0, value: null }));

  const warm = await measureWindow(async () => {
    const started = Date.now();
    const results = [];
    for (let i = 0; i < requests; i += 1) {
      results.push(await client.request({ ...scenario.request({ auth }), label: scenarioName }));
    }
    return { elapsed: Date.now() - started, value: results };
  }, { withHistory: values.timeline });

  const digests = subtractNoise(warm.digests, control.digests);
  const com = subtractNoise(warm.com, control.com);
  const statementCount = sum(digests);

  const statementShapes = [...digests.entries()]
    .map(([sql, count]) => ({ sql: normalize(sql), count, perRequest: count / requests }))
    .sort((a, b) => b.count - a.count);

  const report = {
    scenario: scenarioName,
    authMode: auth.mode,
    requests,
    settleMs,
    requestMs: { total: warm.elapsedMs, mean: warm.elapsedMs / requests },
    responses: (warm.result ?? []).map((r) => ({
      status: r.status,
      class: classify(r),
      totalMs: Number(r.totalMs?.toFixed(1)),
    })),
    sqlStatements: statementCount,
    sqlPerRequest: statementCount / requests,
    comCountersPerRequest: Object.fromEntries(
      [...com.entries()].map(([name, count]) => [name, count / requests]),
    ),
    controlNoise: {
      statements: sum(control.digests),
      comCounters: Object.fromEntries([...control.com.entries()]),
    },
    statementShapes,
  };

  if (warm.timeline) {
    report.statementTimeline = warm.timeline;
    report.statementTimelineTotalMs = warm.timeline.reduce((total, stmt) => total + stmt.ms, 0);
    report.statementTimelineSource = warm.timelineSource;
    if (warm.timeline.length === 0) {
      console.error('warning: the statement timeline is empty (no readable history table)');
    } else if (warm.timelineSource === THREAD_HISTORY) {
      console.error(
        `note: timeline read from ${THREAD_HISTORY} — it holds ~10 statements per thread, so a multi-request window may be truncated`,
      );
    }
  }

  console.log(JSON.stringify(report, null, 2));
  if (values.out) {
    const fs = await import('node:fs');
    fs.writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);
  }
  await client.close();
}

main()
  .catch((error) => {
    console.error(error.stack || String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
