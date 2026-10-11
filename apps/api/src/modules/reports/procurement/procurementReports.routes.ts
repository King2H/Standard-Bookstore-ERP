import { Router } from 'express';
import { authenticate } from '../../../middleware/auth.js';
import { requirePermission } from '../../../middleware/rbac.js';
import { validate } from '../../../middleware/validate.js';
import * as procurement from './procurementReports.controller.js';

// URL -> middleware -> controller (A2). Contracts are in @bms/shared
// (report.ts) and listed in src/openapi/operations.ts.

const router = Router();
const reportAccess = [authenticate, requirePermission('VIEW_REPORTS'), validate(procurement.schemas.report)];

router.get('/reports/procurement/export', ...reportAccess, procurement.exportLines);
router.get('/reports/procurement/open-pos', ...reportAccess, procurement.openPurchaseOrders);
router.get('/reports/procurement/open-pos/export', ...reportAccess, procurement.openPurchaseOrdersCsv);
router.get('/reports/procurement/supplier-balances', ...reportAccess, procurement.supplierBalances);
router.get('/reports/procurement/supplier-balances/export', ...reportAccess, procurement.supplierBalancesCsv);
router.get('/reports/procurement/ap-aging', ...reportAccess, procurement.apAging);
router.get('/reports/procurement/ap-aging/export', ...reportAccess, procurement.apAgingCsv);
router.get('/reports/procurement/purchases-by-supplier', ...reportAccess, procurement.purchasesBySupplier);
router.get('/reports/procurement/purchases-by-supplier/export', ...reportAccess, procurement.purchasesBySupplierCsv);
router.get('/reports/procurement/purchases-by-book', ...reportAccess, procurement.purchasesByBook);
router.get('/reports/procurement/purchases-by-book/export', ...reportAccess, procurement.purchasesByBookCsv);
router.get('/reports/procurement/supplier-payment-history', ...reportAccess, procurement.supplierPaymentHistory);
router.get('/reports/procurement/supplier-payment-history/export', ...reportAccess, procurement.supplierPaymentHistoryCsv);

export default router;
