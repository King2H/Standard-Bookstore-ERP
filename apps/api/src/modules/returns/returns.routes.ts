import { Router, Request, Response, NextFunction } from 'express';
import * as returnsService from './returns.service.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { paramStr } from '../../lib/http.js';

const router = Router();

const qs = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined;
const qi = (v: unknown, fb: number): number => { const s = qs(v); return s ? parseInt(s, 10) || fb : fb; };

// ── POST /api/returns ─────────────────────────────────────────────────────────

router.post(
  '/returns',
  authenticate,
  requireRole('Sales', 'Manager', 'Admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ret = await returnsService.createReturn(
        {
          transactionId: req.body.transactionId,
          refundMethod:  req.body.refundMethod,
          reason:        req.body.reason,
          lines:         req.body.lines,
          approvedBy:    req.body.approvedBy ?? null,
        },
        req.staff!,
      );
      res.status(201).json(ret);
    } catch (err) { next(err); }
  },
);

// ── GET /api/returns ──────────────────────────────────────────────────────────

router.get(
  '/returns',
  authenticate,
  requireRole('Admin', 'Manager', 'Finance_Officer', 'Sales'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await returnsService.list({
        branchId:      qi(req.query.branchId, 0) || undefined,
        customerId:    qi(req.query.customerId, 0) || undefined,
        transactionId: qi(req.query.transactionId, 0) || undefined,
        status:        qs(req.query.status),
        dateFrom:      qs(req.query.dateFrom),
        dateTo:        qs(req.query.dateTo),
        page:          qi(req.query.page, 1),
        pageSize:      qi(req.query.pageSize, 25),
      });
      res.json(result);
    } catch (err) { next(err); }
  },
);

// ── GET /api/returns/:id ──────────────────────────────────────────────────────

router.get(
  '/returns/:id',
  authenticate,
  requireRole('Admin', 'Manager', 'Finance_Officer', 'Sales'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ret = await returnsService.getById(parseInt(paramStr(req.params.id), 10));
      res.json(ret);
    } catch (err) { next(err); }
  },
);

// ── POST /api/returns/:id/reject ──────────────────────────────────────────────

router.post(
  '/returns/:id/reject',
  authenticate,
  requireRole('Manager', 'Admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ret = await returnsService.rejectReturn(parseInt(paramStr(req.params.id), 10), req.staff!);
      res.json(ret);
    } catch (err) { next(err); }
  },
);

export default router;
