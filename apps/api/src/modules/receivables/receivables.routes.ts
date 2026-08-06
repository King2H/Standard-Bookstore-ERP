import { Router, Request, Response, NextFunction } from 'express';
import * as receivablesService from './receivables.service.js';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/rbac.js';
import { paramStr } from '../../lib/http.js';

const router = Router();

const qi = (v: unknown): number | undefined => {
  const s = typeof v === 'string' ? v : undefined;
  if (!s) return undefined;
  const n = parseInt(s, 10);
  return isNaN(n) ? undefined : n;
};
const qs = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const qb = (v: unknown): boolean | undefined => v === 'true' ? true : v === 'false' ? false : undefined;

// ── GET /api/receivables/summary ──────────────────────────────────────────────

router.get(
  '/receivables/summary',
  authenticate,
  requirePermission('VIEW_REPORTS'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const branchId = qi(req.query.branchId) ?? req.staff?.branchId;
      const summary = await receivablesService.getSummary(branchId);
      res.json(summary);
    } catch (err) { next(err); }
  },
);

// ── GET /api/receivables ──────────────────────────────────────────────────────

router.get(
  '/receivables',
  authenticate,
  requirePermission('PROCESS_PAYMENT'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const branchId = qi(req.query.branchId) ?? req.staff?.branchId;
      const result = await receivablesService.list({
        branchId,
        customerId:  qi(req.query.customerId),
        status:      qs(req.query.status),
        sourceType:  qs(req.query.sourceType),
        dueDateFrom: qs(req.query.dueDateFrom),
        dueDateTo:   qs(req.query.dueDateTo),
        overdueOnly: qb(req.query.overdueOnly),
        page:        qi(req.query.page),
        pageSize:    qi(req.query.pageSize),
      });
      res.json(result);
    } catch (err) { next(err); }
  },
);

// ── GET /api/receivables/:id ──────────────────────────────────────────────────

router.get(
  '/receivables/:id',
  authenticate,
  requirePermission('PROCESS_PAYMENT'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rec = await receivablesService.getById(paramStr(req.params.id));
      res.json(rec);
    } catch (err) { next(err); }
  },
);

// ── POST /api/receivables/:id/settle (admin manual override) ──────────────────

router.post(
  '/receivables/:id/settle',
  authenticate,
  requirePermission('PROCESS_PAYMENT'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rec = await receivablesService.manualSettle(
        paramStr(req.params.id),
        typeof req.body.notes === 'string' ? req.body.notes : undefined,
        req.staff!,
      );
      res.json(rec);
    } catch (err) { next(err); }
  },
);

// ── PATCH /api/receivables/:id/due-date ───────────────────────────────────────

router.patch(
  '/receivables/:id/due-date',
  authenticate,
  requirePermission('PROCESS_PAYMENT'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dueDate = req.body.dueDate === null ? null : (typeof req.body.dueDate === 'string' ? req.body.dueDate : null);
      const rec = await receivablesService.updateDueDate(paramStr(req.params.id), dueDate, req.staff!);
      res.json(rec);
    } catch (err) { next(err); }
  },
);

export default router;
