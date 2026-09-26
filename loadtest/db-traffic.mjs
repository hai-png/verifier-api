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
 *   node loadtest/db-traffic.mjs --base-url http://127.0.0.1:3001 \
 *        --api-key "$KEY" --scenario verify_telebirr_external --requests 5
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
    'workspace-id': { type: 'string' },
    scenario: { type: 'string', default: 'verify_telebirr_external' },
    requests: { type: 'string', default: '5' },
    out: { type: 'string' },
  },
});

const baseUrl = values['base-url'] || process.env.LOADTEST_BASE_URL || 'http://127.0.0.1:3001';
const scenarioName = values.scenario;
const requests = Number(values.requests);

const auth = resolveAuth({
  apiKey: values['api-key'] || process.env.LOADTEST_API_KEY || null,
  dashboardKey: values['dashboard-key'] || process.env.LOADTEST_DASHBOARD_SECRET || null,
  workspaceId: values['workspace-id'] || process.env.LOADTEST_WORKSPACE_ID || null,
});
if (!auth) throw new Error('Provide --api-key or --dashboard-key + --workspace-id');

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

/** Collapse literals and whitespace so shapes aggregate. */
function normalize(sql) {
  return sql
    .replace(/\s+/g, ' ')
    .replace(/\?/g, '?')
    .trim()
    .slice(0, 180);
}

function diff(before, after) {
  const result = new Map();
  for (const [key, value] of after) {
    const previous = before.get(key) ?? 0;
    const delta = value - previous;
    if (delta > 0) result.set(key, delta);
  }
  return result;
}

async function main() {
  const scenario = SCENARIOS[scenarioName];
  if (!scenario) throw new Error(`unknown scenario ${scenarioName}`);

  const client = createClient({ baseUrl });

  // Warm the pools and prepared statements so we measure steady state.
  await client.request({ ...scenario.request({ auth }), label: scenarioName });
  await new Promise((resolve) => setTimeout(resolve, 300));

  const digestsBefore = await snapshotDigests();
  const comBefore = await snapshotCom();

  const started = Date.now();
  const results = [];
  for (let i = 0; i < requests; i += 1) {
    results.push(await client.request({ ...scenario.request({ auth }), label: scenarioName }));
  }
  const elapsed = Date.now() - started;

  // Let the write-behind buffers flush before counting.
  await new Promise((resolve) => setTimeout(resolve, 3_000));

  const digestsAfter = await snapshotDigests();
  const comAfter = await snapshotCom();

  const digestDelta = [...diff(digestsBefore, digestsAfter).entries()]
    .map(([sql, count]) => ({ sql: normalize(sql), count, perRequest: count / requests }))
    .sort((a, b) => b.count - a.count);

  const comDelta = Object.fromEntries([...diff(comBefore, comAfter).entries()]);
  const statementCount = [...diff(digestsBefore, digestsAfter).values()].reduce((a, b) => a + b, 0);

  const report = {
    scenario: scenarioName,
    authMode: auth.mode,
    requests,
    requestMs: { total: elapsed, mean: elapsed / requests },
    responses: results.map((r) => ({
      status: r.status,
      class: classify(r),
      totalMs: Number(r.totalMs?.toFixed(1)),
    })),
    sqlStatements: statementCount,
    sqlPerRequest: statementCount / requests,
    comCounters: comDelta,
    statementShapes: digestDelta,
  };

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
