import { sql } from 'kysely';
import { Money } from '@bms/shared';
import type { Queryable } from '../../db/tx.js';
import type { LedgerEvent } from './supplierPayables.policy.js';

// Supplier payments and credit notes belong to their order's branch, the
// ordering branch that pays (owner decision 1a). The ledger takes the branch
// the controller scoped, or none for every branch.

/** A payment of the order, locked until the transaction ends. */
export async function lockPayment(
  q: Queryable,
  poId: string,
  paymentId: number,
): Promise<{ id: string; paymentNumber: string | null; amount: Money; reversedAt: Date | null } | undefined> {
  const row = await q
    .selectFrom('supplier_payments')
    .select(['id', 'payment_number', 'amount', 'reversed_at'])
    .where('id', '=', String(paymentId))
    .where('po_id', '=', poId)
    .forUpdate()
    .executeTakeFirst();
  return row && { id: String(row.id), paymentNumber: row.payment_number, amount: Money.of(row.amount), reversedAt: row.reversed_at };
}

export async function reversePayment(q: Queryable, paymentId: string, by: number, reason: string): Promise<void> {
  await q
    .updateTable('supplier_payments')
    .set({ reversed_at: sql<Date>`now()`, reversed_by: by, reversal_reason: reason })
    .where('id', '=', paymentId)
    .execute();
}

export async function insertCreditNote(
  q: Queryable,
  c: { creditNoteNumber: string; poId: string; supplierId: number; branchId: number; amount: Money; reason: string; createdBy: number },
): Promise<string> {
  const row = await q
    .insertInto('supplier_credit_notes')
    .values({
      credit_note_number: c.creditNoteNumber,
      po_id: c.poId,
      supplier_id: c.supplierId,
      branch_id: c.branchId,
      amount: c.amount.toFixed(2),
      reason: c.reason,
      created_by: c.createdBy,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return String(row.id);
}

export async function insertRefund(
  q: Queryable,
  r: {
    refundNumber: string; poId: string; branchId: number; supplierId: number; amount: Money; method: string;
    reference: string | null; bankAccountId: number | null; notes: string | null; createdBy: number;
  },
): Promise<number> {
  const row = await q
    .insertInto('supplier_refunds')
    .values({
      refund_number: r.refundNumber,
      po_id: r.poId,
      branch_id: r.branchId,
      supplier_id: r.supplierId,
      amount: r.amount.toFixed(2),
      refund_method: r.method,
      reference: r.reference,
      bank_account_id: r.bankAccountId,
      notes: r.notes,
      created_by: r.createdBy,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function supplierExists(q: Queryable, supplierId: number): Promise<boolean> {
  const row = await q.selectFrom('suppliers').select('id').where('id', '=', supplierId).executeTakeFirst();
  return row !== undefined;
}

/**
 * Everything that moved what is owed to the supplier, oldest first, with
 * each day in the database's calendar. Orders count from approval; a
 * reversed payment shows as paid and then reversed.
 */
export async function ledgerEvents(q: Queryable, supplierId: number, branchId: number | undefined): Promise<LedgerEvent[]> {
  const inBranch = branchId === undefined ? sql`TRUE` : sql`po.branch_id = ${branchId}`;
  const { rows } = await sql<{ day: string; type: LedgerEvent['type']; reference: string; description: string; amount: string }>`
    WITH orders AS (
      SELECT po.id, po.created_at, po.total_amount, 'PO-' || LPAD(po.id::text, 6, '0') AS po_number
      FROM purchase_orders po
      WHERE po.supplier_id = ${supplierId}
        AND po.status NOT IN ('draft', 'pending_approval', 'cancelled')
        AND ${inBranch}
    ),
    events AS (
      SELECT o.created_at AS at, 1 AS seq, o.id AS ref_id, 'PO' AS type, o.po_number AS reference,
             'Purchase order (ordered value ' || TO_CHAR(o.total_amount, 'FM999999999990.00') || ')' AS description,
             0::numeric AS amount
      FROM orders o
      UNION ALL
      SELECT r.received_at, 2, r.id, 'GOODS_RECEIPT', o.po_number || ' / GRN-' || r.id,
             'Goods received', SUM(ri.quantity_received * li.unit_cost)
      FROM po_receipts r
      JOIN orders o ON o.id = r.po_id
      JOIN po_receipt_items ri ON ri.receipt_id = r.id
      JOIN po_line_items li ON li.id = ri.po_line_item_id
      GROUP BY r.id, r.received_at, o.po_number
      UNION ALL
      SELECT sp.created_at, 3, sp.id, 'PAYMENT', o.po_number || ' / ' || COALESCE(sp.payment_number, 'SPAY-' || sp.id),
             'Payment (' || sp.payment_method || ')', -sp.amount
      FROM supplier_payments sp JOIN orders o ON o.id = sp.po_id
      UNION ALL
      SELECT sp.reversed_at, 4, sp.id, 'PAYMENT_REVERSAL', o.po_number || ' / ' || COALESCE(sp.payment_number, 'SPAY-' || sp.id),
             'Payment reversed: ' || sp.reversal_reason, sp.amount
      FROM supplier_payments sp JOIN orders o ON o.id = sp.po_id
      WHERE sp.reversed_at IS NOT NULL
      UNION ALL
      SELECT cn.created_at, 5, cn.id, 'CREDIT_NOTE', o.po_number || ' / ' || COALESCE(cn.credit_note_number, 'SCN-' || cn.id),
             cn.reason, -cn.amount
      FROM supplier_credit_notes cn JOIN orders o ON o.id = cn.po_id
      UNION ALL
      SELECT sr.created_at, 6, sr.id, 'SUPPLIER_REFUND', o.po_number || ' / ' || sr.refund_number,
             'Refund from the supplier (' || sr.refund_method || ')', sr.amount
      FROM supplier_refunds sr JOIN orders o ON o.id = sr.po_id
    )
    SELECT TO_CHAR(at, 'YYYY-MM-DD') AS day, type, reference, description, amount::text AS amount
    FROM events
    ORDER BY at, seq, ref_id`.execute(q);
  return rows.map((r) => ({ day: r.day, type: r.type, reference: r.reference, description: r.description, amount: Money.of(r.amount) }));
}
