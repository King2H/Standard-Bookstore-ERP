import type { Request, Response, NextFunction } from 'express';
import { db } from '../db/index.js';
import { checkBranchSetupAccess, checkRecordBranch } from '../lib/scope.js';

// The branch(es) each kind of record belongs to, by its id. Records without
// a branch column take it from the order they belong to.
const BRANCH_OF = {
  order: { entity: 'Order', sql: 'SELECT branch_id FROM orders WHERE id = $1' },
  payment: {
    entity: 'Payment',
    sql: 'SELECT o.branch_id FROM order_payments p JOIN orders o ON o.id = p.order_id WHERE p.id = $1',
  },
  posTransaction: { entity: 'Transaction', sql: 'SELECT branch_id FROM transactions WHERE id = $1' },
  return: { entity: 'Return', sql: 'SELECT branch_id FROM returns WHERE id = $1' },
  exchange: { entity: 'Exchange', sql: 'SELECT branch_id FROM exchanges WHERE id = $1' },
  // Both the ordering and the receiving branch work on a purchase order.
  purchaseOrder: {
    entity: 'Purchase order',
    sql: 'SELECT branch_id, receiving_branch_id AS other_branch_id FROM purchase_orders WHERE id = $1',
  },
  receivable: { entity: 'Receivable', sql: 'SELECT branch_id FROM receivables WHERE id = $1' },
} as const;

export type BranchOwnedRecord = keyof typeof BRANCH_OF;

/**
 * Lets a request through only if the record named by `:id` is in the
 * session's branch (see checkRecordBranch). GET requests read; every other
 * method writes. A missing or malformed id is left to the handler, which
 * answers as before.
 */
export function recordInBranch(record: BranchOwnedRecord) {
  const { entity, sql } = BRANCH_OF[record];
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return next();
    try {
      const { rows } = await db.query<{ branch_id: number; other_branch_id?: number | null }>(sql, [id]);
      if (rows.length) {
        const branches = [rows[0].branch_id, rows[0].other_branch_id].filter((b): b is number => typeof b === 'number');
        checkRecordBranch(req, branches, req.method === 'GET' ? 'read' : 'write', entity);
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * For routes under /branches/:branchId: the session's branch, or any branch
 * with access to all branches (checkBranchSetupAccess).
 */
export function branchParamInScope(req: Request, _res: Response, next: NextFunction): void {
  const branchId = Number(req.params.branchId);
  if (Number.isInteger(branchId) && branchId > 0) {
    try {
      checkBranchSetupAccess(req, branchId);
    } catch (err) {
      return next(err);
    }
  }
  next();
}
