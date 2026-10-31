import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';
import { recordInBranch } from '../../middleware/recordScope.js';
import { validate } from '../../middleware/validate.js';
import * as close from './businessDays.controller.js';

// URL -> middleware -> controller (A2). Request and response contracts are in
// @bms/shared (businessDay.ts) and listed in src/openapi/operations.ts.
// Closing a branch's day: Manager, Admin, Finance_Officer (#175, decision 2a);
// a month: Finance_Officer, Admin (4a); reopening either: Admin (5a). Kept
// days and months are reports, read with VIEW_REPORTS.

const router = Router();
const { schemas } = close;

const readers = requirePermission('VIEW_REPORTS');
const dayClosers = requirePermission('CLOSE_DAY');
const monthClosers = requirePermission('CLOSE_MONTH');
const reopeners = requirePermission('REOPEN_PERIOD');
const inBranch = recordInBranch('businessDay');

router.get('/business-days', authenticate, readers, validate(schemas.listDays), close.listDays);
router.get('/business-days/preview', authenticate, readers, validate(schemas.previewDay), close.previewDay);
router.post('/business-days/close', authenticate, dayClosers, validate(schemas.closeDay), close.closeDay);
router.get('/business-days/:id', authenticate, inBranch, readers, validate(schemas.byId), close.getDay);
router.post('/business-days/:id/reopen', authenticate, inBranch, reopeners, validate(schemas.reopen), close.reopenDay);

router.get('/business-months', authenticate, readers, validate(schemas.listMonths), close.listMonths);
router.get('/business-months/preview', authenticate, readers, validate(schemas.previewMonth), close.previewMonth);
router.post('/business-months/close', authenticate, monthClosers, validate(schemas.closeMonth), close.closeMonth);
router.get('/business-months/:id', authenticate, readers, validate(schemas.byId), close.getMonth);
router.post('/business-months/:id/reopen', authenticate, reopeners, validate(schemas.reopen), close.reopenMonth);

export default router;
