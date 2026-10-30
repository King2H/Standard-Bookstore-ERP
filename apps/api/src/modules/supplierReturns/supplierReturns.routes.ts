import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission, requireRole } from '../../middleware/rbac.js';
import { recordInBranch } from '../../middleware/recordScope.js';
import { validate } from '../../middleware/validate.js';
import * as returns from './supplierReturns.controller.js';

// URL -> middleware -> controller (A2). Request and response contracts are in
// @bms/shared (supplierReturn.ts) and listed in src/openapi/operations.ts.

const router = Router();
const { schemas } = returns;

// Reading: the roles that see purchase orders. Drafting: Admin, Manager and
// Purchasor; sending: Admin and Manager (#173, decision 5a).
const canSee = requireRole('Admin', 'Manager', 'Purchasor', 'Stock_Clerk', 'Finance_Officer');
const buyers = requireRole('Admin', 'Manager', 'Purchasor');
const senders = requirePermission('SEND_SUPPLIER_RETURN');
const inBranch = recordInBranch('supplierReturn');

router.get('/supplier-returns', authenticate, canSee, validate(schemas.list), returns.list);
router.post('/supplier-returns', authenticate, buyers, validate(schemas.create), returns.create);
router.get('/supplier-returns/:id', authenticate, inBranch, canSee, validate(schemas.byId), returns.getById);
router.put('/supplier-returns/:id', authenticate, inBranch, buyers, validate(schemas.update), returns.update);
router.post('/supplier-returns/:id/send', authenticate, inBranch, senders, validate(schemas.byId), returns.sendReturn);
router.post('/supplier-returns/:id/cancel', authenticate, inBranch, buyers, validate(schemas.cancel), returns.cancel);

export default router;
