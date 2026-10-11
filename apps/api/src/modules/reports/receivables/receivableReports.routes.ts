import { Router } from 'express';
import { authenticate } from '../../../middleware/auth.js';
import { requirePermission } from '../../../middleware/rbac.js';
import { validate } from '../../../middleware/validate.js';
import * as receivables from './receivableReports.controller.js';

// URL -> middleware -> controller (A2). Contracts are in @bms/shared
// (report.ts) and listed in src/openapi/operations.ts.

const router = Router();
const reportAccess = [authenticate, requirePermission('VIEW_REPORTS'), validate(receivables.schemas.report)];

router.get('/reports/receivables-aging', ...reportAccess, receivables.aging);
router.get('/reports/receivables-aging/export', ...reportAccess, receivables.agingCsv);
router.get('/reports/receivables/export', ...reportAccess, receivables.exportCsv);

export default router;
