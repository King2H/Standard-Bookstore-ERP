import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission, requireRole } from '../../middleware/rbac.js';
import { recordInBranch } from '../../middleware/recordScope.js';
import { validate } from '../../middleware/validate.js';
import * as pos from './pos.controller.js';

// URL -> middleware -> controller (A2). Request and response contracts are in
// @bms/shared (pos.ts) and listed in src/openapi/operations.ts.

const router = Router();
const { schemas } = pos;

// Sales history is for the roles that sell, take returns or collect (owner
// decision 3a). Super_Admin, a governance-only role, does not sell.
const canSee = requireRole('Sales', 'Manager', 'Admin', 'Finance_Officer');
const inBranch = recordInBranch('posTransaction');

router.post('/pos/transactions', authenticate, requirePermission('CREATE_SALE'), validate(schemas.create), pos.create);
router.get('/pos/transactions', authenticate, canSee, validate(schemas.list), pos.list);
router.get('/pos/transactions/:id', authenticate, inBranch, canSee, validate(schemas.byId), pos.getById);
router.post('/pos/transactions/:id/payment', authenticate, inBranch, canSee, validate(schemas.collect), pos.collect);
router.post('/pos/transactions/:id/void', authenticate, inBranch, requireRole('Manager', 'Admin'), validate(schemas.byId), pos.voidTransaction);

export default router;
