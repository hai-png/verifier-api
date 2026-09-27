import { Router } from 'express';
import { createVerificationPipeline } from '../middleware/verificationPipeline';
import { MemoryWindowCounter } from '../utils/expiringStore';
import { getRequestIp } from '../utils/requestIp';

const router = Router();
const publicThrottle = new MemoryWindowCounter();
router.post('/public', (req, res, next) => {
  const entry = publicThrottle.increment(getRequestIp(req), 60 * 60 * 1000);
  if (entry.count > 10) {
    res.status(429).json({ success: false, error: 'Public verification limit reached. Create a workspace for higher limits.' });
    return;
  }
  next();
}, ...createVerificationPipeline({ public: true }));
router.post('/', ...createVerificationPipeline());
export default router;
