/**
 * Public status summary — no auth required.
 *
 * Deliberately abuse-safe: liveness + configuration flags only, no live
 * upstream probes (those stay behind the signed /internal/status routes).
 * Mounted BEFORE apiKeyAuth in index.ts.
 *
 * GET /status/summary
 */

import { Router, Request, Response } from 'express';
import { getStatusCapabilities } from '../services/statusProbeService';

const router = Router();

const PROVIDERS = [
    'telebirr',
    'cbe',
    'cbebirr',
    'dashen',
    'abyssinia',
    'mpesa',
    'awash',
    'zemen',
];

router.get('/summary', (_req: Request, res: Response): void => {
    const capabilities = getStatusCapabilities();

    res.json({
        status: 'operational',
        timestamp: new Date().toISOString(),
        uptimeSeconds: Math.round(process.uptime()),
        providers: PROVIDERS,
        capabilities: {
            batchVerification: capabilities.batchVerification.configured,
            imageVerification: capabilities.imageVerification.configured,
            hostedCommerce: capabilities.hostedCommerce.configured,
        },
    });
});

export default router;
