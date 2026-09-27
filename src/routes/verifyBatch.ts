import { Router, Request, Response, NextFunction } from 'express';
import { prepareVerification, executeVerification, VerificationPlan, SmartVerifyResult } from '../services/verifyUniversal';
import { verificationResultCache } from '../middleware/verifyResultCache';
import { enqueueUsageLogs } from '../middleware/requestLogger';
import { refundPartialQuota } from '../utils/quotaCharge';
import { rateLimiter } from '../middleware/rateLimiter';
import { getSyncedPlanState, permissionGate, verifyQuotaGate } from '../middleware/tierGate';
import { prisma } from '../utils/prisma';
import logger from '../utils/logger';
import { getWorkspaceContext } from '../utils/workspaceContext';
import { getBatchMaxReferences } from '../config/plans';
import { getRequestIp } from '../utils/requestIp';

/**
 * How many provider lookups a batch may have in flight at once. Provider
 * endpoints rate-limit aggressively and the CBE path can fall back to a headless
 * browser, so this stays small regardless of how large the batch is.
 */
const BATCH_CONCURRENCY = 5;

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

// Parameters annotated explicitly. With three handlers ahead of it, Express's
// `post` resolves to the overload whose rest parameter is a *union* of
// RequestHandler and ErrorRequestHandler, and TypeScript will not contextually
// type an un-annotated arrow function from an ambiguous union — so `req`, `res`
// and `next` silently came out implicitly `any` here, leaving `req.body` and
// `res.status` completely unchecked in the one route that validates up to 500
// caller-supplied items. The final handler in this chain already annotated its
// parameters; this one did not.
router.post(
  '/',
  rateLimiter,
  permissionGate('verify-batch'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const items = req.body?.references;
  if (!Array.isArray(items) || items.length === 0 || items.length > 500) {
    res.status(400).json({ success: false, error: 'references must contain between 1 and 500 items.' });
    return;
  }
  const workspaceContext = getWorkspaceContext(req);
  if (!workspaceContext) {
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
  },
  verifyQuotaGate,
  async (req: Request<{}, {}, BatchBody>, res: Response): Promise<void> => {
  const apiKeyData = (req as any).apiKeyData;
  const { references } = req.body;

  const startedAt = Date.now();
  // Use the same prepared provider plans as single requests, with bounded
  // batch fan-out. Bulk quota and settlement semantics remain at this layer.
  const plans = res.locals.verificationPlans as VerificationPlan[];

  // ── Collapse repeated lookups before spending anything on them ─────────────
  // A batch of 500 items containing the same reference 500 times used to make
  // 500 provider calls and consume 500 credits. The shared result cache only
  // replays *successful* lookups (a negative answer is deliberately never cached,
  // so a receipt that appears later is not missed), so it cannot deduplicate a
  // batch of failures — and it does not help at all when the cache is disabled or
  // the workspace is anonymous. Collapsing here covers both, and the credits for
  // the duplicates are given back below, because the provider was asked once.
  const keyFor = (plan: VerificationPlan): string =>
    JSON.stringify([plan.provider, plan.reference, plan.suffix ?? '', plan.phoneNumber ?? '']);

  const uniquePlans: VerificationPlan[] = [];
  const uniqueIndexOf = new Map<string, number>();
  const planToUnique = plans.map((plan) => {
    const key = keyFor(plan);
    const existing = uniqueIndexOf.get(key);
    if (existing !== undefined) return existing;
    uniquePlans.push(plan);
    uniqueIndexOf.set(key, uniquePlans.length - 1);
    return uniquePlans.length - 1;
  });

  const workspaceId = getWorkspaceContext(req)?.workspace.id;

  const duplicateUnits = plans.length - uniquePlans.length;
  if (duplicateUnits > 0) {
    logger.info('verify-batch collapsed duplicate references', {
      requested: plans.length,
      unique: uniquePlans.length,
      duplicateUnits,
      workspaceId: workspaceId ?? 'none',
    });
    // Awaited, not detached: this is the customer's money. A batch has already
    // spent seconds on provider calls, so one indexed UPDATE is not what the
    // caller is waiting for, and a detached write can be dropped by a shutdown
    // that lands between here and the flush. A failure is logged inside
    // quotaCharge and must not fail the batch.
    await refundPartialQuota(req, duplicateUnits, 'duplicate references in one batch collapsed to a single lookup')
      .catch((err) => { logger.error('Failed to refund duplicate batch units:', err); return false; });
  }

  // ── Execute, bounded fan-out, through the same cache single verify uses ────
  const uniqueSettled: PromiseSettledResult<SmartVerifyResult>[] = [];
  for (let offset = 0; offset < uniquePlans.length; offset += BATCH_CONCURRENCY) {
    const chunk = uniquePlans.slice(offset, offset + BATCH_CONCURRENCY);
    uniqueSettled.push(...await Promise.allSettled(chunk.map((plan) =>
      // `run` coalesces concurrent identical lookups, replays a cached success,
      // and stores this one for the next request — the batch path previously
      // bypassed all three.
      verificationResultCache.run(workspaceId, plan, () => executeVerification(plan))
        .then((outcome) => outcome.result),
    )));
  }

  // ── Build results and log each one to UsageLog ───────────────────────────────
  // First index at which each distinct lookup appeared, so a repeated row can
  // point at the row it was collapsed into. Built in one pass: a 500-item batch
  // must not cost O(n²) to describe.
  const firstIndexOf = new Map<string, number>();
  const duplicateOf = plans.map((plan, i) => {
    const key = keyFor(plan);
    const first = firstIndexOf.get(key);
    if (first === undefined) {
      firstIndexOf.set(key, i);
      return undefined;
    }
    return first;
  });

  const results = plans.map((plan, i) => {
    const item = references[i]!;
    const outcome = uniqueSettled[planToUnique[i]]!;
    const base = {
      index: i,
      reference: item.reference ?? plan.reference,
      // Tells a caller whether this row is its own provider lookup or a repeat of
      // another row in the same batch — and which one it shares an answer with.
      duplicateOf: duplicateOf[i],
    };

    if (outcome.status === 'fulfilled') {
      const r = outcome.value;
      return {
        ...base,
        success: r.success,
        provider: r.provider,
        ...(r.success ? { data: r.data } : { error: r.error }),
      };
    }
    // The promise itself rejected. executeVerification catches provider failures,
    // so this is an infrastructure fault — and it must never read as a verified
    // receipt to a client that only checks `success`.
    return {
      ...base,
      success: false,
      error: outcome.reason instanceof Error ? outcome.reason.message : 'Unexpected error',
    };
  });

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.length - succeeded;

  // One UsageLog row per reference, through the buffered writer rather than a
  // detached `void (async () => createMany(...))()` — the detached version was
  // still in flight when graceful shutdown disconnected Prisma, so batch usage
  // quietly vanished from billing history whenever the process recycled.
  const responseTime = Date.now() - startedAt;
  const ip = getRequestIp(req);
  if (apiKeyData?.id) {
    enqueueUsageLogs(results.map((r) => ({
      apiKeyId: apiKeyData.id,
      endpoint: 'POST /verify-batch',
      method: 'POST',
      statusCode: r.success ? 200 : 422,
      responseTime,
      ip,
    })));
  }

  // `success` describes the request, not the receipts: the batch itself ran and
  // produced a per-item result set. It previously reported `success: true` even
  // when every reference failed, which reads as "verified" to any client that
  // only checks the flag. `succeeded`/`failed` carry the real outcome, and the
  // HTTP status stays 200 because a definitive "no such receipt" is a valid
  // answer — and a billable one: the provider was queried, which is the same
  // policy single verification already applies.
  res.json({
    success: succeeded > 0,
    total: results.length,
    succeeded,
    failed,
    results,
  });
});

export default router;
