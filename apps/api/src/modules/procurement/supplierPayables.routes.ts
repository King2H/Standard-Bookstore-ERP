import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { recordInBranch } from '../../middleware/recordScope.js';
import { validate } from '../../middleware/validate.js';
import * as payables from './supplierPayables.controller.js';

// URL -> middleware -> controller (A2). Request and response contracts are in
// @bms/shared (purchaseOrder.ts) and listed in src/openapi/operations.ts.
// Only the ordering branch pays (procurement.policy, owner decision 1a).

const router = Router();
const { schemas } = payables;

const finance = requireRole('Admin', 'Manager', 'Finance_Officer');
const ledgerReaders = requireRole('Admin', 'Manager', 'Finance_Officer', 'Purchasor');
const inBranch = recordInBranch('purchaseOrder');

router.post('/purchase-orders/:id/payments', authenticate, inBranch, finance, validate(schemas.payment), payables.recordPayment);
router.post(
  '/purchase-orders/:id/payments/:paymentId/reverse',
  authenticate,
  inBranch,
  finance,
  validate(schemas.reverse),
  payables.reversePayment,
);
router.post('/purchase-orders/:id/credit-notes', authenticate, inBranch, finance, validate(schemas.creditNote), payables.recordCreditNote);
router.get('/suppliers/:id/ledger', authenticate, ledgerReaders, validate(schemas.ledger), payables.ledger);
router.get('/suppliers/:id/ledger/export', authenticate, ledgerReaders, validate(schemas.ledger), payables.exportLedger);

export default router;
