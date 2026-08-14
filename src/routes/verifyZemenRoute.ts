import { Router, Request, Response } from 'express';
import { verifyZemen } from '../services/verifyZemen';
import logger from '../utils/logger';

const router = Router();

interface VerifyRequestBody {
    reference: string;
}

// POST /verify-zemen
router.post('/', async function (
    req: Request<{}, {}, VerifyRequestBody>,
    res: Response
): Promise<void> {
    const { reference } = req.body;

    if (!reference) {
        res.status(400).json({
            success: false,
            error: 'Transaction reference is required'
        });
        return;
    }

    try {
        logger.info(`🔍 Verifying Zemen transaction: ${reference}`);
        const result = await verifyZemen(reference);

        if (result.success) {
            logger.info(`✅ Zemen verification successful for: ${reference}`);
        } else {
            logger.warn(`❌ Zemen verification failed for: ${reference} - ${result.error}`);
        }

        res.json(result);
    } catch (error: any) {
        logger.error(`💥 Zemen verification error for ${reference}:`, error.message);
        res.status(500).json({
            success: false,
            error: 'Internal server error during verification'
        });
    }
});

// GET /verify-zemen (for testing with query parameters)
router.get('/', async function(
    req: Request<{}, {}, {}, { reference?: string }>,
    res: Response
): Promise<void> {
    const { reference } = req.query;

    if (!reference || typeof reference !== 'string') {
        res.status(400).json({
            success: false,
            error: 'Transaction reference is required as query parameter'
        });
        return;
    }

    try {
        logger.info(`🔍 Verifying Zemen transaction (GET): ${reference}`);
        const result = await verifyZemen(reference);

        if (result.success) {
            logger.info(`✅ Zemen verification successful for: ${reference}`);
        } else {
            logger.warn(`❌ Zemen verification failed for: ${reference} - ${result.error}`);
        }

        res.json(result);
    } catch (error: any) {
        logger.error(`💥 Zemen verification error for ${reference}:`, error.message);
        res.status(500).json({
            success: false,
            error: 'Internal server error during verification'
        });
    }
});

export default router;
