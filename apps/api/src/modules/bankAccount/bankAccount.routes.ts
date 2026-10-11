import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { branchParamInScope } from '../../middleware/recordScope.js';
import { validate } from '../../middleware/validate.js';
import * as bank from './bankAccount.controller.js';

// URL -> middleware -> controller (A2). Request and response contracts are in
// @bms/shared (bankAccount.ts) and listed in src/openapi/operations.ts. The
// branch in the URL must be the session's (or the staff member has access to
// all branches); the account must belong to it (the service answers 404).
// Mounted only with FEATURE_BANK_ACCOUNTS=true (app.ts).

const router = Router();
const { schemas } = bank;

const canSee = requireRole('Admin', 'Manager', 'Finance_Officer');
const canManage = requireRole('Admin', 'Manager');
const base = '/branches/:branchId/bank-accounts';

router.get(base, authenticate, branchParamInScope, canSee, validate(schemas.list), bank.list);
router.post(base, authenticate, branchParamInScope, canManage, validate(schemas.create), bank.create);
router.get(`${base}/:id`, authenticate, branchParamInScope, canSee, validate(schemas.byId), bank.getById);
router.put(`${base}/:id`, authenticate, branchParamInScope, canManage, validate(schemas.update), bank.update);
router.post(`${base}/:id/deactivate`, authenticate, branchParamInScope, canManage, validate(schemas.byId), bank.deactivate);
router.post(`${base}/:id/reactivate`, authenticate, branchParamInScope, canManage, validate(schemas.byId), bank.reactivate);

// Reconciliation (owner decision 1a): the system's movements and the bank's statement lines.
router.get(`${base}/:id/entries`, authenticate, branchParamInScope, canSee, validate(schemas.entries), bank.entries);
router.get(`${base}/:id/statement-lines`, authenticate, branchParamInScope, canSee, validate(schemas.lines), bank.lines);
router.post(`${base}/:id/statement-lines`, authenticate, branchParamInScope, canSee, validate(schemas.importStatement), bank.importStatement);
router.post(`${base}/:id/statement-lines/:lineId/match`, authenticate, branchParamInScope, canSee, validate(schemas.match), bank.match);
router.post(`${base}/:id/statement-lines/:lineId/unmatch`, authenticate, branchParamInScope, canSee, validate(schemas.unmatch), bank.unmatch);

// v1 reconciliation, retired.
router.get('/branches/:branchId/reconciliation', authenticate, bank.reconciliationRetired);
router.post('/branches/:branchId/reconciliation/import', authenticate, bank.reconciliationRetired);
router.put('/branches/:branchId/reconciliation/:entryId', authenticate, bank.reconciliationRetired);

export default router;
