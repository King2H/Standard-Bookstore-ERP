import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import * as specialOrders from './specialOrders.controller.js';

// URL -> middleware -> controller (A2). Contracts in @bms/shared
// (specialOrder.ts), listed in src/openapi/operations.ts. Lines are added to
// a purchase order under /purchase-orders/:id/special-orders.

const router = Router();

// The roles that buy (#174, decision 3a), as for purchase orders.
const buyers = requireRole('Admin', 'Manager', 'Purchasor');

router.get('/special-orders', authenticate, buyers, validate(specialOrders.schemas.list), specialOrders.list);

export default router;
