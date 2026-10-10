import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { recordInBranch } from '../../middleware/recordScope.js';
import { validate } from '../../middleware/validate.js';
import * as po from './procurement.controller.js';

// URL -> middleware -> controller (A2). Request and response contracts are in
// @bms/shared (purchaseOrder.ts) and listed in src/openapi/operations.ts.
// Which branch may do what (ordering or receiving) is procurement.policy's.

const router = Router();
const { schemas } = po;

const canSee = requireRole('Admin', 'Manager', 'Purchasor', 'Stock_Clerk', 'Finance_Officer');
const buyers = requireRole('Admin', 'Manager', 'Purchasor');
const approvers = requireRole('Admin', 'Manager');
const inBranch = recordInBranch('purchaseOrder');

router.get('/purchase-orders', authenticate, canSee, validate(schemas.list), po.list);
router.post('/purchase-orders', authenticate, buyers, validate(schemas.create), po.create);
router.get('/purchase-orders/:id', authenticate, inBranch, canSee, validate(schemas.byId), po.getById);
router.put('/purchase-orders/:id', authenticate, inBranch, buyers, validate(schemas.update), po.update);
router.post('/purchase-orders/:id/submit', authenticate, inBranch, buyers, validate(schemas.byId), po.submit);
router.post('/purchase-orders/:id/approve', authenticate, inBranch, approvers, validate(schemas.byId), po.approve);
router.post('/purchase-orders/:id/order', authenticate, inBranch, buyers, validate(schemas.byId), po.markAsOrdered);
router.post(
  '/purchase-orders/:id/receive',
  authenticate,
  inBranch,
  requireRole('Admin', 'Manager', 'Stock_Clerk'),
  validate(schemas.receive),
  po.receive,
);
router.post('/purchase-orders/:id/close', authenticate, inBranch, approvers, validate(schemas.close), po.close);
router.post('/purchase-orders/:id/cancel', authenticate, inBranch, buyers, validate(schemas.byId), po.cancel);

export default router;
