import { Router, Request, Response } from 'express';
import { verifyCBE } from '../services/verifyCBE';
import logger from '../utils/logger';
import { validateCbeRequest } from '../middleware/validateCbeRequest';

const router = Router();
router.use(validateCbeRequest);

interface VerifyRequestBody {
    reference: string;
    accountSuffix?: string;
}

function normalizeCBEReference(reference: string): string {
    return reference.trim();
}

router.post('/', async function (
    req: Request<{}, {}, VerifyRequestBody>,
    res: Response
): Promise<void> {
    const { reference, accountSuffix } = req.body;

    const normalizedReference = normalizeCBEReference(reference);
    const trimmedSuffix = typeof accountSuffix === 'string' ? accountSuffix.trim() : undefined;

    try {
        const result = await verifyCBE(normalizedReference, trimmedSuffix);
        if (!result.success) {
            res.status(result.statusCode ?? 422).json(result);
            return;
        }
        res.json(result);
    } catch (err) {
        logger.error("💥 Payment verification failed:", err);
        res.status(500).json({ success: false, error: 'Server error verifying payment.' });
    }
});

router.get('/', async function(
    req: Request<{}, {}, {}, { reference?: string; accountSuffix?: string }>,
    res: Response
): Promise<void> {
    const { reference, accountSuffix } = req.query;

    const normalizedReference = normalizeCBEReference(reference as string);
    const trimmedSuffix = typeof accountSuffix === 'string' ? accountSuffix.trim() : undefined;

    try {
        const result = await verifyCBE(normalizedReference, trimmedSuffix);
        if (!result.success) {
            res.status(result.statusCode ?? 422).json(result);
            return;
        }
        res.json(result);
    } catch (err) {
        logger.error(err);
        res.status(500).json({ success: false, error: 'Server error verifying payment.' });
    }
});

export default router;
