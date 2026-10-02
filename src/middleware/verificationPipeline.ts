import { RequestHandler } from 'express';
import { performance } from 'perf_hooks';
import { prepareVerification, executeVerification, SmartVerifyResult, VerificationPlan } from '../services/verifyUniversal';
import { verificationResultCache } from './verifyResultCache';
import { applyRecipientCheck, resolveRecipientPayoutAccount } from '../utils/verifyRecipient';
import { rateLimiter } from './rateLimiter';
import { permissionGate, verifyQuotaGate } from './tierGate';
import { verifyWebhookHook } from './verifyWebhookHook';
import { getWorkspaceContext } from '../utils/workspaceContext';
import { isTrustedBillingPaymentVerification } from '../utils/trustedInternalOperation';
import { prisma } from '../utils/prisma';

export type VerificationEnvelope = 'universal' | 'dashboard' | 'legacy';
interface PipelineOptions {
  provider?: string;
  envelope?: VerificationEnvelope;
  public?: boolean;
}
export interface PipelineDependencies {
  rateLimit: RequestHandler;
  permission: RequestHandler;
  quota: RequestHandler;
  webhook: RequestHandler;
  execute: (plan: VerificationPlan) => Promise<SmartVerifyResult>;
  cache: typeof verificationResultCache;
}

/** Membership predicate and workspace data in one SQL query, no auth cache. */
export function dashboardVerificationAccess(db: Pick<typeof prisma, 'workspace'> = prisma): RequestHandler {
  return async (req, res, next) => {
    const userId = (req as any).userId as string | undefined;
    if (!userId) { res.status(401).json({ success: false, error: 'Authentication required.' }); return; }
    const start = performance.now();
    try {
      const workspace = await db.workspace.findFirst({
        where: { id: req.params.workspaceId as string, memberships: { some: { userId } } },
      });
      if (!workspace) { res.status(403).json({ success: false, error: 'Access denied.' }); return; }
      (req as any).workspaceContext = { workspace, source: 'dashboard' };
      (req as any).apiKeyData = null;
      res.locals.verificationStartedAt = start;
      res.locals.verificationTimings = { access: performance.now() - start };
      next();
    } catch (error) { next(error); }
  };
}

/** Transport adapters only. Legacy routes keep success payloads and historical
 * domain-failure envelopes; the provider/cache/billing decisions are shared.
 */
export function verificationResponse(result: SmartVerifyResult, envelope: VerificationEnvelope, legacyProvider?: string): { status: number; body: unknown } {
  const p = legacyProvider?.toLowerCase();
  if (!result.success) {
    if (envelope === 'legacy' && result.data && ['dashen', 'mpesa', 'awash', 'zemen', 'cbebirr'].includes(p ?? '')) {
      return { status: 200, body: result.data };
    }
    return {
      status: envelope === 'legacy' && p === 'abyssinia' && result.data ? 404 : result.httpStatus,
      body: { success: false, error: result.error, ...(envelope === 'dashboard' ? { provider: result.provider } : {}), ...(result.details ? { details: result.details } : {}) },
    };
  }
  const data = result.data as any;
  if (envelope === 'dashboard') return { status: 200, body: { success: true, provider: result.provider, data: data?.success !== undefined ? data.data ?? data : data } };
  if (envelope === 'legacy') return { status: 200, body: ['telebirr', 'abyssinia'].includes(p ?? '') ? { success: true, data } : data };
  return { status: 200, body: data?.success !== undefined ? data : { success: true, data } };
}

/** The ONLY single-receipt HTTP pipeline, after the entry point authenticates.
 * Cache hits/coalesced followers still pass authorization, limits and charging.
 * Public calls have a separate explicit throttle and cannot share tenant data.
 */
