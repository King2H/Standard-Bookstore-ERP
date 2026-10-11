import { Router } from 'express';
import { authenticate } from '../../../middleware/auth.js';
import { requirePermission } from '../../../middleware/rbac.js';
import { validate } from '../../../middleware/validate.js';
import * as payments from './paymentReports.controller.js';

// URL -> middleware -> controller (A2). Contracts are in @bms/shared
// (report.ts) and listed in src/openapi/operations.ts.

const router = Router();
const reportAccess = [authenticate, requirePermission('VIEW_REPORTS'), validate(payments.schemas.report)];

router.get('/reports/payments', ...reportAccess, payments.report);
router.get('/reports/payments/export', ...reportAccess, payments.exportCsv);
router.get('/reports/payments-ledger', ...reportAccess, payments.ledger);
router.get('/reports/payments-ledger/export', ...reportAccess, payments.ledgerCsv);

export default router;
