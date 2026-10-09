import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { branchParamInScope } from '../../middleware/recordScope.js';
import { validate } from '../../middleware/validate.js';
import * as config from './config.controller.js';

// URL -> middleware -> controller (A2). Request and response contracts are in
// @bms/shared (config.ts) and listed in src/openapi/operations.ts.

const router = Router();

const canRead = requireRole('Super_Admin', 'Admin', 'Manager');
const { schemas } = config;

router.get('/config/system', authenticate, canRead, config.listSystem);
router.put('/config/system/:key', authenticate, requireRole('Super_Admin'), validate(schemas.setSystem), config.setSystem);

// Any signed-in staff member, for their session branch (POS, Orders, ...).
router.get('/config/currency', authenticate, config.currency);
router.get('/config/effective', authenticate, validate(schemas.effective), config.effective);

// A branch's settings: the session branch, or any branch with access to all branches (#77).
router.get('/config/branches/:branchId', authenticate, branchParamInScope, canRead, validate(schemas.branch), config.listBranch);
router.put(
  '/config/branches/:branchId/:key',
  authenticate,
  branchParamInScope,
  canRead,
  validate(schemas.setBranch),
  config.setBranch,
);
router.delete(
  '/config/branches/:branchId/:key',
  authenticate,
  branchParamInScope,
  requireRole('Super_Admin', 'Admin'),
  validate(schemas.removeBranch),
  config.removeBranch,
);

export default router;
