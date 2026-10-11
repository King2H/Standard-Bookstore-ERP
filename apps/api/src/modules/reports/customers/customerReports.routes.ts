import { Router } from 'express';
import { authenticate } from '../../../middleware/auth.js';
import { requirePermission } from '../../../middleware/rbac.js';
import { validate } from '../../../middleware/validate.js';
import * as customers from './customerReports.controller.js';

// URL -> middleware -> controller (A2). Contracts are in @bms/shared
// (report.ts) and listed in src/openapi/operations.ts.

const router = Router();
const reportAccess = [authenticate, requirePermission('VIEW_REPORTS'), validate(customers.schemas.report)];

router.get('/reports/customers', ...reportAccess, customers.report);
router.get('/reports/customers/export', ...reportAccess, customers.exportCsv);

export default router;
