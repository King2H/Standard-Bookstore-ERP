import { Router, Request, Response, NextFunction } from 'express';
import * as installmentsService from './installments.service.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { AppError, ValidationError } from '../../lib/errors.js';
import { paramStr } from '../../lib/http.js';
import { recordInBranch } from '../../middleware/recordScope.js';

const router = Router();

// ── POST /api/orders/:id/installment-plan ─────────────────────────────────────

router.post(
  '/orders/:id/installment-plan',
  authenticate,
  recordInBranch('order'),
  requireRole('Sales', 'Manager', 'Admin', 'Finance_Officer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.body.numInstallments) throw new ValidationError('numInstallments is required');
      const plan = await installmentsService.createPlan(
        {
          orderId:         parseInt(paramStr(req.params.id), 10),
          numInstallments: parseInt(req.body.numInstallments, 10),
          depositAmount:   req.body.depositAmount ? parseFloat(req.body.depositAmount) : undefined,
          firstDueDate:    req.body.firstDueDate,
          notes:           req.body.notes,
        },
        req.staff!,
      );
      res.status(201).json(plan);
    } catch (err) { next(err); }
  },
);

// ── GET /api/orders/:id/installment-plan ──────────────────────────────────────

router.get(
  '/orders/:id/installment-plan',
  authenticate,
  recordInBranch('order'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const plan = await installmentsService.getPlanByOrder(parseInt(paramStr(req.params.id), 10));
      if (!plan) throw new AppError('NOT_FOUND', 'No installment plan for this order', 404);
      res.json(plan);
    } catch (err) { next(err); }
  },
);

// ── GET /api/installment-plans/:id ────────────────────────────────────────────

router.get(
  '/installment-plans/:id',
  authenticate,
  recordInBranch('installmentPlan'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const plan = await installmentsService.getPlanById(paramStr(req.params.id));
      res.json(plan);
    } catch (err) { next(err); }
  },
);

// ── POST /api/installments/:id/pay ────────────────────────────────────────────

router.post(
  '/installments/:id/pay',
  authenticate,
  recordInBranch('installment'),
  requireRole('Sales', 'Manager', 'Admin', 'Finance_Officer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.body.amount) throw new ValidationError('amount is required');
      const installment = await installmentsService.recordInstallmentPayment(
        paramStr(req.params.id),
        parseFloat(req.body.amount),
        req.staff!,
      );
      res.json(installment);
    } catch (err) { next(err); }
  },
);

export default router;
