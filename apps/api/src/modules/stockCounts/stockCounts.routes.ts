import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission, requireRole } from '../../middleware/rbac.js';
import { recordInBranch } from '../../middleware/recordScope.js';
import { validate } from '../../middleware/validate.js';
import * as counts from './stockCounts.controller.js';

// URL -> middleware -> controller (A2). Request and response contracts are in
// @bms/shared (stockCount.ts) and listed in src/openapi/operations.ts.

const router = Router();
const { schemas } = counts;

// Counting: Admin, Manager and Stock_Clerk; reviewing, posting and
// cancelling: Admin and Manager (#172, decisions 3a, 4a).
const counters = requireRole('Admin', 'Manager', 'Stock_Clerk');
const reviewers = requirePermission('APPROVE_STOCK_COUNT');
const inBranch = recordInBranch('stockCount');

router.get('/stock-counts', authenticate, counters, validate(schemas.list), counts.list);
router.post('/stock-counts', authenticate, counters, validate(schemas.open), counts.open);
router.get('/stock-counts/:id', authenticate, inBranch, counters, validate(schemas.byId), counts.getById);
router.post('/stock-counts/:id/counts', authenticate, inBranch, counters, validate(schemas.counts), counts.enterCounts);
router.post('/stock-counts/:id/submit', authenticate, inBranch, counters, validate(schemas.byId), counts.submit);
router.post('/stock-counts/:id/recount', authenticate, inBranch, reviewers, validate(schemas.recount), counts.recount);
router.post('/stock-counts/:id/post', authenticate, inBranch, reviewers, validate(schemas.post), counts.post);
router.post('/stock-counts/:id/cancel', authenticate, inBranch, reviewers, validate(schemas.cancel), counts.cancel);

export default router;
