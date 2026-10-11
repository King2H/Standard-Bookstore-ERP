import { Router } from 'express';
import { authenticate } from '../../../middleware/auth.js';
import { requirePermission } from '../../../middleware/rbac.js';
import { validate } from '../../../middleware/validate.js';
import * as kpis from './kpis.controller.js';

// URL -> middleware -> controller (A2). Contracts are in @bms/shared
// (report.ts) and listed in src/openapi/operations.ts.

const router = Router();
const reportAccess = [authenticate, requirePermission('VIEW_REPORTS')];

router.get('/reports/kpis', ...reportAccess, validate(kpis.schemas.kpis), kpis.kpis);
router.get('/reports/kpis/period', ...reportAccess, validate(kpis.schemas.period), kpis.period);

export default router;
