import { Router } from 'express';
import { createVerificationPipeline } from '../middleware/verificationPipeline';

// Compatibility URL/envelope only; verification policy and dispatch are shared.
const router = Router();
router.route('/').post(...createVerificationPipeline({ provider: 'cbe', envelope: 'legacy' }))
  .get(...createVerificationPipeline({ provider: 'cbe', envelope: 'legacy' }));
export default router;
