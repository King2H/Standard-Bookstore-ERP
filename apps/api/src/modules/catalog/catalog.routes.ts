import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission, requireRole } from '../../middleware/rbac.js';
import { branchParamInScope } from '../../middleware/recordScope.js';
import { validate } from '../../middleware/validate.js';
import * as books from './catalog.controller.js';

// URL -> middleware -> controller (A2). Request and response contracts are in
// @bms/shared (catalog.ts) and listed in src/openapi/operations.ts.

const router = Router();
const { schemas } = books;

const canEdit = requireRole('Admin', 'Manager', 'Stock_Clerk');
const canPrice = requireRole('Admin', 'Manager');
const byId = validate(schemas.byId);

// Any signed-in staff member may look books up, with any branch's price (#12).
router.get('/books', authenticate, validate(schemas.list), books.list);
router.get('/books/with-availability', authenticate, validate(schemas.list), books.listWithAvailability);
router.get('/catalog/search', authenticate, validate(schemas.search), books.search);
router.get('/catalog/authors/suggest', authenticate, validate(schemas.suggest), books.suggestAuthors);
router.get('/catalog/categories/suggest', authenticate, validate(schemas.suggest), books.suggestCategories);
router.get('/books/:id', authenticate, validate(schemas.get), books.get);
router.get('/books/:id/prices', authenticate, byId, books.prices);
router.get('/books/:id/history', authenticate, requireRole('Admin', 'Manager'), validate(schemas.history), books.history);
router.get('/catalog/:id/usage', authenticate, canEdit, byId, books.usage);

router.post('/books', authenticate, canEdit, validate(schemas.create), books.create);
// Sales register a catalog-only entry from the exchange screen (CREATE_SALE).
router.post('/books/quick-register', authenticate, requirePermission('CREATE_SALE'), validate(schemas.quickRegister), books.quickRegister);
router.put('/books/:id', authenticate, canEdit, validate(schemas.update), books.update);
router.delete('/books/:id', authenticate, requireRole('Admin'), byId, books.remove);

router.post('/books/:id/deactivate', authenticate, canEdit, byId, books.transition('INACTIVATE'));
router.post('/books/:id/reactivate', authenticate, canEdit, byId, books.transition('ACTIVATE'));
router.post('/books/:id/archive', authenticate, canEdit, byId, books.transition('ARCHIVE'));
router.post('/books/:id/restore', authenticate, canEdit, byId, books.transition('RESTORE'));

// A price is set for the session's branch, or any branch with access to all branches.
router.put('/books/:id/prices/:branchId', authenticate, canPrice, branchParamInScope, validate(schemas.price), books.setPrice);

export default router;
