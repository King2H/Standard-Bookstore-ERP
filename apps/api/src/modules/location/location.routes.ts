import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { branchParamInScope } from '../../middleware/recordScope.js';
import { validate } from '../../middleware/validate.js';
import * as location from './location.controller.js';

// URL -> middleware -> controller (A2). Request and response contracts are in
// @bms/shared (location.ts) and listed in src/openapi/operations.ts.

const router = Router();

const canManage = requireRole('Super_Admin', 'Admin', 'Manager');
const { schemas } = location;

// Any signed-in staff member may list any branch's locations (transfers,
// purchase-order receiving); changes need the branch in scope.
router.get('/branches/:branchId/locations', authenticate, validate(schemas.branch), location.list);
router.post(
  '/branches/:branchId/locations',
  authenticate,
  branchParamInScope,
  canManage,
  validate(schemas.create),
  location.create,
);
router.put(
  '/branches/:branchId/locations/:id',
  authenticate,
  branchParamInScope,
  canManage,
  validate(schemas.rename),
  location.rename,
);
router.put(
  '/branches/:branchId/locations/:id/set-default',
  authenticate,
  branchParamInScope,
  canManage,
  validate(schemas.byId),
  location.setDefault,
);
router.delete(
  '/branches/:branchId/locations/:id',
  authenticate,
  branchParamInScope,
  canManage,
  validate(schemas.byId),
  location.remove,
);

// A staff member's location restrictions; empty means every location of their branches.
router.get('/staff/:id/locations', authenticate, canManage, validate(schemas.staff), location.listForStaff);
router.put('/staff/:id/locations', authenticate, canManage, validate(schemas.setStaff), location.setForStaff);

export default router;
