import { Router } from 'express';
import { authenticate } from '../../../middleware/auth.js';
import { requirePermission } from '../../../middleware/rbac.js';
import { validate } from '../../../middleware/validate.js';
import * as returns from './returnReports.controller.js';

// URL -> middleware -> controller (A2). Contracts are in @bms/shared
// (report.ts) and listed in src/openapi/operations.ts.

const router = Router();
const reportAccess = [authenticate, requirePermission('VIEW_REPORTS')];

router.get('/reports/returns', ...reportAccess, validate(returns.schemas.report), returns.report);
router.get('/reports/returns/top', ...reportAccess, validate(returns.schemas.top), returns.top);
router.get('/reports/returns/export', ...reportAccess, validate(returns.schemas.report), returns.exportCsv);

export default router;
