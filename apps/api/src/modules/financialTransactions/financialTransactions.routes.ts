import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import * as ledger from './financialTransactions.controller.js';

// URL -> middleware -> controller (A2). Request and response contracts are in
// @bms/shared (financialTransaction.ts) and listed in src/openapi/operations.ts.

const router = Router();

router.get(
  '/financial-transactions',
  authenticate,
  requirePermission('VIEW_REPORTS'),
  validate(ledger.schemas.list),
  ledger.list,
);
router.post('/financial-transactions', authenticate, requirePermission('PROCESS_PAYMENT'), ledger.create);

export default router;
