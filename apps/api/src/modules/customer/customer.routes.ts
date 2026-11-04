import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireAnyPermission, requireRole } from '../../middleware/rbac.js';
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
// Customers are read by whoever sells or takes payments (#234, decision 3a;
// was: any signed-in account). The stockroom sees a special order's customer
// on the special order itself.
const canRead = requireAnyPermission('CREATE_SALE', 'PROCESS_PAYMENT');

// Customers are shared by every branch.
router.get('/customers', authenticate, canRead, validate(schemas.list), customer.list);
router.post('/customers', authenticate, canEdit, validate(schemas.create), customer.create);
router.get('/customers/:id', authenticate, canRead, validate(schemas.byId), customer.get);
router.put('/customers/:id', authenticate, canEdit, validate(schemas.update), customer.update);
router.post('/customers/:id/deactivate', authenticate, canManage, validate(schemas.byId), customer.deactivate);
router.post('/customers/:id/activate', authenticate, canManage, validate(schemas.byId), customer.activate);
router.post('/customers/:id/archive', authenticate, canManage, validate(schemas.byId), customer.archive);
router.post('/customers/:id/restore', authenticate, canManage, validate(schemas.byId), customer.restore);

router.get('/customer-groups', authenticate, canRead, customer.listGroups);
router.post('/customer-groups', authenticate, canManage, validate(schemas.createGroup), customer.createGroup);

router.get('/customers/:id/loyalty', authenticate, canRead, validate(schemas.byId), customer.loyalty);
router.get('/customers/:id/loyalty/history', authenticate, canRead, validate(schemas.history), customer.loyaltyHistory);
router.post('/customers/:id/loyalty/redeem', authenticate, canCorrectBalances, validate(schemas.redeem), customer.redeem);

router.get('/customers/:id/store-credit', authenticate, canRead, validate(schemas.byId), customer.storeCredit);
router.get('/customers/:id/store-credit/history', authenticate, canRead, validate(schemas.history), customer.storeCreditHistory);
router.post(
  '/customers/:id/store-credit/adjust',
  authenticate,
  canCorrectBalances,
  validate(schemas.adjust),
  customer.adjustStoreCredit,
);

export default router;
