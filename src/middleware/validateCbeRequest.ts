import { Request, Response, NextFunction } from 'express';
import { prepareVerification } from '../services/verifyUniversal';

/** Backward-compatible helper; validation itself lives in the shared engine. */
export function cbeRequestError(input: unknown): string | null {
  const result = prepareVerification({ ...(input && typeof input === 'object' ? input : {}), provider: 'cbe' });
  return result.ok ? null : result.result.error ?? 'Invalid CBE input.';
}

/** After authentication and rate limiting, but before any credit reservation. */
export function validateCbeRequest(req: Request, res: Response, next: NextFunction): void {
  // Only validate the route's supported methods and exact path.
  if (!['GET', 'HEAD', 'POST'].includes(req.method) || !['/', ''].includes(req.path)) return next();
  const error = cbeRequestError(req.method === 'POST' ? req.body : req.query);
  if (error) {
    res.status(400).json({ success: false, error });
    return;
  }
  next();
}
