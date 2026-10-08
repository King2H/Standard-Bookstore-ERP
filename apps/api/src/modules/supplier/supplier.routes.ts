import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import * as supplier from './supplier.controller.js';

// URL -> middleware -> controller (A2). Request and response contracts are in
// @bms/shared (supplier.ts) and listed in src/openapi/operations.ts.

const router = Router();

const canManage = requireRole('Admin', 'Manager', 'Purchasor', 'Stock_Clerk');
const canModerate = requireRole('Admin', 'Manager');
const { schemas } = supplier;

router.get('/suppliers', authenticate, canManage, validate(schemas.list), supplier.list);
router.post('/suppliers', authenticate, canManage, validate(schemas.create), supplier.create);
router.get('/suppliers/:id', authenticate, canManage, validate(schemas.byId), supplier.get);
router.put('/suppliers/:id', authenticate, canManage, validate(schemas.update), supplier.update);
router.delete('/suppliers/:id', authenticate, canModerate, validate(schemas.byId), supplier.remove);

router.post('/suppliers/:id/deactivate', authenticate, canManage, validate(schemas.byId), supplier.deactivate);
router.post('/suppliers/:id/activate', authenticate, canManage, validate(schemas.byId), supplier.activate);
router.post('/suppliers/:id/archive', authenticate, canManage, validate(schemas.byId), supplier.archive);
router.post('/suppliers/:id/restore', authenticate, canManage, validate(schemas.byId), supplier.restore);
router.post('/suppliers/:id/blacklist', authenticate, canModerate, validate(schemas.byId), supplier.blacklist);
router.get('/suppliers/:id/usage', authenticate, canManage, validate(schemas.byId), supplier.usage);

// Any signed-in staff member may see a book's suppliers.
router.get('/books/:bookId/suppliers', authenticate, validate(schemas.bookSuppliers), supplier.listForBook);
router.post('/books/:bookId/suppliers', authenticate, canModerate, validate(schemas.link), supplier.linkToBook);
router.delete(
  '/books/:bookId/suppliers/:supplierId',
  authenticate,
  canModerate,
  validate(schemas.unlink),
  supplier.unlinkFromBook,
);

export default router;
