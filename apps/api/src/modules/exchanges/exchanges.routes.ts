import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission, requireRole } from '../../middleware/rbac.js';
import { recordInBranch } from '../../middleware/recordScope.js';
import { validate } from '../../middleware/validate.js';
import * as exchanges from './exchanges.controller.js';

// URL -> middleware -> controller (A2). Request and response contracts are in
// @bms/shared (exchange.ts) and listed in src/openapi/operations.ts.

const router = Router();
const { schemas } = exchanges;

// Exchanges are sales: seen by the roles that sell, take returns or collect, like POS.
const canSee = requireRole('Sales', 'Manager', 'Admin', 'Finance_Officer');
const inBranch = recordInBranch('exchange');

router.post('/exchanges', authenticate, requirePermission('CREATE_SALE'), validate(schemas.create), exchanges.create);
router.get('/exchanges', authenticate, canSee, validate(schemas.list), exchanges.list);
router.get('/exchanges/:id', authenticate, inBranch, canSee, validate(schemas.byId), exchanges.getById);
router.post('/exchanges/:id/void', authenticate, inBranch, requireRole('Manager', 'Admin'), validate(schemas.void), exchanges.voidExchange);

// The lifecycle flow is retired (owner decision 1a).
router.post('/exchanges/initiate', authenticate, exchanges.lifecycleRetired);
for (const action of ['review', 'approve', 'settle', 'cancel']) {
  router.post(`/exchanges/:id/${action}`, authenticate, exchanges.lifecycleRetired);
}

export default router;
