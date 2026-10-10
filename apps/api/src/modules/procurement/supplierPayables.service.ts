import { db } from '../../db/index.js';
import { queryableOn } from '../../db/tx.js';
import { BusinessError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { getById, refreshFinancialStatus } from './procurement.service.js';
import type { Actor as StaffCtx, PurchaseOrderRecord } from './procurement.types.js';

// Supplier payables, still in their v1 shape: they move to the layers in
// procurement part 2 (#21). Purchase orders themselves are in
// procurement.service.ts.

// ── Payment lifecycle (Module 1 — stabilization sprint; Prompt 2 — received-
// value payable basis) ──────────────────────────────────────────────────────
//
// purchase_orders.financial_status is the source of truth for "has this PO
// been paid" and is derived -- never set directly by callers -- from the sum
// of supplier_payments and supplier_credit_notes against the PO vs. its
// RECEIVED VALUE (SUM(received_quantity × unit_cost) across its line items),
// not its full total_amount. Standard AP practice: a payable is recognized
// as goods are received, not merely ordered — a partially-received PO only
// obligates payment for what's actually arrived so far (Prompt 2 decision
// #5). PO operational status (draft -> ... -> closed) never implies
// payment: closePO() does not touch financial_status, and only
// recomputeFinancialStatus() (called from createSupplierPayment(),
// createSupplierCreditNote(), and, for cash terms, from receivePO()) may
// write it.

// ── createSupplierPayment ────────────────────────────────────────────────────
// Records a manual supplier payment against a PO and recomputes financial_status.
// Reuses the same PO-existence / status checks as the rest of this module
// rather than introducing a parallel payment pipeline.

// Prompt 2 decision #4: this function (together with receivePO()'s
// cash-terms auto-pay branch) is THE sole mutation path for supplier
// payments — procurement.service.ts is the authoritative supplier-payment
// domain, kept architecturally separate from the customer-facing Payments
// module (apps/api/src/modules/payments/), which is authoritative for
// customer collections. No other module may INSERT INTO supplier_payments.
export async function createSupplierPayment(
  poId: number | string,
  data: { amount: number; paymentMethod?: string; notes?: string | null },
  staffCtx: StaffCtx,
): Promise<PurchaseOrderRecord> {
  if (!(data.amount > 0)) throw new ValidationError('Payment amount must be positive');

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const poRes = await client.query(
      `SELECT status, branch_id, supplier_id FROM purchase_orders WHERE id = $1 FOR UPDATE`,
      [poId],
    );
    if (!poRes.rows.length) throw new NotFoundError('Purchase Order');
    const po = poRes.rows[0] as { status: string; branch_id: number; supplier_id: number };

    const unpayableStatuses = ['draft', 'pending_approval', 'cancelled'];
    if (unpayableStatuses.includes(po.status)) {
      throw new BusinessError(
        'PO_NOT_PAYABLE',
        `Cannot record a payment against a Purchase Order in status '${po.status}'`,
      );
    }

    await client.query(
      `INSERT INTO supplier_payments (po_id, branch_id, supplier_id, amount, payment_method, source, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, 'manual', $6, $7)`,
      [
        poId, po.branch_id, po.supplier_id,
        data.amount.toFixed(2), data.paymentMethod ?? 'cash',
        data.notes ?? null, staffCtx.staffId,
      ],
    );

    await refreshFinancialStatus(queryableOn(client), String(poId));

    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1, $2, 'CREATE', 'supplier_payment', $3, $4, $5)`,
      [staffCtx.staffId, staffCtx.role, String(poId), staffCtx.branchId,
       JSON.stringify({ amount: data.amount, paymentMethod: data.paymentMethod ?? 'cash' })],
    );

    await client.query('COMMIT');
    return getById(String(poId));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── createSupplierCreditNote ─────────────────────────────────────────────────
// A supplier-issued credit against a PO (damaged goods, an overcharge, a
// negotiated price adjustment) — the supported mechanism for "correcting"
// a PO's economics after receipt, since updatePO() only allows line-item
// edits while status === 'draft' (PO_NOT_EDITABLE otherwise). Reduces the
// PO's outstanding balance the same way a payment does, without pretending
// cash actually changed hands.

export async function createSupplierCreditNote(
  poId: number | string,
  data: { amount: number; reason: string },
  staffCtx: StaffCtx,
): Promise<PurchaseOrderRecord> {
  if (!(data.amount > 0)) throw new ValidationError('Credit note amount must be positive');
  if (!data.reason || !data.reason.trim()) throw new ValidationError('A reason is required for a credit note');

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const poRes = await client.query(
      `SELECT status, branch_id, supplier_id FROM purchase_orders WHERE id = $1 FOR UPDATE`,
      [poId],
    );
    if (!poRes.rows.length) throw new NotFoundError('Purchase Order');
    const po = poRes.rows[0] as { status: string; branch_id: number; supplier_id: number };

    // Same eligibility as a payment — a credit note only makes sense once
    // the PO is a real financial obligation.
    const uncreditableStatuses = ['draft', 'pending_approval', 'cancelled'];
    if (uncreditableStatuses.includes(po.status)) {
      throw new BusinessError(
        'PO_NOT_CREDITABLE',
        `Cannot record a credit note against a Purchase Order in status '${po.status}'`,
      );
    }

    await client.query(
      `INSERT INTO supplier_credit_notes (po_id, supplier_id, branch_id, amount, reason, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [poId, po.supplier_id, po.branch_id, data.amount.toFixed(2), data.reason.trim(), staffCtx.staffId],
    );

    await refreshFinancialStatus(queryableOn(client), String(poId));

    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1, $2, 'CREATE', 'supplier_credit_note', $3, $4, $5)`,
      [staffCtx.staffId, staffCtx.role, String(poId), staffCtx.branchId,
       JSON.stringify({ amount: data.amount, reason: data.reason })],
    );

    await client.query('COMMIT');
    return getById(String(poId));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Supplier Ledger ──────────────────────────────────────────────────────────
// Running-balance ledger: PO / Goods Receipt / Payment / Credit Note rows in
// chronological order, with a running balance computed here (not stored —
// see the migration's header comment for why). Balance convention: each
// Goods Receipt INCREASES what's owed (by the value actually received);
// each Payment and Credit Note DECREASES it. A plain "PO created" row
// carries no balance movement of its own — see the received-value payable
// basis (Prompt 2 decision #5) — it exists purely for visibility of when
// the commitment was made.

export type SupplierLedgerEntryType = 'PO' | 'GOODS_RECEIPT' | 'PAYMENT' | 'CREDIT_NOTE';

export interface SupplierLedgerEntry {
  date: string;
  type: SupplierLedgerEntryType;
  reference: string;
  description: string;
  amount: number;       // signed: + for goods receipts, - for payments/credit notes
  balance: number;       // running balance after this entry
}

export async function getSupplierLedger(
  supplierId: number,
  filters: { dateFrom?: string; dateTo?: string } = {},
): Promise<{ entries: SupplierLedgerEntry[]; currentBalance: number }> {
  const supRes = await db.query(`SELECT id FROM suppliers WHERE id = $1`, [supplierId]);
  if (!supRes.rows.length) throw new NotFoundError('Supplier');

  interface RawEvent { date: Date; type: SupplierLedgerEntryType; reference: string; description: string; amount: number; }
  const events: RawEvent[] = [];

  // PO creation — informational only (amount 0, no balance movement); lets
  // the ledger show the commitment even before anything is received.
  const poRes = await db.query(
    `SELECT id, created_at, total_amount FROM purchase_orders WHERE supplier_id = $1 AND status NOT IN ('draft','cancelled')`,
    [supplierId],
  );
  for (const row of poRes.rows as Record<string, unknown>[]) {
    events.push({
      date: row.created_at as Date, type: 'PO',
      reference: `PO-${String(row.id).padStart(6, '0')}`,
      description: `Purchase order created (ordered value ${parseFloat(row.total_amount as string).toFixed(2)})`,
      amount: 0,
    });
  }

  // Goods receipts — one ledger row per receipt, valued at the receipt's
  // own line items (received_quantity_at_that_event × unit_cost). Since
  // po_receipt_items doesn't itself carry unit_cost, join back to the
  // owning po_line_items for its cost.
  const receiptRes = await db.query(
    `SELECT r.id, r.po_id, r.received_at, po.id AS po_ref,
            COALESCE(SUM(ri.quantity_received * pli.unit_cost), 0) AS value
     FROM po_receipts r
     JOIN purchase_orders po ON po.id = r.po_id
     JOIN po_receipt_items ri ON ri.receipt_id = r.id
     JOIN po_line_items pli ON pli.id = ri.po_line_item_id
     WHERE po.supplier_id = $1
     GROUP BY r.id, r.po_id, r.received_at, po.id`,
    [supplierId],
  );
  for (const row of receiptRes.rows as Record<string, unknown>[]) {
    events.push({
      date: row.received_at as Date, type: 'GOODS_RECEIPT',
      reference: `PO-${String(row.po_ref).padStart(6, '0')} / GRN-${row.id}`,
      description: `Goods received (value ${parseFloat(row.value as string).toFixed(2)})`,
      amount: parseFloat(row.value as string),
    });
  }

  // Payments
  const payRes = await db.query(
    `SELECT sp.id, sp.po_id, sp.amount, sp.payment_method, sp.created_at
     FROM supplier_payments sp WHERE sp.supplier_id = $1`,
    [supplierId],
  );
  for (const row of payRes.rows as Record<string, unknown>[]) {
    events.push({
      date: row.created_at as Date, type: 'PAYMENT',
      reference: `PO-${String(row.po_id).padStart(6, '0')} / PAY-${row.id}`,
      description: `Payment (${row.payment_method as string})`,
      amount: -parseFloat(row.amount as string),
    });
  }

  // Credit notes
  const creditRes = await db.query(
    `SELECT cn.id, cn.po_id, cn.amount, cn.reason, cn.created_at
     FROM supplier_credit_notes cn WHERE cn.supplier_id = $1`,
    [supplierId],
  );
  for (const row of creditRes.rows as Record<string, unknown>[]) {
    events.push({
      date: row.created_at as Date, type: 'CREDIT_NOTE',
      reference: `PO-${String(row.po_id).padStart(6, '0')} / CN-${row.id}`,
      description: row.reason as string,
      amount: -parseFloat(row.amount as string),
    });
  }

  events.sort((a, b) => a.date.getTime() - b.date.getTime());

  const dateFromMs = filters.dateFrom ? new Date(filters.dateFrom + 'T00:00:00Z').getTime() : null;
  const dateToMs = filters.dateTo ? new Date(filters.dateTo + 'T23:59:59Z').getTime() : null;

  let runningBalance = 0;
  const entries: SupplierLedgerEntry[] = [];
  for (const ev of events) {
    runningBalance = parseFloat((runningBalance + ev.amount).toFixed(2));
    const t = ev.date.getTime();
    if (dateFromMs !== null && t < dateFromMs) continue;
    if (dateToMs !== null && t > dateToMs) continue;
    entries.push({
      date: ev.date.toISOString().slice(0, 10),
      type: ev.type,
      reference: ev.reference,
      description: ev.description,
      amount: ev.amount,
      balance: runningBalance,
    });
  }

  return { entries, currentBalance: runningBalance };
}
