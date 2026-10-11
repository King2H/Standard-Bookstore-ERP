import { Router } from 'express';
import { authenticate } from '../../../middleware/auth.js';
import { requirePermission } from '../../../middleware/rbac.js';
import { validate } from '../../../middleware/validate.js';
import * as exchanges from './exchangeReports.controller.js';

// URL -> middleware -> controller (A2). Contracts are in @bms/shared
// (report.ts) and listed in src/openapi/operations.ts.

const router = Router();
const reportAccess = [authenticate, requirePermission('VIEW_REPORTS'), validate(exchanges.schemas.report)];

router.get('/reports/exchanges', ...reportAccess, exchanges.report);
router.get('/reports/exchanges/detail', ...reportAccess, exchanges.detail);
router.get('/reports/exchanges/export', ...reportAccess, exchanges.exportCsv);

export default router;
