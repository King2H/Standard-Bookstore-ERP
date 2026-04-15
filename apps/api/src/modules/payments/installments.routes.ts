import { Router, Request, Response, NextFunction } from 'express';
import * as installmentsService from './installments.service.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { ValidationError } from '../../lib/errors.js';

const router = Router();

// ── POST /api/orders/:id/installment-plan ─────────────────────────────────────

router.post(
  '/orders/:id/installment-plan',
  authenticate,
  requireRole('Sales', 'Manager', 'Admin', 'Finance_Officer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.body.numInstallments) throw new ValidationError('numInstallments is required');
      const plan = await installmentsService.createPlan(
        {
          orderId:         parseInt(req.params.id, 10),
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
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const plan = await installmentsService.getPlanByOrder(parseInt(req.params.id, 10));
      if (!plan) { res.status(404).json({ error: 'NOT_FOUND', message: 'No installment plan for this order' }); return; }
      res.json(plan);
    } catch (err) { next(err); }
  },
);

// ── GET /api/installment-plans/:id ────────────────────────────────────────────

router.get(
  '/installment-plans/:id',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const plan = await installmentsService.getPlanById(req.params.id);
      res.json(plan);
    } catch (err) { next(err); }
  },
);

// ── POST /api/installments/:id/pay ────────────────────────────────────────────

router.post(
  '/installments/:id/pay',
  authenticate,
  requireRole('Sales', 'Manager', 'Admin', 'Finance_Officer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.body.amount) throw new ValidationError('amount is required');
      const installment = await installmentsService.recordInstallmentPayment(
        req.params.id,
        parseFloat(req.body.amount),
        req.staff!,
      );
      res.json(installment);
    } catch (err) { next(err); }
  },
);

export default router;
