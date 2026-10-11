import { Router } from 'express';
import { authenticate } from '../../../middleware/auth.js';
import { requirePermission } from '../../../middleware/rbac.js';
import { validate } from '../../../middleware/validate.js';
import * as stock from './inventoryReports.controller.js';

// URL -> middleware -> controller (A2). Contracts are in @bms/shared
// (report.ts) and listed in src/openapi/operations.ts.

const router = Router();
const reportAccess = [authenticate, requirePermission('VIEW_REPORTS'), validate(stock.schemas.report)];

router.get('/reports/inventory', ...reportAccess, stock.report);
router.get('/reports/inventory/export', ...reportAccess, stock.exportCsv);
router.get('/reports/inventory-valuation/export', ...reportAccess, stock.valuationCsv);

export default router;
