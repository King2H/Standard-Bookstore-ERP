import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission, requireRole } from '../../middleware/rbac.js';
import { recordInBranch } from '../../middleware/recordScope.js';
import { validate } from '../../middleware/validate.js';
import * as receivables from './receivables.controller.js';

// URL -> middleware -> controller (A2). Request and response contracts are in
// @bms/shared (receivable.ts) and listed in src/openapi/operations.ts.

const router = Router();
const { schemas } = receivables;

// Writing off a debt and changing when it is due are finance decisions, not
// routine collection (owner decision, #21).
const canManage = requireRole('Admin', 'Manager', 'Finance_Officer');
const inBranch = recordInBranch('receivable');

router.get('/receivables/summary', authenticate, requirePermission('VIEW_REPORTS'), receivables.summary);
router.get('/receivables', authenticate, requirePermission('PROCESS_PAYMENT'), validate(schemas.list), receivables.list);
router.get('/receivables/:id', authenticate, inBranch, requirePermission('PROCESS_PAYMENT'), validate(schemas.byId), receivables.getById);
router.post('/receivables/:id/collect', authenticate, inBranch, requirePermission('PROCESS_PAYMENT'), validate(schemas.collect), receivables.collect);
router.post('/receivables/:id/write-off', authenticate, inBranch, canManage, validate(schemas.writeOff), receivables.writeOff);
router.post('/receivables/:id/settle', authenticate, canManage, receivables.settle);
router.patch('/receivables/:id/due-date', authenticate, inBranch, canManage, validate(schemas.dueDate), receivables.changeDueDate);

export default router;
