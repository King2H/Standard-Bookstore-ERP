// returns.service.ts — Slice 
import { db } from '../../db/index.js';
import { BusinessError, ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors.js';
import {
  getReturnWindowDays, getMaxReturnValueWithoutAuth, getRefundMethodAfterWindow,
  getLoyaltyAccrualRate, getLoyaltyMinTransactionAmount,
} from '../config/config.service.js';

export interface StaffCtx { staffId: number; role: string; branchId: number; }
export interface ReturnLineInput { transactionLineItemId: number; quantity: number; }
export interface ReturnRow {
  id: string; returnNumber: string; transactionId: string; branchId: number;
  customerId: number | null; totalRefundAmount: number;
  refundMethod: 'cash' | 'store_credit'; status: 'completed' | 'rejected';
  reason: string | null; processedBy: number; approvedBy: number | null;
  createdAt: string; lineItems?: ReturnLineItemRow[]; refunds?: RefundRow[];
}
export interface ReturnLineItemRow {
  id: string; returnId: string; transactionLineItemId: string;
  bookId: number; bookTitle: string; quantity: number;
  unitPrice: number; lineRefundAmount: number;
}
export interface RefundRow { id: string; returnId: string; method: string; amount: number; createdAt: string; }

function mapReturnRow(row: Record<string, unknown>): ReturnRow {
  return {
    id: String(row.id), returnNumber: row.return_number as string,
    transactionId: String(row.transaction_id), branchId: row.branch_id as number,
    customerId: (row.customer_id as number | null) ?? null,
    totalRefundAmount: parseFloat(row.total_refund_amount as string),
    refundMethod: row.refund_method as 'cash' | 'store_credit',
    status: row.status as 'completed' | 'rejected',
    reason: (row.reason as string | null) ?? null,
    processedBy: row.processed_by as number,
    approvedBy: (row.approved_by as number | null) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
  };
}
function mapLineItemRow(row: Record<string, unknown>): ReturnLineItemRow {
  return {
    id: String(row.id), returnId: String(row.return_id),
    transactionLineItemId: String(row.transaction_line_item_id),
    bookId: row.book_id as number, bookTitle: (row.book_title as string) ?? '',
    quantity: row.quantity as number, unitPrice: parseFloat(row.unit_price as string),
    lineRefundAmount: parseFloat(row.line_refund_amount as string),
  };
}
function mapRefundRow(row: Record<string, unknown>): RefundRow {
  return { id: String(row.id), returnId: String(row.return_id), method: row.method as string, amount: parseFloat(row.amount as string), createdAt: (row.created_at as Date).toISOString() };
}
async function fetchLineItems(returnId: string): Promise<ReturnLineItemRow[]> {
  const res = await db.query(`SELECT rli.*, b.title AS book_title FROM return_line_items rli LEFT JOIN books b ON b.id = rli.book_id WHERE rli.return_id = $1 ORDER BY rli.id`, [returnId]);
  return res.rows.map(mapLineItemRow);
}
async function fetchRefunds(returnId: string): Promise<RefundRow[]> {
  const res = await db.query(`SELECT * FROM refunds WHERE return_id = $1 ORDER BY id`, [returnId]);
  return res.rows.map(mapRefundRow);
}
export async function getById(id: string | number): Promise<ReturnRow> {
  const res = await db.query(`SELECT * FROM returns WHERE id = $1`, [id]);
  if (!res.rows.length) throw new NotFoundError('Return');
  const ret = mapReturnRow(res.rows[0]);
  ret.lineItems = await fetchLineItems(ret.id);
  ret.refunds = await fetchRefunds(ret.id);
  return ret;
}
export async function list(opts: {
  branchId?: number; customerId?: number; transactionId?: number;
  status?: string; dateFrom?: string; dateTo?: string; page?: number; pageSize?: number;
}): Promise<{ items: ReturnRow[]; total: number; page: number; totalPages: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, opts.pageSize ?? 25);
  const offset = (page - 1) * pageSize;
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (opts.branchId)      { params.push(opts.branchId);      conditions.push(`r.branch_id = $${params.length}`); }
  if (opts.customerId)    { params.push(opts.customerId);    conditions.push(`r.customer_id = $${params.length}`); }
  if (opts.transactionId) { params.push(opts.transactionId); conditions.push(`r.transaction_id = $${params.length}`); }
  if (opts.status)        { params.push(opts.status);        conditions.push(`r.status = $${params.length}`); }
  if (opts.dateFrom)      { params.push(opts.dateFrom);      conditions.push(`r.created_at >= $${params.length}`); }
  if (opts.dateTo)        { params.push(opts.dateTo);        conditions.push(`r.created_at <= $${params.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const li = params.length + 1; const oi = params.length + 2;
  const [countRes, dataRes] = await Promise.all([
    db.query(`SELECT COUNT(*) FROM returns r ${where}`, params),
    db.query(`SELECT r.* FROM returns r ${where} ORDER BY r.created_at DESC LIMIT $${li} OFFSET $${oi}`, [...params, pageSize, offset]),
  ]);
  return { items: dataRes.rows.map(mapReturnRow), total: parseInt(countRes.rows[0].count as string, 10), page, totalPages: Math.ceil(parseInt(countRes.rows[0].count as string, 10) / pageSize) };
}
export async function createReturn(
  data: { transactionId: number; refundMethod: 'cash' | 'store_credit'; reason?: string; lines: ReturnLineInput[]; approvedBy?: number | null; },
  staffCtx: StaffCtx,
): Promise<ReturnRow> {
  if (!data.lines || data.lines.length === 0) throw new ValidationError('At least one line item is required');
  const txRes = await db.query(`SELECT t.*, l.branch_id AS loc_branch_id FROM transactions t JOIN locations l ON l.id = t.location_id WHERE t.id = $1`, [data.transactionId]);
  if (!txRes.rows.length) throw new NotFoundError('Transaction');
  const tx = txRes.rows[0] as Record<string, unknown>;
  if (tx.status === 'voided') throw new BusinessError('TRANSACTION_VOIDED', 'Cannot return a voided transaction');
  // Admin and Super_Admin have cross-branch authority; Sales and Stock_Clerk are branch-scoped
  const isCrossBranchRole = ['Admin', 'Super_Admin'].includes(staffCtx.role);
  if (!isCrossBranchRole && Number(tx.branch_id) !== staffCtx.branchId) {
    throw new ForbiddenError('Transaction belongs to a different branch');
  }
  const windowDays = await getReturnWindowDays(staffCtx.branchId);
  const daysSinceTx = (Date.now() - (tx.created_at as Date).getTime()) / (1000 * 60 * 60 * 24);
  if (daysSinceTx > windowDays) {
    const policy = await getRefundMethodAfterWindow();
    if (policy === 'store_credit_only' && data.refundMethod !== 'store_credit')
      throw new BusinessError('REFUND_METHOD_NOT_ALLOWED_AFTER_WINDOW', `Return window of ${windowDays} days exceeded. Only store_credit refunds are allowed.`, { windowDays, daysSinceTx: Math.floor(daysSinceTx) });
  }
  interface RL { txLineItemId: number; bookId: number; quantity: number; unitPrice: number; discountPct: number; lineRefundAmount: number; }
  const resolvedLines: RL[] = [];
  for (const input of data.lines) {
    const liRes = await db.query(`SELECT tli.* FROM transaction_line_items tli WHERE tli.id = $1 AND tli.transaction_id = $2`, [input.transactionLineItemId, data.transactionId]);
    if (!liRes.rows.length) throw new NotFoundError(`Transaction line item ${input.transactionLineItemId}`);
    const li = liRes.rows[0] as Record<string, unknown>;
    const soldQty = li.quantity as number;
    const alreadyRes = await db.query(`SELECT COALESCE(SUM(rli.quantity),0) AS returned_qty FROM return_line_items rli JOIN returns ret ON ret.id = rli.return_id WHERE rli.transaction_line_item_id = $1 AND ret.status = 'completed'`, [input.transactionLineItemId]);
    const alreadyReturned = parseInt(alreadyRes.rows[0].returned_qty as string, 10);
    const maxReturnable = soldQty - alreadyReturned;
    if (input.quantity <= 0) throw new ValidationError(`Quantity must be positive`);
    if (input.quantity > maxReturnable) throw new BusinessError('OVER_RETURN', `Cannot return ${input.quantity} units. Max returnable: ${maxReturnable}`, { soldQty, alreadyReturned, requested: input.quantity, maxReturnable });
    const unitPrice = parseFloat(li.unit_price as string);
    const discountPct = parseFloat(li.discount_pct as string);
    resolvedLines.push({ txLineItemId: input.transactionLineItemId, bookId: li.book_id as number, quantity: input.quantity, unitPrice, discountPct, lineRefundAmount: parseFloat((unitPrice * input.quantity * (1 - discountPct / 100)).toFixed(2)) });
  }
  const totalRefundAmount = parseFloat(resolvedLines.reduce((s, l) => s + l.lineRefundAmount, 0).toFixed(2));
  const maxWithoutAuth = await getMaxReturnValueWithoutAuth();
  const isPrivileged = ['Manager', 'Admin'].includes(staffCtx.role);
  const effectiveApprovedBy = data.approvedBy ?? (isPrivileged ? staffCtx.staffId : null);
  if (totalRefundAmount > maxWithoutAuth && !effectiveApprovedBy)
    throw new BusinessError('APPROVAL_REQUIRED', `Refund of ETB ${totalRefundAmount} exceeds the limit of ETB ${maxWithoutAuth}. A Manager or Admin must process this return.`, { totalRefundAmount, maxWithoutAuth });
  const amountPaid = parseFloat(String(tx.amount_paid ?? tx.grand_total));
  if (totalRefundAmount > amountPaid + 0.01) throw new BusinessError('REFUND_EXCEEDS_PAID', `Refund ETB ${totalRefundAmount} exceeds amount paid ETB ${amountPaid}`, { totalRefundAmount, amountPaid });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const locationId = tx.location_id as number;
    for (const line of resolvedLines) {
      const invRes = await client.query(`SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2 FOR UPDATE`, [line.bookId, locationId]);
      const qtyBefore = (invRes.rows[0]?.quantity as number) ?? 0;
      await client.query(`UPDATE inventory SET quantity = quantity + $1, version = version + 1, updated_at = now() WHERE book_id = $2 AND location_id = $3`, [line.quantity, line.bookId, locationId]);
      await client.query(`INSERT INTO inventory_history (book_id, location_id, qty_before, qty_after, delta, reason_code, movement_type, reference_type, reference_id, notes, staff_id) VALUES ($1,$2,$3,$4,$5,'return','stock_in','pos_return',$6,$7,$8)`, [line.bookId, locationId, qtyBefore, qtyBefore + line.quantity, line.quantity, data.transactionId, `Return of ${line.quantity} unit(s)`, staffCtx.staffId]);
    }
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const cntRes = await client.query(`SELECT COUNT(*) FROM returns WHERE DATE(created_at) = CURRENT_DATE`);
    const returnNumber = `RET-${dateStr}-${String(parseInt(cntRes.rows[0].count as string, 10) + 1).padStart(4, '0')}`;
    const retRes = await client.query(`INSERT INTO returns (return_number, transaction_id, branch_id, customer_id, total_refund_amount, refund_method, status, reason, processed_by, approved_by) VALUES ($1,$2,$3,$4,$5,$6,'completed',$7,$8,$9) RETURNING id`, [returnNumber, data.transactionId, staffCtx.branchId, tx.customer_id ?? null, totalRefundAmount.toFixed(2), data.refundMethod, data.reason ?? null, staffCtx.staffId, effectiveApprovedBy ?? null]);
    const returnId = String(retRes.rows[0].id);
    for (const line of resolvedLines)
      await client.query(`INSERT INTO return_line_items (return_id, transaction_line_item_id, book_id, quantity, unit_price, line_refund_amount) VALUES ($1,$2,$3,$4,$5,$6)`, [returnId, line.txLineItemId, line.bookId, line.quantity, line.unitPrice.toFixed(2), line.lineRefundAmount.toFixed(2)]);
    await client.query(`INSERT INTO refunds (return_id, method, amount) VALUES ($1,$2,$3)`, [returnId, data.refundMethod, totalRefundAmount.toFixed(2)]);
    const customerId = tx.customer_id as number | null;
    if (data.refundMethod === 'store_credit' && customerId) {
      await client.query(`UPDATE store_credit_accounts SET balance = balance + $1 WHERE customer_id = $2`, [totalRefundAmount, customerId]);
      await client.query(`INSERT INTO store_credit_history (customer_id, ref_type, ref_id, amount, direction) VALUES ($1,'return',$2,$3,'credit')`, [customerId, returnId, totalRefundAmount]);
    }
    if (customerId) {
      const rate = await getLoyaltyAccrualRate(); const minAmount = await getLoyaltyMinTransactionAmount();
      const txSubtotal = parseFloat(tx.subtotal as string);
      if (txSubtotal >= minAmount && rate > 0) {
        const grandTotal = parseFloat(tx.grand_total as string);
        const accrualRes = await client.query(`SELECT COALESCE(SUM(points_delta),0) AS total_accrued FROM loyalty_history WHERE customer_id = $1 AND transaction_ref = $2 AND reason = 'ACCRUAL'`, [customerId, tx.transaction_number]);
        const totalAccrued = Number(accrualRes.rows[0].total_accrued);
        if (totalAccrued > 0 && grandTotal > 0) {
          const pts = Math.floor(totalAccrued * (totalRefundAmount / grandTotal));
          if (pts > 0) {
            await client.query(`UPDATE loyalty_accounts SET points_balance = GREATEST(0, points_balance - $1), updated_at = now() WHERE customer_id = $2`, [pts, customerId]);
            await client.query(`INSERT INTO loyalty_history (customer_id, transaction_ref, points_delta, reason) VALUES ($1,$2,$3,'RETURN_REVERSAL')`, [customerId, tx.transaction_number, -pts]);
          }
        }
      }
    }
    await client.query(`INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta) VALUES ($1,$2,'CREATE','return',$3,$4,$5)`, [staffCtx.staffId, staffCtx.role, returnId, staffCtx.branchId, JSON.stringify({ returnNumber, transactionId: data.transactionId, totalRefundAmount, refundMethod: data.refundMethod })]);
    await client.query('COMMIT');
    return getById(returnId);
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
}
export async function rejectReturn(id: string | number, staffCtx: StaffCtx): Promise<ReturnRow> {
  const ret = await getById(id);
  if (ret.status === 'rejected') throw new BusinessError('ALREADY_REJECTED', 'Return is already rejected');
  if (ret.status === 'completed') throw new BusinessError('ALREADY_COMPLETED', 'Cannot reject a completed return');
  await db.query(`UPDATE returns SET status = 'rejected' WHERE id = $1`, [id]);
  await db.query(`INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta) VALUES ($1,$2,'UPDATE','return',$3,$4,$5)`, [staffCtx.staffId, staffCtx.role, String(id), staffCtx.branchId, JSON.stringify({ action: 'reject', returnNumber: ret.returnNumber })]);
  return getById(id);
}

