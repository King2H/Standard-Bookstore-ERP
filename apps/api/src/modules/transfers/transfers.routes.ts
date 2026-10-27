import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission, requireRole } from '../../middleware/rbac.js';
import { recordInBranch } from '../../middleware/recordScope.js';
import { validate } from '../../middleware/validate.js';
import * as transfers from './transfers.controller.js';

// URL -> middleware -> controller (A2). Request and response contracts are in
// @bms/shared (transfer.ts) and listed in src/openapi/operations.ts. Which
// branch may do what (sending or receiving) is transfers.policy's.

const router = Router();
const { schemas } = transfers;

// Sending and receiving: Admin, Manager and Stock_Clerk; resolving what did
// not arrive: Admin and Manager (owner decisions 2a, 4a, #170).
const canSee = requireRole('Admin', 'Manager', 'Stock_Clerk');
const senders = requirePermission('SEND_TRANSFER');
const receivers = requirePermission('RECEIVE_TRANSFER');
const resolvers = requirePermission('RESOLVE_TRANSFER');
const inBranch = recordInBranch('transfer');

router.get('/transfers', authenticate, canSee, validate(schemas.list), transfers.list);
router.post('/transfers', authenticate, senders, validate(schemas.create), transfers.create);
router.get('/transfers/:id', authenticate, inBranch, canSee, validate(schemas.byId), transfers.getById);
router.put('/transfers/:id', authenticate, inBranch, senders, validate(schemas.update), transfers.update);
router.post('/transfers/:id/cancel', authenticate, inBranch, senders, validate(schemas.byId), transfers.cancel);
router.post('/transfers/:id/dispatch', authenticate, inBranch, senders, validate(schemas.byId), transfers.dispatch);
router.post('/transfers/:id/receive', authenticate, inBranch, receivers, validate(schemas.receive), transfers.receive);
router.post('/transfers/:id/resolve', authenticate, inBranch, resolvers, validate(schemas.resolve), transfers.resolve);

export default router;
