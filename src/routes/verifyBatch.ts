import { Router, Request, Response } from 'express';
import { prepareVerification, executeVerification, VerificationPlan } from '../services/verifyUniversal';
import { rateLimiter } from '../middleware/rateLimiter';
import { getSyncedPlanState, permissionGate, verifyQuotaGate } from '../middleware/tierGate';
import { prisma } from '../utils/prisma';
import logger from '../utils/logger';
import { getWorkspaceContext } from '../utils/workspaceContext';
import { getBatchMaxReferences } from '../config/plans';

const router = Router();

interface BatchItem {
  reference: string;
  suffix?: string;
  phoneNumber?: string;
  provider?: string;
}

interface BatchBody {
  references: BatchItem[];
}

router.post('/', rateLimiter, permissionGate('verify-batch'), async (req, res, next) => {
  const items = req.body?.references;
  if (!Array.isArray(items) || items.length === 0 || items.length > 500) {
    res.status(400).json({ success: false, error: 'references must contain between 1 and 500 items.' });
    return;
  }
  if (!getWorkspaceContext(req)) {
    res.status(402).json({ success: false, error: 'Batch verification requires a workspace.' });
    return;
  }
  const { account, billingConfig } = await getSyncedPlanState(req);
  const maxBatch = getBatchMaxReferences(account.tier, billingConfig);
  if (maxBatch <= 0 || items.length > maxBatch) {
    res.status(maxBatch <= 0 ? 402 : 400).json({ success: false, error: `Batch limit for this plan is ${maxBatch}.` });
    return;
  }
  const plans: VerificationPlan[] = [];
  for (const [index, item] of items.entries()) {
    const prepared = prepareVerification(item);
    if (!prepared.ok) {
      res.status(400).json({ success: false, error: prepared.result.error, index });
      return;
    }
    plans.push(prepared.plan);
  }
  res.locals.verificationPlans = plans;
  next();
}, verifyQuotaGate, async (req: Request<{}, {}, BatchBody>, res: Response): Promise<void> => {
  const apiKeyData = (req as any).apiKeyData;
  const { references } = req.body;

  const startedAt = Date.now();
  // Use the same prepared provider plans as single requests, with bounded
  // batch fan-out. Bulk quota and settlement semantics remain at this layer.
  const plans = res.locals.verificationPlans as VerificationPlan[];
  const settled: PromiseSettledResult<Awaited<ReturnType<typeof executeVerification>>>[] = [];
  for (let offset = 0; offset < plans.length; offset += 5) {
    settled.push(...await Promise.allSettled(plans.slice(offset, offset + 5).map((plan) => executeVerification(plan))));
  }

  // ── Build results and log each one to UsageLog ───────────────────────────────
  const results = settled.map((outcome, i) => {
    const item = references[i]!;

    if (outcome.status === 'fulfilled') {
      const r = outcome.value;
      return {
        index: i,
        success: r.success,
        reference: item.reference ?? plans[i].reference,
        provider: r.provider,
        ...(r.success ? { data: r.data } : { error: r.error }),
      };
    } else {
      // Promise itself rejected (shouldn't normally happen — executeVerification catches provider failures)
      return {
        index: i,
        success: false,
        reference: item.reference ?? plans[i].reference,
        error: outcome.reason instanceof Error ? outcome.reason.message : 'Unexpected error',
      };
    }
  });

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.length - succeeded;

  // Log each reference as a separate UsageLog entry (fire-and-forget, non-blocking)
  const responseTime = Date.now() - startedAt;
  const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
    ?? req.socket.remoteAddress
    ?? 'unknown';

  void (async () => {
    try {
      if (!apiKeyData?.id) return;
      await prisma.usageLog.createMany({
        data: results.map((r) => ({
          apiKeyId: apiKeyData.id,
          endpoint: '/verify-batch',
          method: 'POST',
          statusCode: r.success ? 200 : 422,
          responseTime,
          ip,
        })),
      });
    } catch (err) {
      logger.error('Failed to write batch UsageLogs:', err);
    }
  })();

  res.json({
    success: true,
    total: results.length,
    succeeded,
    failed,
    results,
  });
});

export default router;
