import { Request, Response, NextFunction } from 'express';
import { extractLegacyCbeUrlData, isLegacyCbeReference, isNewCbeReference } from '../utils/cbeReference';

/** Pure validation shared by the early gate and the route itself. */
export function cbeRequestError(input: unknown): string | null {
  const { reference, accountSuffix } = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (!reference || typeof reference !== 'string') return 'Missing or invalid reference.';
  const normalized = reference.trim();
  const legacy = isLegacyCbeReference(normalized);
  if (!legacy && !extractLegacyCbeUrlData(normalized) && !isNewCbeReference(normalized)) {
    return 'Invalid CBE reference format.';
  }
  const suffix = typeof accountSuffix === 'string' ? accountSuffix.trim() : '';
  if (legacy && !suffix) return 'Legacy CBE verification requires accountSuffix.';
  if (legacy && !/^\d{8}$/.test(suffix)) return 'CBE accountSuffix must be exactly 8 digits from the payer account.';
  return null;
}

/** After authentication and rate limiting, but before any credit reservation. */
export function validateCbeRequest(req: Request, res: Response, next: NextFunction): void {
  // Only validate the route's supported methods and exact path.
  if (!['GET', 'POST'].includes(req.method) || !['/', ''].includes(req.path)) return next();
  const error = cbeRequestError(req.method === 'GET' ? req.query : req.body);
  if (error) {
    res.status(400).json({ success: false, error });
    return;
  }
  next();
}
