import { Router } from 'express';
import { authenticate, authenticateAllowingPasswordChange } from '../../middleware/auth.js';
import { loginRateLimit } from '../../middleware/rateLimit.js';
import { validate } from '../../middleware/validate.js';
import * as auth from './auth.controller.js';

// URL -> middleware -> controller (A2). Request and response contracts are in
// @bms/shared (auth.ts) and listed in src/openapi/operations.ts. Staff
// administration is in modules/staff.

const router = Router();
const { schemas } = auth;

// Signing in: pre-login checks the password and lists the branches, login opens the session.
router.post('/auth/pre-login', loginRateLimit, validate(schemas.preLogin), auth.preLogin);
router.post('/auth/login', loginRateLimit, validate(schemas.login), auth.login);
router.post('/auth/refresh', auth.refresh);
router.post('/auth/logout', authenticateAllowingPasswordChange, auth.logout);
router.get('/auth/branches', authenticateAllowingPasswordChange, auth.branches);
router.post('/auth/switch-branch', authenticate, validate(schemas.switchBranch), auth.switchBranch);

// The signed-in staff member; usable while a password change is pending (#38).
router.get('/staff/me', authenticateAllowingPasswordChange, auth.profile);
router.put('/staff/me/password', authenticateAllowingPasswordChange, validate(schemas.changePassword), auth.changePassword);

export default router;
