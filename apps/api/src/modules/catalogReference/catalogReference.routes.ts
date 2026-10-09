import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import * as refs from './catalogReference.controller.js';
import type { ReferenceKind } from './catalogReference.types.js';

// URL -> middleware -> controller (A2). Request and response contracts are in
// @bms/shared (catalogReference.ts) and listed in src/openapi/operations.ts.

const router = Router();
const { schemas } = refs;

const canEdit = requireRole('Admin', 'Manager', 'Stock_Clerk');
const canDelete = requireRole('Admin');

router.get('/authors', authenticate, validate(schemas.listAuthors), refs.listAuthors);
router.post('/authors', authenticate, canEdit, validate(schemas.createName), refs.createAuthor);
router.put('/authors/:id', authenticate, canEdit, validate(schemas.updateName), refs.updateAuthor);

router.get('/categories', authenticate, validate(schemas.listCategories), refs.listCategories);
router.post('/categories', authenticate, canEdit, validate(schemas.createCategory), refs.createCategory);
router.put('/categories/:id', authenticate, canEdit, validate(schemas.updateCategory), refs.updateCategory);

router.get('/publishers', authenticate, validate(schemas.listPublishers), refs.listPublishers);
router.post('/publishers', authenticate, canEdit, validate(schemas.createName), refs.createPublisher);
router.put('/publishers/:id', authenticate, canEdit, validate(schemas.updateName), refs.updatePublisher);

// The same usage, delete and lifecycle endpoints for each kind.
const PATHS: Record<ReferenceKind, string> = { author: '/authors', category: '/categories', publisher: '/publishers' };
for (const [kind, path] of Object.entries(PATHS) as [ReferenceKind, string][]) {
  const byId = validate(schemas.byId);
  router.delete(`${path}/:id`, authenticate, canDelete, byId, refs.remove(kind));
  router.get(`${path}/:id/usage`, authenticate, canEdit, byId, refs.usage(kind));
  router.post(`${path}/:id/archive`, authenticate, canEdit, byId, refs.transition(kind, 'ARCHIVE'));
  router.post(`${path}/:id/restore`, authenticate, canEdit, byId, refs.transition(kind, 'RESTORE'));
  router.post(`${path}/:id/deactivate`, authenticate, canEdit, byId, refs.transition(kind, 'INACTIVATE'));
  router.post(`${path}/:id/activate`, authenticate, canEdit, byId, refs.transition(kind, 'ACTIVATE'));
}

router.get('/book-formats', authenticate, refs.listBookFormats);
router.get('/book-editions', authenticate, refs.listBookEditions);

export default router;
