/**
 * Reset the database to a clean state before running `prisma db push`.
 *
 * Why this exists:
 * The upstream repo's migration history has a bug — migration #4
 * (20260718120000_add_configurable_plan_entitlements) tries to ALTER TABLE
 * `PlanPricingConfig`, but no migration CREATEs that table. On a fresh
 * database, `prisma migrate deploy` applies migrations 1-3 (which don't
 * create PlanPricingConfig), then fails on migration 4 with:
 *   Error: P3018 — Table 'test.PlanPricingConfig' doesn't exist
 *
 * The failed migration leaves a row in `_prisma_migrations` with
 * `rolled_back_at = NULL`, which blocks all future migrations:
 *   "A migration failed to apply. New migrations cannot be applied before
 *    the error is recovered from."
 *
 * Fix: skip the broken migration history entirely. This script:
 *   1. Drops the `_prisma_migrations` table (clears the failed-migration state)
 *   2. Drops any partial tables that migrations 1-3 created (so `db push`
 *      starts from a truly clean slate)
 *
 * After this runs, `prisma db push --accept-data-loss` creates ALL tables
 * directly from schema.prisma — no migration files needed.
 *
 * Safe to run on a fresh database. DO NOT run on a database with real data
 * (it will drop everything).
 */

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  console.log('[reset-db] Dropping _prisma_migrations table (clears failed-migration state)...');
  try {
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS `_prisma_migrations`');
    console.log('[reset-db] ✓ _prisma_migrations dropped');
  } catch (e) {
    console.log('[reset-db] (could not drop _prisma_migrations — table may not exist)', e.message);
  }

  // Get all tables in the database
  const tables = await prisma.$queryRawUnsafe(
    "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE()"
  );
  const tableNames = tables.map((t) => t.TABLE_NAME || t.table_name);
  console.log(`[reset-db] Found ${tableNames.length} existing table(s):`, tableNames.join(', ') || '(none)');

  // Drop each table so db push starts clean
  for (const tableName of tableNames) {
    try {
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS \`${tableName}\``);
      console.log(`[reset-db] ✓ Dropped table: ${tableName}`);
    } catch (e) {
      console.log(`[reset-db] (could not drop ${tableName})`, e.message);
    }
  }

  console.log('[reset-db] ✅ Database reset complete. Ready for `prisma db push`.');
}

main()
  .catch((e) => {
    console.error('[reset-db] ❌ Error:', e.message);
    // Exit 0 anyway — db push will create tables even if some existed
    process.exit(0);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
