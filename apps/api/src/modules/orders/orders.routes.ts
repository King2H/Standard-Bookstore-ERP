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
router.post('/orders/:id/cancel', authenticate, inBranch, requirePermission('CREATE_SALE'), validate(schemas.cancel), orders.cancel);
router.post(
  '/orders/:id/collect-payment',
  authenticate,
  inBranch,
  requireRole('Admin', 'Manager', 'Finance_Officer'),
  validate(schemas.collectPayment),
  orders.collectPayment,
);

// Legacy endpoints (#69).
router.post('/orders/:id/progress', authenticate, inBranch, requireRole('Manager', 'Admin', 'Stock_Clerk'), validate(schemas.byId), orders.progress);
router.post('/orders/:id/pay', authenticate, inBranch, requirePermission('PROCESS_PAYMENT'), () => {
  throw new AppError(
    'DEPRECATED',
    'POST /orders/:id/pay is no longer supported. Use POST /payments to record payments against an order.',
    410,
  );
});

export default router;
