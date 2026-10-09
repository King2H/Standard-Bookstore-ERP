import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import * as inventory from './inventory.controller.js';

// URL -> middleware -> controller (A2). Request and response contracts are in
// @bms/shared (inventory.ts) and listed in src/openapi/operations.ts.

const router = Router();
const { schemas } = inventory;

// Sales take stock out through POS and orders, which record the sale; a
// manual stock movement is warehouse work (owner decision, #21).
const canMoveStock = requireRole('Admin', 'Manager', 'Stock_Clerk');
const canManage = requireRole('Admin', 'Manager');

router.get('/inventory', authenticate, validate(schemas.list), inventory.list);
router.get('/inventory/low-stock', authenticate, validate(schemas.lowStock), inventory.lowStock);
router.get('/inventory/history', authenticate, validate(schemas.history), inventory.history);
router.get('/inventory/book/:bookId/breakdown', authenticate, validate(schemas.bookStock), inventory.bookStock);

router.post('/inventory/adjust', authenticate, canMoveStock, validate(schemas.adjust), inventory.adjust);
router.post('/inventory/transfer', authenticate, canMoveStock, validate(schemas.transfer), inventory.transfer);
router.post('/inventory/stock-in', authenticate, canMoveStock, validate(schemas.stockIn), inventory.stockIn);
router.post('/inventory/stock-out', authenticate, canMoveStock, validate(schemas.stockOut), inventory.stockOut);
router.put('/inventory/reorder-point', authenticate, canManage, validate(schemas.reorderPoint), inventory.reorderPoint);
router.post('/inventory/initialize', authenticate, canManage, inventory.initialize);

export default router;
