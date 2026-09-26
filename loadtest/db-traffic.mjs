#!/usr/bin/env node
/**
 * Counts the SQL statements a single API request costs, using MySQL's
 * general_log (log_output=TABLE). This is how we quantify "one verification
 * costs N round trips to the database" — the dominant cost when the database
 * lives in another region than the API instance.
 *
 *   node loadtest/db-traffic.mjs --base-url http://127.0.0.1:3001 \
 *        --api-key "$KEY" --scenario verify_telebirr_external --requests 5
 */
import { parseArgs } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { createClient, classify } from './lib/http.mjs';
import { SCENARIOS } from './lib/scenarios.mjs';

const { values } = parseArgs({
  options: {
    'base-url': { type: 'string' },
    'api-key': { type: 'string' },
    scenario: { type: 'string', default: 'verify_telebirr_external' },
    requests: { type: 'string', default: '5' },
    out: { type: 'string' },
  },
});

const baseUrl = values['base-url'] || process.env.LOADTEST_BASE_URL || 'http://127.0.0.1:3001';
const apiKey = values['api-key'] || process.env.LOADTEST_API_KEY || null;
const scenarioName = values.scenario;
const requests = Number(values.requests);

const prisma = new PrismaClient();

/** Collapse literals so identical query shapes group together. */
function normalize(sql) {
  return sql
    .replace(/\s+/g, ' ')
    .replace(/'(\\.|[^'])*'/g, '?')
    .replace(/\b\d+\b/g, 'N')
    .replace(/`[^`]*`/g, '`?`')
    .trim()
    .slice(0, 160);
}

async function logControl(sql) {
  await prisma.$executeRawUnsafe(sql);
}

async function main() {
  const scenario = SCENARIOS[scenarioName];
  if (!scenario) throw new Error(`unknown scenario ${scenarioName}`);

  await logControl('SET GLOBAL log_output = "TABLE"');
  await logControl('SET GLOBAL general_log = 1');

  const reset = async () => {
    await logControl('SET GLOBAL general_log = 0');
    await logControl('TRUNCATE TABLE mysql.general_log');
    await logControl('SET GLOBAL general_log = 1');
  };

  const readLog = async () => {
    const rows = await prisma.$queryRawUnsafe(
      'SELECT argument AS sql_text FROM mysql.general_log WHERE command_type = "Query" ORDER BY event_time',
    );
    return rows.map((row) => String(row.sql_text ?? row.SQL_TEXT ?? ''));
  };

  const client = createClient({ baseUrl });

  // Warm the connection pool + JIT paths so we measure steady-state cost.
  await client.request({ ...scenario.request({ apiKey }), label: scenarioName });
  await new Promise((resolve) => setTimeout(resolve, 250));

  await reset();
  const started = Date.now();
  const results = [];
  for (let i = 0; i < requests; i += 1) {
    results.push(await client.request({ ...scenario.request({ apiKey }), label: scenarioName }));
  }
  const elapsed = Date.now() - started;
  await new Promise((resolve) => setTimeout(resolve, 250));

  const statements = (await readLog()).filter((sql) => !/general_log|log_output/i.test(sql));
  await logControl('SET GLOBAL general_log = 0');

  const grouped = new Map();
  for (const sql of statements) {
    const key = normalize(sql);
    grouped.set(key, (grouped.get(key) || 0) + 1);
  }

  const report = {
    scenario: scenarioName,
    requests,
    requestMs: { total: elapsed, mean: elapsed / requests },
    responses: results.map((r) => ({ status: r.status, class: classify(r), totalMs: r.totalMs })),
    sqlStatements: statements.length,
    sqlPerRequest: statements.length / requests,
    distinctShapes: grouped.size,
    shapes: [...grouped.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([sql, count]) => ({ count, perRequest: count / requests, sql })),
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
