import { Router } from 'express';
import { AppError } from '../../lib/errors.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import * as branch from './branch.controller.js';

// URL -> middleware -> controller (A2). Request and response contracts are in
// @bms/shared (branch.ts) and listed in src/openapi/operations.ts.

const router = Router();

const { schemas } = branch;
// The service narrows these further: opening, closing and deleting a branch
// need Super_Admin or an Admin with access to all branches; details are
// edited from the branch itself unless the caller has access to all branches.
const canEdit = requireRole('Super_Admin', 'Admin', 'Manager');
const canOpenOrClose = requireRole('Super_Admin', 'Admin');

// Retired (#13): it listed branches to anyone, before sign-in, which no
// longer means anything when branches belong to tenants; the web app never
// used it. Sign-in lists the account's branches after the password check
// (POST /auth/pre-login).
router.get('/branches/public', () => {
  throw new AppError('DEPRECATED', 'GET /branches/public is no longer supported. POST /auth/pre-login lists the branches to sign in to.', 410);
});

router.get('/branches', authenticate, validate(schemas.list), branch.list);
router.get('/branches/:id', authenticate, validate(schemas.byId), branch.get);
router.post('/branches', authenticate, canOpenOrClose, validate(schemas.create), branch.create);
router.put('/branches/:id', authenticate, canEdit, validate(schemas.update), branch.update);
router.post('/branches/:id/deactivate', authenticate, canOpenOrClose, validate(schemas.byId), branch.deactivate);
router.post('/branches/:id/reactivate', authenticate, canOpenOrClose, validate(schemas.byId), branch.reactivate);
router.delete('/branches/:id', authenticate, canOpenOrClose, validate(schemas.byId), branch.remove);

export default router;
