import { Router } from 'express';
import { authenticate } from '../../../middleware/auth.js';
import { requirePermission } from '../../../middleware/rbac.js';
import { validate } from '../../../middleware/validate.js';
import * as sales from './sales.controller.js';

// URL -> middleware -> controller (A2). Contracts are in @bms/shared
// (report.ts) and listed in src/openapi/operations.ts.

const router = Router();
const reportAccess = [authenticate, requirePermission('VIEW_REPORTS'), validate(sales.schemas.report)];

router.get('/reports/sales', ...reportAccess, sales.report);
router.get('/reports/sales/detail', ...reportAccess, sales.detail);
router.get('/reports/sales/export', ...reportAccess, sales.exportCsv);
router.get('/reports/sales/gross-profit-trend', ...reportAccess, sales.grossProfitTrend);

export default router;
