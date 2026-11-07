import express, { Router } from 'express';
import { IMPORT_MAX_CHARS } from '@bms/shared';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission, requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import * as imports from './imports.controller.js';

// URL -> middleware -> controller (A2). Bulk import and export (#246): Admin
// and Manager bring in and take out the shop's lists.

const router = Router();
const { schemas } = imports;
const canImport = requireRole('Admin', 'Manager');
// Opening stock: whoever books stock (MANAGE_INVENTORY), in their branch and locations.
const canStock = requirePermission('MANAGE_INVENTORY');
// A file of 5,000 titles is about 1 MB: more than the API's default body size
// (app.ts leaves these paths to this parser). Read only once the caller may import.
const fileBody = express.json({ limit: IMPORT_MAX_CHARS * 2 });

router.get('/imports/catalog/template', authenticate, canImport, imports.catalogTemplate);
router.post('/imports/catalog/check', authenticate, canImport, fileBody, validate(schemas.file), imports.checkCatalog);
router.post('/imports/catalog', authenticate, canImport, fileBody, validate(schemas.file), imports.importCatalog);
router.get('/exports/catalog', authenticate, canImport, imports.exportCatalog);

router.get('/imports/opening-stock/template', authenticate, canStock, imports.stockTemplate);
router.post('/imports/opening-stock/check', authenticate, canStock, fileBody, validate(schemas.file), imports.checkStock);
router.post('/imports/opening-stock', authenticate, canStock, fileBody, validate(schemas.file), imports.importStock);
router.get('/exports/opening-stock', authenticate, canStock, imports.exportStock);

router.get('/imports/customers/template', authenticate, canImport, imports.customerTemplate);
router.post('/imports/customers/check', authenticate, canImport, fileBody, validate(schemas.file), imports.checkCustomers);
router.post('/imports/customers', authenticate, canImport, fileBody, validate(schemas.file), imports.importCustomers);
router.get('/exports/customers', authenticate, canImport, imports.exportCustomers);

// Opening balances: what customers and suppliers carried when the shop started.
router.get('/imports/customer-balances/template', authenticate, canImport, imports.customerBalanceTemplate);
router.post('/imports/customer-balances/check', authenticate, canImport, fileBody, validate(schemas.file), imports.checkCustomerBalances);
router.post('/imports/customer-balances', authenticate, canImport, fileBody, validate(schemas.file), imports.importCustomerBalances);
router.get('/imports/supplier-balances/template', authenticate, canImport, imports.supplierBalanceTemplate);
router.post('/imports/supplier-balances/check', authenticate, canImport, fileBody, validate(schemas.file), imports.checkSupplierBalances);
router.post('/imports/supplier-balances', authenticate, canImport, fileBody, validate(schemas.file), imports.importSupplierBalances);

export default router;
