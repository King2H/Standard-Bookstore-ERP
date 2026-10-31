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
// A draft is edited until it is confirmed, by whoever sells (#174, decision 1a).
router.put('/orders/:id', authenticate, inBranch, requirePermission('CREATE_SALE'), validate(schemas.update), orders.update);
// Admin-only cleanup of Draft and Cancelled orders without history.
router.delete('/orders/:id', authenticate, inBranch, requireRole('Admin'), validate(schemas.byId), orders.remove);

router.post('/orders/:id/confirm', authenticate, inBranch, requirePermission('CREATE_SALE'), validate(schemas.confirm), orders.confirm);
// Delivered in parts, each numbered DLV-, by whoever fulfils (#174, decision 2a).
router.post('/orders/:id/deliveries', authenticate, inBranch, requirePermission('PROCESS_PAYMENT'), validate(schemas.deliver), orders.deliver);
router.post('/orders/:id/fulfill', authenticate, inBranch, requirePermission('PROCESS_PAYMENT'), validate(schemas.byId), orders.fulfill);
// One that took payments also needs PROCESS_REFUND: the money goes back in the same step (#167, orders.policy.ts).
router.post('/orders/:id/cancel', authenticate, inBranch, requirePermission('CREATE_SALE'), validate(schemas.cancel), orders.cancel);
// A special-order line's copies brought to the order's location are reserved for it, by whoever sells (#174).
router.post('/orders/:id/lines/:lineId/reserve', authenticate, inBranch, requirePermission('CREATE_SALE'), validate(schemas.reserveLine), orders.reserveLine);
// What a part-delivered order will not deliver, by the same rule (#174, decision 3a).
router.post('/orders/:id/cancel-rest', authenticate, inBranch, requirePermission('CREATE_SALE'), validate(schemas.cancelRest), orders.cancelRest);

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
