import { Request, Response, NextFunction } from 'express';
import { getWorkspaceContext } from '../utils/workspaceContext';
import { getRateLimit } from '../config/plans';
import { getBillingConfig } from '../config/billingConfig';
import { getRequestIp } from '../utils/requestIp';
import { isTrustedBillingPaymentVerification } from '../utils/trustedInternalOperation';
import { MemoryWindowCounter } from '../utils/expiringStore';

const WINDOW_MS = 60 * 1000;
const PUBLIC_VERIFY_WINDOW_MS = 60 * 60 * 1000;
const PUBLIC_VERIFY_LIMIT = 6;

// Bounded, self-sweeping counters — the previous plain Map grew with every
// distinct IP/key and was never evicted.
//
// Two stores, not one. The anonymous public throttle runs on a 1 h window and
// the plan limits on a 60 s window; sharing a single bounded map meant the hard
// cap in one population could evict live entries belonging to the other, and an
// authenticated tenant could therefore reset anonymous callers' hourly budget by
// generating enough of their own traffic to trip eviction. Separate stores give
// each population its own bound.
const store = new MemoryWindowCounter();
const publicStore = new MemoryWindowCounter({ maxEntries: 20_000 });

/** Observability for /status/summary. */
export const rateLimiterState = () => ({
  trackedKeys: store.size(),
  sweeps: store.sweepCount(),
  evictions: store.evictionCount(),
  publicTrackedKeys: publicStore.size(),
  publicSweeps: publicStore.sweepCount(),
  publicEvictions: publicStore.evictionCount(),
});

export const rateLimiter = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  if (isTrustedBillingPaymentVerification(req)) {
    next();
    return;
  }

  const context = getWorkspaceContext(req);
  const requestIp = getRequestIp(req);

  if (!context) {
    if (!(req as any).publicVerify) {
      next();
      return;
    }

    const rateLimitKey = `public:${requestIp}`;
    const now = Date.now();
    const entry = publicStore.increment(rateLimitKey, PUBLIC_VERIFY_WINDOW_MS, now);

    if (entry.count > PUBLIC_VERIFY_LIMIT) {
      const retryAfter = Math.ceil((entry.windowStart + entry.windowMs - now) / 1000);
      res.status(429).json({
        success: false,
        error: 'Public verification limit reached. Create a workspace to keep verifying more references.',
        retryAfter,
      });
      return;
    }

    next();
    return;
  }

  const nowDate = new Date();
  const tier = context.workspace.paidUntil && nowDate >= context.workspace.paidUntil
    ? 'FREE'
    : context.workspace.tier;
  const grandfathered = context.workspace.grandfathered;

  const billingConfig = await getBillingConfig();
  const limit = getRateLimit(tier, grandfathered, billingConfig);

  const now    = Date.now();

  // The plan limit is a *workspace* entitlement, so it has to be enforced per
  // workspace as well as per key. Keying only on the API key id let a tenant
  // multiply their contracted requests-per-minute by minting extra keys.
  const workspaceEntry = store.increment(`ws:${context.workspace.id}`, WINDOW_MS, now);
  if (workspaceEntry.count > limit) {
    const retryAfter = Math.ceil((workspaceEntry.windowStart + workspaceEntry.windowMs - now) / 1000);
    res.status(429).json({
      success: false,
      error: 'Rate limit exceeded.',
      retryAfter,
    });
    return;
  }

  // Determine rate limit key based on auth source
  let rateLimitKey: string;
  if (context.source === 'dashboard') {
    // For dashboard auth, use workspace ID + IP address
    rateLimitKey = `dashboard:${context.workspace.id}:${requestIp}`;
  } else {
    // For API key auth, use the API key id.
    //
    // Never fall back to a shared literal such as 'unknown': that puts every
    // credential-less caller in one bucket, so one tenant's traffic throttles
    // everyone else's. The workspace counter above already ran, so skipping the
    // per-key counter here loses no enforcement — it only avoids a collision.
    const apiKeyData = (req as any).apiKeyData;
    if (!apiKeyData?.id) {
      next();
      return;
    }
    rateLimitKey = `key:${apiKeyData.id}`;
  }

  const entry  = store.increment(rateLimitKey, WINDOW_MS, now);

  if (entry.count > limit) {
    const retryAfter = Math.ceil((entry.windowStart + entry.windowMs - now) / 1000);
    res.status(429).json({
      success: false,
      error: 'Rate limit exceeded.',
      retryAfter,
    });
    return;
  }

  next();
};
