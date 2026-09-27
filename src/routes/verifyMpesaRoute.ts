import { Router } from 'express';
import { createVerificationPipeline } from '../middleware/verificationPipeline';

// Compatibility URL/envelope only; verification policy and dispatch are shared.
const router = Router();
router.route('/').post(...createVerificationPipeline({ provider: 'mpesa', envelope: 'legacy' }))
  .get(...createVerificationPipeline({ provider: 'mpesa', envelope: 'legacy' }));
export default router;
