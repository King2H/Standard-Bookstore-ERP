import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireRole, requirePermission } from '../../middleware/rbac.js';
import { recordInBranch } from '../../middleware/recordScope.js';
import { validate } from '../../middleware/validate.js';
import { AppError } from '../../lib/errors.js';
import * as orders from './orders.controller.js';

// URL -> middleware -> controller (A2). Request and response contracts are in
// @bms/shared (order.ts) and listed in src/openapi/operations.ts.

const router = Router();
const { schemas } = orders;
const inBranch = recordInBranch('order');

router.get('/orders', authenticate, validate(schemas.list), orders.list);
router.post('/orders', authenticate, requirePermission('CREATE_SALE'), validate(schemas.create), orders.create);
router.get('/orders/:id', authenticate, inBranch, validate(schemas.byId), orders.get);
// Admin-only cleanup of Draft and Cancelled orders without history.
router.delete('/orders/:id', authenticate, inBranch, requireRole('Admin'), validate(schemas.byId), orders.remove);

router.post('/orders/:id/confirm', authenticate, inBranch, requirePermission('CREATE_SALE'), validate(schemas.confirm), orders.confirm);
router.post('/orders/:id/fulfill', authenticate, inBranch, requirePermission('PROCESS_PAYMENT'), validate(schemas.byId), orders.fulfill);
// Whoever sells cancels an unpaid order; whoever refunds one that took payments (#167, orders.policy.ts).
router.post('/orders/:id/cancel', authenticate, inBranch, validate(schemas.cancel), orders.cancel);

// Retired endpoints answer 410 (#69). Payments, part payments of a credit
// order included, are recorded with POST /payments, which keeps the payment,
// its method and the ledger entry together with the receivable.
function retired(endpoint: string, instead: string) {
  return () => {
    throw new AppError('DEPRECATED', `${endpoint} is no longer supported. ${instead}`, 410);
  };
}
const usePayments = 'Use POST /payments to record payments against an order.';
router.post('/orders/:id/pay', authenticate, inBranch, requirePermission('PROCESS_PAYMENT'), retired('POST /orders/:id/pay', usePayments));
router.post(
  '/orders/:id/collect-payment',
  authenticate,
  inBranch,
  requireRole('Admin', 'Manager', 'Finance_Officer'),
  retired('POST /orders/:id/collect-payment', usePayments),
);
router.post(
  '/orders/:id/progress',
  authenticate,
  inBranch,
  requireRole('Manager', 'Admin', 'Stock_Clerk'),
  retired('POST /orders/:id/progress', 'A confirmed order goes straight to POST /orders/:id/fulfill.'),
);

export default router;
