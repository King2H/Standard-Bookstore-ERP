import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import * as staff from './staff.controller.js';

// URL -> middleware -> controller (A2). Request and response contracts are in
// @bms/shared (staff.ts) and listed in src/openapi/operations.ts. Which staff
// each caller sees and changes is decided in staff.policy.ts (owner decisions
// 1a–3a); the signed-in staff member's own account is under /staff/me
// (modules/auth).

const router = Router();
const { schemas } = staff;

// Managers see their branch's staff and change roles there.
const canSee = requireRole('Super_Admin', 'Admin', 'Manager');
const admins = requireRole('Super_Admin', 'Admin');

router.get('/staff', authenticate, canSee, validate(schemas.list), staff.list);
router.post('/staff', authenticate, admins, validate(schemas.create), staff.create);
router.get('/staff/:id', authenticate, canSee, validate(schemas.byId), staff.getById);
router.put('/staff/:id', authenticate, admins, validate(schemas.update), staff.update);
router.put('/staff/:id/roles', authenticate, canSee, validate(schemas.roles), staff.setRoles);
router.put('/staff/:id/all-branches', authenticate, requireRole('Super_Admin'), validate(schemas.allBranches), staff.setAllBranches);
router.post('/staff/:id/deactivate', authenticate, admins, validate(schemas.byId), staff.deactivate);
router.post('/staff/:id/reactivate', authenticate, admins, validate(schemas.byId), staff.reactivate);
router.post('/staff/:id/reset-password', authenticate, admins, validate(schemas.resetPassword), staff.resetPassword);
router.post('/staff/:id/unlock', authenticate, admins, validate(schemas.byId), staff.unlock);

export default router;
