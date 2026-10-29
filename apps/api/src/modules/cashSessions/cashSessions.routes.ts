import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';
import { recordInBranch } from '../../middleware/recordScope.js';
import { validate } from '../../middleware/validate.js';
import * as cash from './cashSessions.controller.js';

// URL -> middleware -> controller (A2). Request and response contracts are in
// @bms/shared (cashSession.ts) and listed in src/openapi/operations.ts. Whose
// session may be seen, put cash into or closed is cashSessions.policy's.

const router = Router();
const { schemas } = cash;

// Those who take payments hold a session (#171, decision 1a); Admin and
// Manager accept a count beyond the limit (4a). Seeing the branch's sessions
// is the policy's: Admin, Manager and Finance_Officer.
const cashiers = requirePermission('PROCESS_PAYMENT');
const reviewers = requirePermission('REVIEW_CASH_SESSION');
const inBranch = recordInBranch('cashSession');

router.get('/cash-sessions/current', authenticate, cashiers, cash.current);
router.get('/cash-sessions', authenticate, validate(schemas.list), cash.list);
router.post('/cash-sessions', authenticate, cashiers, validate(schemas.open), cash.open);
router.get('/cash-sessions/:id', authenticate, inBranch, validate(schemas.byId), cash.getById);
router.post('/cash-sessions/:id/movements', authenticate, inBranch, cashiers, validate(schemas.movement), cash.addMovement);
router.post('/cash-sessions/:id/close', authenticate, inBranch, cashiers, validate(schemas.close), cash.close);
router.post('/cash-sessions/:id/review', authenticate, inBranch, reviewers, validate(schemas.review), cash.review);

export default router;
