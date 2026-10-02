#!/usr/bin/env node
/**
 * Reconcile Product.soldCount with the orders that actually exist.
 *
 * soldCount is claimed atomically at confirmation time instead of counting
 * orders, because counting was a read-then-write and two buyers arriving at
 * once both saw the same last free slot and both won. Adding the column
 * defaults every existing product to 0, which would make sold-out products look
 * like they have unlimited stock — and a product whose maxBuyers has been
 * lowered below its real sales would sell more than it should.
 *
 * Run this once after `prisma db push`, then it is no longer needed: only
 * paymentLinks.ts creates orders, and it claims and releases in step with them.
 *
 *   npm run backfill:sold-count
 *   npm run backfill:sold-count -- --dry-run
 *
 * Environment:
 *   DATABASE_URL  required. The same database the API uses.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const dryRun = process.argv.includes('--dry-run');

async function main() {
  const products = await prisma.product.findMany({
    select: { id: true, name: true, maxBuyers: true, soldCount: true },
  });

  const drifted = [];
  for (const product of products) {
    const actual = await prisma.order.count({
      where: { productId: product.id, status: 'PAID' },
    });
    if (actual !== product.soldCount) {
      drifted.push({ ...product, actual });
    }
  }

  if (drifted.length === 0) {
    console.log(`All ${products.length} products already match their paid orders.`);
    return;
  }

  for (const product of drifted) {
    const overCap =
      product.maxBuyers !== null && product.actual > product.maxBuyers
        ? `  (already ${product.actual - product.maxBuyers} over its cap of ${product.maxBuyers})`
        : '';
    console.log(`${product.name}: soldCount ${product.soldCount} -> ${product.actual}${overCap}`);

    if (!dryRun) {
      // Absolute set, not an increment: a drifted count has to be corrected to
      // the true value, and incrementing from a wrong base could not be.
      await prisma.product.update({
        where: { id: product.id },
        data: { soldCount: product.actual },
      });
    }
  }

  console.log(
    `\n${dryRun ? 'Would update' : 'Updated'} ${drifted.length} of ${products.length} products.` +
      (dryRun ? ' Re-run without --dry-run to apply.' : ''),
  );
}

main()
  .catch((error) => {
    console.error('Backfill failed:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
