import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import * as customer from './customer.controller.js';

// URL -> middleware -> controller (A2). Request and response contracts are in
// @bms/shared (customer.ts) and listed in src/openapi/operations.ts.

const router = Router();
const { schemas } = customer;

const canEdit = requireRole('Admin', 'Manager', 'Sales');
const canManage = requireRole('Admin', 'Manager');
// Manual loyalty and store-credit changes are back-office corrections with a
// reason; at checkout customers spend both as a payment (owner decision, #21).
const canCorrectBalances = requireRole('Admin', 'Manager', 'Finance_Officer');

// Customers are shared by every branch; any signed-in staff member may look them up.
router.get('/customers', authenticate, validate(schemas.list), customer.list);
router.post('/customers', authenticate, canEdit, validate(schemas.create), customer.create);
router.get('/customers/:id', authenticate, validate(schemas.byId), customer.get);
router.put('/customers/:id', authenticate, canEdit, validate(schemas.update), customer.update);
router.post('/customers/:id/deactivate', authenticate, canManage, validate(schemas.byId), customer.deactivate);

router.get('/customer-groups', authenticate, customer.listGroups);
router.post('/customer-groups', authenticate, canManage, validate(schemas.createGroup), customer.createGroup);

router.get('/customers/:id/loyalty', authenticate, validate(schemas.byId), customer.loyalty);
router.get('/customers/:id/loyalty/history', authenticate, validate(schemas.history), customer.loyaltyHistory);
router.post('/customers/:id/loyalty/redeem', authenticate, canCorrectBalances, validate(schemas.redeem), customer.redeem);

router.get('/customers/:id/store-credit', authenticate, validate(schemas.byId), customer.storeCredit);
router.get('/customers/:id/store-credit/history', authenticate, validate(schemas.history), customer.storeCreditHistory);
router.post(
  '/customers/:id/store-credit/adjust',
  authenticate,
  canCorrectBalances,
  validate(schemas.adjust),
  customer.adjustStoreCredit,
);

export default router;
