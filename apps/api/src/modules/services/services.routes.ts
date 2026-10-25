import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import * as services from './services.controller.js';

// URL -> middleware -> controller (A2). Request and response contracts are in
// @bms/shared (service.ts) and listed in src/openapi/operations.ts.

const router = Router();
const { schemas } = services;

// Fees and costs are prices: Admin and Manager (owner decision 1a, #169).
// Every signed-in role reads the list, as the catalog is read.
const canManage = requireRole('Admin', 'Manager');

router.get('/services', authenticate, validate(schemas.list), services.list);
router.post('/services', authenticate, canManage, validate(schemas.create), services.create);
router.get('/services/:id', authenticate, validate(schemas.byId), services.getById);
router.put('/services/:id', authenticate, canManage, validate(schemas.update), services.update);
router.post('/services/:id/activate', authenticate, canManage, validate(schemas.byId), services.transition('ACTIVATE'));
router.post('/services/:id/deactivate', authenticate, canManage, validate(schemas.byId), services.transition('INACTIVATE'));
router.post('/services/:id/archive', authenticate, canManage, validate(schemas.byId), services.transition('ARCHIVE'));
router.post('/services/:id/restore', authenticate, canManage, validate(schemas.byId), services.transition('RESTORE'));
router.put('/services/:id/branch-fee', authenticate, canManage, validate(schemas.branchFee), services.setBranchFee);
router.delete('/services/:id/branch-fee', authenticate, canManage, validate(schemas.byId), services.removeBranchFee);

export default router;