export function createVerificationPipeline(options: PipelineOptions = {}, overrides: Partial<PipelineDependencies> = {}): RequestHandler[] {
  const deps: PipelineDependencies = { rateLimit: rateLimiter, permission: permissionGate('verify'), quota: verifyQuotaGate, webhook: verifyWebhookHook, execute: executeVerification, cache: verificationResultCache, ...overrides };
  const timing: RequestHandler = (_req, res, next) => {
    const start = res.locals.verificationStartedAt ?? performance.now();
    res.locals.verificationTimings ??= {};
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      const timings = { ...res.locals.verificationTimings, verify_total: performance.now() - start };
      res.setHeader('Server-Timing', Object.entries(timings).map(([name, duration]) => `${name};dur=${Number(duration).toFixed(1)}`).join(', '));
      res.setHeader('Cache-Control', 'no-store'); // Browser/CDN must not cache receipts.
      return json(body);
    };
    next();
  };
  const timed = (name: string, middleware: RequestHandler): RequestHandler => (req, res, next) => {
    const start = performance.now();
    return middleware(req, res, (error?: unknown) => {
      res.locals.verificationTimings[name] = performance.now() - start;
      next(error);
    });
  };
  const normalize: RequestHandler = (req, res, next) => {
    if (!options.public && !getWorkspaceContext(req) && !(req as any).publicVerify) {
      res.status(401).json({ success: false, error: 'Authentication required.' }); return;
    }
    const input = req.method === 'GET' || req.method === 'HEAD' ? req.query : req.body;
    const prepared = prepareVerification(options.provider && input && typeof input === 'object' && !Array.isArray(input)
      ? { ...input, provider: options.provider } : input);
    if (!prepared.ok) { res.status(400).json({ success: false, error: prepared.result.error }); return; }
    res.locals.verificationPlan = prepared.plan;
    (req as any).verificationPlan = prepared.plan;
    // Kept out of the plan on purpose. The plan is what the result cache keys on,
    // and the provider's answer does not depend on who the receipt was checked
    // against — so one cached lookup serves every payout account. Captured here
    // and applied after the cache instead.
    const requestedPayoutAccountId = input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>).payoutAccountId
      : undefined;
    res.locals.requestedPayoutAccountId = typeof requestedPayoutAccountId === 'string' && requestedPayoutAccountId.trim() !== ''
      ? requestedPayoutAccountId.trim()
      : null;
    // Existing quota/webhook middleware consumes reference, including legacy
    // receiptNumber and GET callers. It now always sees normalized fields.
    req.body = { reference: prepared.plan.reference, suffix: prepared.plan.suffix, phoneNumber: prepared.plan.phoneNumber };
    res.locals.verificationRequest = true;
    next();
  };
  const verify: RequestHandler = async (req, res, next) => {
    const start = performance.now();
    try {
      const tenant = options.public || isTrustedBillingPaymentVerification(req) ? undefined : getWorkspaceContext(req)?.workspace.id;
      const outcome = await deps.cache.run(tenant, res.locals.verificationPlan, () => deps.execute(res.locals.verificationPlan));
      res.locals.verificationTimings.provider = performance.now() - start;
      res.locals.verificationResult = outcome.result;
      res.setHeader('X-Verify-Cache', outcome.cache);
      if (outcome.result.httpStatus === 503) res.setHeader('Retry-After', '1');

      // Applied after the cache so a receipt already verified for one customer
      // can be re-checked against another account without a second provider call.
      const providerSlug = (options.provider ?? outcome.result.provider ?? '').toString();
      const payoutAccount = await resolveRecipientPayoutAccount(req, res.locals.requestedPayoutAccountId);
      const checked = applyRecipientCheck({
        result: outcome.result as unknown as Record<string, unknown>,
        payoutAccount,
        provider: providerSlug,
      });
      res.locals.verificationResult = checked.result as unknown as typeof outcome.result;
      if (checked.checked) res.locals.recipientChecked = true;

      const response = verificationResponse(checked.result as unknown as typeof outcome.result, options.envelope ?? 'universal', options.provider);
      res.status(response.status).json(response.body);
    } catch (error) { next(error); }
  };
  // Public route owns its IP throttle and must remain quota/webhook-free even
  // if a trusted caller also supplied workspace credentials.
  return options.public
    ? [timing, timed('validate', normalize), verify]
    : [timing, timed('rate_limit', deps.rateLimit), timed('validate', normalize), timed('policy', deps.permission), timed('quota', deps.quota), deps.webhook, verify];
}
