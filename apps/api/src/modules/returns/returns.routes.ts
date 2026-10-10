import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { recordInBranch } from '../../middleware/recordScope.js';
import { validate } from '../../middleware/validate.js';
import * as returns from './returns.controller.js';

// URL -> middleware -> controller (A2). Request and response contracts are in
// @bms/shared (return.ts) and listed in src/openapi/operations.ts.

const router = Router();
const { schemas } = returns;

const canSee = requireRole('Admin', 'Manager', 'Finance_Officer', 'Sales');

router.post('/returns', authenticate, requireRole('Sales', 'Manager', 'Admin'), validate(schemas.create), returns.create);
router.get('/returns', authenticate, canSee, validate(schemas.list), returns.list);
router.get('/returns/:id', authenticate, recordInBranch('return'), canSee, validate(schemas.byId), returns.getById);
router.post('/returns/:id/reject', authenticate, requireRole('Manager', 'Admin'), returns.rejectRetired);

export default router;
