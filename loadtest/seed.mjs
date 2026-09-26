#!/usr/bin/env node
/**
 * Seeds a disposable database with one workspace + API key so the perf lab can
 * exercise the *authenticated* request path.
 *
 * Prints ONLY the raw API key on stdout (logs go to stderr) so CI can capture it:
 *   KEY=$(node loadtest/seed.mjs)
 *
 * Set SEED_OUT=<path> to also write { apiKey, workspaceId } as JSON — the lab
 * uses the workspace id to exercise the dashboard-secret auth path as well.
 */
import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { DEFAULT_BILLING_CONFIG } from '../dist/config/billingConfig.js';

const prisma = new PrismaClient();

const log = (...args) => console.error('[seed]', ...args);

async function main() {
  const rawKey = process.env.LOADTEST_SEED_KEY || `sk_live_${crypto.randomBytes(24).toString('hex')}`;
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

  // Generous but realistic plan config: enough credits that a load test does
  // not trip the 402 quota gate, while keeping the per-request quota decrement
  // on the hot path (that is part of what we are measuring).
  await prisma.planPricingConfig.upsert({
    where: { id: 'default' },
    update: {},
    create: {
      id: 'default',
      ...DEFAULT_BILLING_CONFIG,
      freeQuotaNewMonthly: 5_000_000,
      freeRateLimit: 100_000,
    },
  });

  const user = await prisma.user.upsert({
    where: { email: 'loadtest@example.test' },
    update: {},
    create: { email: 'loadtest@example.test', name: 'Load Test' },
  });

  const workspace = await prisma.workspace.create({
    data: {
      name: 'Load Test Workspace',
      tier: 'FREE',
      // NOTE: grandfathered (legacy free) would pin the rate limiter to the
      // hardcoded LEGACY_FREE_RATE_LIMIT, which floods the lab with 429s and
      // hides real latency. Modern FREE uses config.freeRateLimit instead.
      grandfathered: false,
      verificationCredits: 5_000_000,
      verificationCreditsMonthly: 5_000_000,
      verificationCreditsResetAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      imageCredits: 100,
      imageCreditsMonthly: 100,
      imageCreditsResetAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    },
  });

  await prisma.membership.create({
    data: { userId: user.id, workspaceId: workspace.id, role: 'OWNER' },
  });

  // A key with only the default "verify" permission, like a real customer key.
  await prisma.apiKey.create({
    data: {
      keyHash,
      prefix: `sk_live_${rawKey.slice(8, 14)}...`,
      workspaceId: workspace.id,
      isActive: true,
      usageCount: 0,
      permissions: ['verify'],
    },
  });

  if (process.env.SEED_OUT) {
    const fs = await import('node:fs');
    fs.writeFileSync(
      process.env.SEED_OUT,
      `${JSON.stringify({ apiKey: rawKey, workspaceId: workspace.id }, null, 2)}\n`,
    );
    log(`wrote ${process.env.SEED_OUT}`);
  }

  log(`workspace=${workspace.id}`);
  process.stdout.write(`${rawKey}\n`);
}

main()
  .catch((error) => {
    console.error('[seed] failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
