import { Router, Request, Response } from 'express';
import { runSmartVerify } from '../services/verifyUniversal';
import logger from '../utils/logger';

const router = Router();

interface UniversalVerifyBody {
    reference: string;
    suffix?: string;
    phoneNumber?: string;
}

// ─── Public verification (browser-safe, no API key) ──────────────────────────
// Per-IP throttled, quota-free, and webhook-free (verifyWebhookHook only fires
// on exact verify paths). For regular/hosted use, authenticate with x-api-key.
const PUBLIC_WINDOW_MS = 60 * 60 * 1000;
const PUBLIC_MAX_PER_WINDOW = 10;
const publicThrottle = new Map<string, { count: number; windowStart: number }>();

function publicAllowed(ip: string): boolean {
    const now = Date.now();
    const entry = publicThrottle.get(ip);
    if (!entry || now - entry.windowStart > PUBLIC_WINDOW_MS) {
        publicThrottle.set(ip, { count: 1, windowStart: now });
        return true;
    }
    entry.count += 1;
    return entry.count <= PUBLIC_MAX_PER_WINDOW;
}

function requestIp(req: Request): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
        return forwarded.split(',')[0].trim();
    }
    return req.socket.remoteAddress ?? 'unknown';
}

router.post('/public', async (req: Request<{}, {}, UniversalVerifyBody>, res: Response): Promise<void> => {
    const { reference, suffix, phoneNumber } = req.body;

    if (!reference || typeof reference !== 'string') {
        res.status(400).json({ success: false, error: 'Missing or invalid reference.' });
        return;
    }

    if (!publicAllowed(requestIp(req))) {
        res.status(429).json({
            success: false,
            error: 'Public verification limit reached. Create a workspace for higher limits.',
        });
        return;
    }

    const result = await runSmartVerify({
        reference,
        suffix: typeof suffix === 'string' ? suffix : undefined,
        phoneNumber: typeof phoneNumber === 'string' ? phoneNumber : undefined,
    });

    if (!result.success) {
        logger.warn(`Public verify failed [${result.httpStatus}]: ${result.error}`);
        res.status(result.httpStatus).json({
            success: false,
            error: result.error,
            ...(result.details ? { details: result.details } : {}),
        });
        return;
    }

    const responseBody = (result.data as any)?.success !== undefined
        ? result.data
        : { success: true, data: result.data };

    res.json(responseBody);
});

router.post('/', async (req: Request<{}, {}, UniversalVerifyBody>, res: Response): Promise<void> => {
    const { reference, suffix, phoneNumber } = req.body;

    if (!reference || typeof reference !== 'string') {
        res.status(400).json({ success: false, error: 'Missing or invalid reference.' });
        return;
    }

    // Pull raw key for CBE Birr (needs it to authenticate sub-requests)
    const apiKey = req.headers['x-api-key'] as string | undefined
        ?? req.headers.authorization?.replace('Bearer ', '');

    const result = await runSmartVerify({ reference, suffix, phoneNumber, apiKey });

    if (!result.success) {
        logger.warn(`Universal verify failed [${result.httpStatus}]: ${result.error}`);
        res.status(result.httpStatus).json({
            success: false,
            error: result.error,
            ...(result.details ? { details: result.details } : {}),
        });
        return;
    }

    // Telebirr wraps its result in { success, data } already; other providers return the object directly.
    // Preserve existing response shape: if data has a `success` field, forward as-is, otherwise wrap.
    const responseBody = (result.data as any)?.success !== undefined
        ? result.data
        : { success: true, data: result.data };

    res.json(responseBody);
});

export default router;
