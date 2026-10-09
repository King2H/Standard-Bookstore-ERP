import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import * as audit from './audit.controller.js';

// URL -> middleware -> controller (A2). Request and response contracts are in
// @bms/shared (audit.ts) and listed in src/openapi/operations.ts.

const router = Router();

router.get('/audit-logs', authenticate, requireRole('Super_Admin', 'Admin'), validate(audit.schemas.list), audit.list);

export default router;
