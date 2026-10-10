import { Router, Request, Response, NextFunction } from 'express';
import * as payables from './supplierPayables.service.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { paramInt } from '../../lib/http.js';
import { buildCsv, sendCsv, SUPPLIER_LEDGER_COLUMNS } from '../../lib/csvBuilder.js';
import { recordInBranch } from '../../middleware/recordScope.js';
import { toPurchaseOrderResponse } from './procurement.mapper.js';

// Supplier payables, still in their v1 shape until procurement part 2 (#21).

const router = Router();

const qs = (v: unknown): string | undefined => (typeof v === 'string' ? v : Array.isArray(v) ? (v[0] as string | undefined) : undefined);
const pi = paramInt;

// ── POST /api/purchase-orders/:id/payments ────────────────────────────────────
// A manual supplier payment against a PO. financial_status is derived from the
// sum of these rows (plus any auto-settled cash-terms receipt payments).

router.post(
  '/purchase-orders/:id/payments',
  authenticate,
  recordInBranch('purchaseOrder'),
  requireRole('Admin', 'Manager', 'Finance_Officer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { amount, paymentMethod, notes } = req.body as {
        amount: number;
        paymentMethod?: string;
        notes?: string | null;
      };
      const po = await payables.createSupplierPayment(pi(req.params.id), { amount, paymentMethod, notes }, req.staff!);
      res.status(201).json(toPurchaseOrderResponse(po));
    } catch (err) { next(err); }
  },
);

// ── POST /api/purchase-orders/:id/credit-notes ─────────────────────────────────
// Correcting a PO's economics after receipt (damaged goods, an overcharge).

router.post(
  '/purchase-orders/:id/credit-notes',
  authenticate,
  recordInBranch('purchaseOrder'),
  requireRole('Admin', 'Manager', 'Finance_Officer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { amount, reason } = req.body as { amount: number; reason: string };
      const po = await payables.createSupplierCreditNote(pi(req.params.id), { amount, reason }, req.staff!);
      res.status(201).json(toPurchaseOrderResponse(po));
    } catch (err) { next(err); }
  },
);

// ── GET /api/suppliers/:id/ledger ───────────────────────────────────────────
// Running-balance ledger (PO / Goods Receipt / Payment / Credit Note / Balance).

router.get(
  '/suppliers/:id/ledger',
  authenticate,
  requireRole('Admin', 'Manager', 'Finance_Officer', 'Purchasor'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await payables.getSupplierLedger(pi(req.params.id), {
        dateFrom: qs(req.query.dateFrom),
        dateTo: qs(req.query.dateTo),
      });
      res.json(result);
    } catch (err) { next(err); }
  },
);

router.get(
  '/suppliers/:id/ledger/export',
  authenticate,
  requireRole('Admin', 'Manager', 'Finance_Officer', 'Purchasor'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { entries } = await payables.getSupplierLedger(pi(req.params.id), {
        dateFrom: qs(req.query.dateFrom),
        dateTo: qs(req.query.dateTo),
      });
      const csvRows = entries.map(e => ({
        date: e.date, type: e.type, reference: e.reference, description: e.description,
        amount: e.amount, balance: e.balance,
      }));
      const today = new Date().toISOString().slice(0, 10);
      sendCsv(res, `supplier-ledger-${today}.csv`, buildCsv(csvRows, SUPPLIER_LEDGER_COLUMNS));
    } catch (err) { next(err); }
  },
);

export default router;
