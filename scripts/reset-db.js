#!/usr/bin/env node
/**
 * Reset a database to a clean state before running `prisma db push`.
 *
 * Why this exists at all:
 * The upstream repo's migration history is broken — migration #4
 * (20260718120000_add_configurable_plan_entitlements) ALTERs `PlanPricingConfig`,
 * but no migration CREATEs it, and migrations #2/#3 ALTER tables (`apikey`,
 * `user`) under lowercased names that do not exist on a case-sensitive MySQL or
 * TiDB server. On a fresh database `prisma migrate deploy` therefore fails with
 * P3018 and leaves a row in `_prisma_migrations` with `rolled_back_at = NULL`,
 * which blocks every later migration. See prisma/migrations/README.md.
 *
 * ⚠️ THIS DESTROYS DATA. EVERY TABLE IN THE DATABASE NAMED BY DATABASE_URL IS
 * DROPPED. It previously ran with no confirmation, no environment guard and
 * `process.exit(0)` even on failure, so a stray `node scripts/reset-db.js` in a
 * shell that happened to have production credentials in the environment was a
 * one-keystroke total data loss — and it reported success while doing it.
 *
 * Guards, all of which must pass:
 *   1. NODE_ENV=production is refused outright.
 *   2. `--yes` (or CONFIRM_RESET_DB=yes) is required; a bare invocation is a
 *      dry run that prints what *would* be dropped and exits 0 without touching
 *      anything.
 *   3. The target host + database must be typed back with `--target <host>/<db>`
 *      (or CONFIRM_RESET_DB_TARGET) so the operator has to have read the URL.
 *   4. A database that already holds rows in the core commerce tables is refused
 *      unless `--force` is also given.
 *   5. Any failure exits non-zero.
 *
 * Usage:
 *   node scripts/reset-db.js                        # dry run
 *   node scripts/reset-db.js --yes --target gateway01.us-east-1.prod.aws.tidbcloud.com/test
 *   node scripts/reset-db.js --yes --target 127.0.0.1:3306/verifier --force
 */

'use strict';

const { PrismaClient } = require('@prisma/client');

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const optionValue = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};

const CORE_TABLES = ['Workspace', 'User', 'ApiKey', 'Order', 'Product', 'PaymentLink', 'UsageLog', 'BillingPayment'];

function fail(message) {
  console.error(`[reset-db] ❌ ${message}`);
  process.exit(1);
}

function parseDatabaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail('DATABASE_URL is not a parseable URL.');
  }
  const host = url.hostname;
  const port = url.port || (url.protocol === 'mysql:' ? '3306' : '');
  const database = url.pathname.replace(/^\//, '');
  if (!host || !database) fail('DATABASE_URL must name both a host and a database.');
  return { host, port, database, label: `${host}${port ? `:${port}` : ''}/${database}` };
}

async function main() {
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) fail('DATABASE_URL is not set — refusing to guess which database to drop.');

  const target = parseDatabaseUrl(rawUrl);
  const confirmed = flags.has('--yes') || process.env.CONFIRM_RESET_DB === 'yes';
  const expectedTarget = optionValue('target') || process.env.CONFIRM_RESET_DB_TARGET;
  const force = flags.has('--force') || process.env.CONFIRM_RESET_DB_FORCE === 'yes';

  console.log(`[reset-db] target: ${target.label}`);

  if (process.env.NODE_ENV === 'production') {
    fail('NODE_ENV=production. This script drops every table; it must not run against production.');
  }

  if (!confirmed) {
    console.log('[reset-db] DRY RUN — nothing was dropped.');
    console.log('[reset-db] To actually reset, re-run with:');
    console.log(`[reset-db]   node scripts/reset-db.js --yes --target ${target.label}`);
    return;
  }

  if (!expectedTarget) {
    fail(`--target is required. Pass the host/database you intend to wipe, e.g. --target ${target.label}`);
  }
  const normalise = (v) => v.trim().toLowerCase().replace(/^\/+/, '');
  if (normalise(expectedTarget) !== normalise(target.label)
      && normalise(expectedTarget) !== normalise(`${target.host}/${target.database}`)) {
    fail(`--target "${expectedTarget}" does not match DATABASE_URL (${target.label}). Refusing to continue.`);
  }

  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT TABLE_NAME, TABLE_ROWS FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?`,
      target.database,
    );
    const tables = rows.map((r) => r.TABLE_NAME || r.table_name);
    const counts = new Map(rows.map((r) => [r.TABLE_NAME || r.table_name, Number(r.TABLE_ROWS || r.table_rows || 0)]));

    const populated = CORE_TABLES.filter((t) => tables.includes(t) && counts.get(t) > 0);
    if (populated.length > 0 && !force) {
      fail(
        `${target.label} already holds rows in: ${populated.join(', ')}. ` +
        'Re-run with --force if you really mean to destroy them.',
      );
    }

    console.log(`[reset-db] Dropping _prisma_migrations (clears any failed-migration state)...`);
    try {
      await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS `_prisma_migrations`');
    } catch (e) {
      console.log('[reset-db] (could not drop _prisma_migrations — it may not exist)', e.message);
    }

    // Table names come from INFORMATION_SCHEMA for this database only, never from
    // user input, and are quoted; they are not interpolated from argv.
    console.log(`[reset-db] Dropping ${tables.length} table(s)...`);
    await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
    for (const tableName of tables) {
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS \`${String(tableName).replace(/`/g, '')}\``);
      console.log(`[reset-db] ✓ dropped ${tableName}`);
    }
    await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');

    console.log(`[reset-db] ✅ ${target.label} reset. Ready for \`prisma db push\`.`);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

main().catch((e) => {
  console.error('[reset-db] ❌ Error:', e instanceof Error ? e.message : e);
  process.exit(1);
});
