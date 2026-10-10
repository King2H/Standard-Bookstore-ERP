import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { recordInBranch } from '../../middleware/recordScope.js';
import { validate } from '../../middleware/validate.js';
import * as payments from './payments.controller.js';

// URL -> middleware -> controller (A2). Request and response contracts are in
// @bms/shared (payment.ts) and listed in src/openapi/operations.ts.

const router = Router();
const { schemas } = payments;

// Payments are seen by the roles that take them (owner decision 3a);
// refunds are for Manager, Admin and Finance_Officer.
const canTake = requireRole('Sales', 'Manager', 'Admin', 'Finance_Officer');
const canRefund = requireRole('Manager', 'Admin', 'Finance_Officer');
const byId = validate(schemas.byId);

router.get('/payments/unpaid-orders', authenticate, canTake, validate(schemas.unpaid), payments.listUnpaid);
router.post('/payments', authenticate, canTake, validate(schemas.create), payments.create);
router.get('/payments', authenticate, canTake, validate(schemas.list), payments.list);
router.get('/payments/:id', authenticate, recordInBranch('payment'), canTake, byId, payments.getById);
router.post('/payments/:id/refund', authenticate, recordInBranch('payment'), canRefund, validate(schemas.refund), payments.refund);
router.get('/payments/:id/refunds', authenticate, recordInBranch('payment'), canTake, byId, payments.refundsOf);
router.get('/orders/:id/payments', authenticate, recordInBranch('order'), canTake, byId, payments.listByOrder);
router.get('/orders/:id/balance', authenticate, recordInBranch('order'), canTake, byId, payments.orderBalance);

// Installment plans: retired.
router.post('/orders/:id/installment-plan', authenticate, payments.installmentsRetired);
router.get('/orders/:id/installment-plan', authenticate, payments.installmentsRetired);
router.get('/installment-plans/:id', authenticate, payments.installmentsRetired);
router.post('/installments/:id/pay', authenticate, payments.installmentsRetired);

export default router;
