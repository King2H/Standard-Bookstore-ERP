import { Router, Request, Response, NextFunction } from 'express';
import * as customerService from './customer.service.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { paramInt } from '../../lib/http.js';

const router = Router();

// Bug Sweep: was a bare parseInt() with no NaN guard — a non-numeric :id
// (e.g. GET /api/customers/abc) reached the DB as literal "NaN" and
// Postgres rejected it as an unhandled error, surfacing as a raw 500
// instead of a clean 400. paramInt() throws ValidationError on NaN.
const pi = paramInt;
const qs = (v: unknown): string | undefined => (typeof v === 'string' ? v : Array.isArray(v) ? (v[0] as string | undefined) : undefined);
const qi = (v: unknown, fallback: number): number => { const s = qs(v); return s ? parseInt(s, 10) || fallback : fallback; };
const qb = (v: unknown): boolean | undefined => { const s = qs(v); return s === undefined ? undefined : s === 'true'; };

// ── GET /api/customers ────────────────────────────────────────────────────────

router.get(
  '/customers',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await customerService.searchCustomers({
        q:        qs(req.query.q),
        branchId: req.query.branchId ? qi(req.query.branchId, 0) : undefined,
        isActive: qb(req.query.isActive),
        groupId:  req.query.groupId ? qi(req.query.groupId, 0) : undefined,
        page:     qi(req.query.page, 1),
        pageSize: qi(req.query.pageSize, 25),
      });
      res.json(result);
    } catch (err) { next(err); }
  },
);

// ── POST /api/customers ───────────────────────────────────────────────────────

router.post(
  '/customers',
  authenticate,
  requireRole('Admin', 'Manager', 'Sales'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customer = await customerService.createCustomer(req.body, req.staff!);
      res.status(201).json(customer);
    } catch (err) { next(err); }
  },
);

// ── GET /api/customers/:id ────────────────────────────────────────────────────

router.get(
  '/customers/:id',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customer = await customerService.getCustomerById(pi(req.params.id));
      res.json(customer);
    } catch (err) { next(err); }
  },
);

// ── PUT /api/customers/:id ────────────────────────────────────────────────────

router.put(
  '/customers/:id',
  authenticate,
  requireRole('Admin', 'Manager', 'Sales'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customer = await customerService.updateCustomer(pi(req.params.id), req.body, req.staff!);
      res.json(customer);
    } catch (err) { next(err); }
  },
);

// ── POST /api/customers/:id/deactivate ────────────────────────────────────────

router.post(
  '/customers/:id/deactivate',
  authenticate,
  requireRole('Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await customerService.deactivateCustomer(pi(req.params.id), req.staff!);
      res.json({ message: 'Customer deactivated' });
    } catch (err) { next(err); }
  },
);

// ── GET /api/customer-groups ──────────────────────────────────────────────────

router.get(
  '/customer-groups',
  authenticate,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const groups = await customerService.listCustomerGroups();
      res.json({ items: groups });
    } catch (err) { next(err); }
  },
);

// ── POST /api/customer-groups ─────────────────────────────────────────────────

router.post(
  '/customer-groups',
  authenticate,
  requireRole('Admin', 'Manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const group = await customerService.createCustomerGroup(req.body, req.staff!);
      res.status(201).json(group);
    } catch (err) { next(err); }
  },
);

// ── GET /api/customers/:id/loyalty ────────────────────────────────────────────

router.get(
  '/customers/:id/loyalty',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customer = await customerService.getCustomerById(pi(req.params.id));
      res.json({ loyaltyBalance: customer.loyaltyBalance, lifetimePoints: customer.lifetimePoints });
    } catch (err) { next(err); }
  },
);

// ── GET /api/customers/:id/loyalty/history ────────────────────────────────────

router.get(
  '/customers/:id/loyalty/history',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await customerService.getLoyaltyHistory(
        pi(req.params.id),
        qi(req.query.page, 1),
        qi(req.query.pageSize, 25),
      );
      res.json(result);
    } catch (err) { next(err); }
  },
);

// ── POST /api/customers/:id/loyalty/redeem ────────────────────────────────────

router.post(
  '/customers/:id/loyalty/redeem',
  authenticate,
  requireRole('Admin', 'Manager', 'Sales'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { points, transactionRef } = req.body as { points: number; transactionRef?: string };
      await customerService.redeemPoints(pi(req.params.id), points, transactionRef ?? null, req.staff!);
      res.json({ message: 'Points redeemed' });
    } catch (err) { next(err); }
  },
);

// ── GET /api/customers/:id/store-credit ───────────────────────────────────────

router.get(
  '/customers/:id/store-credit',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const customer = await customerService.getCustomerById(pi(req.params.id));
      res.json({ balance: customer.storeCreditBalance });
    } catch (err) { next(err); }
  },
);

// ── GET /api/customers/:id/store-credit/history ───────────────────────────────

router.get(
  '/customers/:id/store-credit/history',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await customerService.getStoreCreditHistory(
        pi(req.params.id),
        qi(req.query.page, 1),
        qi(req.query.pageSize, 25),
      );
      res.json(result);
    } catch (err) { next(err); }
  },
);

// ── POST /api/customers/:id/store-credit/adjust ───────────────────────────────

router.post(
  '/customers/:id/store-credit/adjust',
  authenticate,
  requireRole('Admin', 'Finance_Officer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { amount, direction, refType, refId } = req.body as {
        amount: number;
        direction: 'credit' | 'debit';
        refType?: string;
        refId?: string;
      };
      const customerId = pi(req.params.id);
      if (direction === 'credit') {
        await customerService.creditStoreCredit(customerId, amount, refType ?? null, refId ?? null, req.staff!);
      } else {
        await customerService.debitStoreCredit(customerId, amount, refType ?? null, refId ?? null, req.staff!);
      }
      res.json({ message: `Store credit ${direction} applied` });
    } catch (err) { next(err); }
  },
);

export default router;
