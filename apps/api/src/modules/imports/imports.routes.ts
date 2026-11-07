import express, { Router } from 'express';
import { IMPORT_MAX_CHARS } from '@bms/shared';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import * as imports from './imports.controller.js';

// URL -> middleware -> controller (A2). Bulk import and export (#246): Admin
// and Manager bring in and take out the shop's lists.

const router = Router();
const { schemas } = imports;
const canImport = requireRole('Admin', 'Manager');
// A file of 5,000 titles is about 1 MB: more than the API's default body size
// (app.ts leaves these paths to this parser). Read only once the caller may import.
const fileBody = express.json({ limit: IMPORT_MAX_CHARS * 2 });

router.get('/imports/catalog/template', authenticate, canImport, imports.catalogTemplate);
router.post('/imports/catalog/check', authenticate, canImport, fileBody, validate(schemas.file), imports.checkCatalog);
router.post('/imports/catalog', authenticate, canImport, fileBody, validate(schemas.file), imports.importCatalog);
router.get('/exports/catalog', authenticate, canImport, imports.exportCatalog);

export default router;
