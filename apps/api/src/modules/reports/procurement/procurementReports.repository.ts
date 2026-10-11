import type { Queryable } from '../../../db/tx.js';
import { reportRows } from '../../../db/reportDb.js';
import { scopeConditions, where, type ReportScope } from '../reportScope.js';

// Procurement reports (#22). What is owed on a PO is what was received, less
// what was paid (a reversed payment never was) and credited: the same basis
// as the PO's own financial status and the supplier ledger.

const PO_REFERENCE = (column: string) => `('PO-' || LPAD(${column}::text, 6, '0'))`;

const RECEIVED_VALUE = `COALESCE((SELECT SUM(pli.received_quantity * pli.unit_cost) FROM po_line_items pli WHERE pli.po_id = po.id), 0)`;
const PAID = `COALESCE((SELECT SUM(sp.amount) FROM supplier_payments sp WHERE sp.po_id = po.id AND sp.reversed_at IS NULL), 0)`;
const CREDITED = `COALESCE((SELECT SUM(cn.amount) FROM supplier_credit_notes cn WHERE cn.po_id = po.id), 0)`;
const OUTSTANDING = `(${RECEIVED_VALUE} - ${PAID} - ${CREDITED})`;

/** `po.branch_id = $1` when a branch is given; balances are as of now, not a range. */
const poBranch = (branchId: number | undefined): { conditions: string[]; params: unknown[] } =>
  branchId ? { conditions: ['po.branch_id = $1'], params: [branchId] } : { conditions: [], params: [] };

/** One row per PO line, POs created in the range. */
export async function procurementLines(q: Queryable, scope: ReportScope): Promise<Record<string, unknown>[]> {
  const { conditions, params } = scopeConditions(scope, 'po');
  return reportRows(
    q,
    `SELECT ${PO_REFERENCE('po.id')} AS po_reference,
            TO_CHAR(po.created_at, 'YYYY-MM-DD') AS date_str,
            s.name AS supplier_name, po.status, po.total_amount,
            COALESCE(b.sku, b.isbn) AS book_code, b.title,
            pli.quantity AS ordered_quantity, pli.received_quantity, pli.unit_cost,
            (pli.unit_cost * pli.quantity)::NUMERIC AS line_total
     FROM purchase_orders po
     JOIN suppliers s ON s.id = po.supplier_id
     JOIN po_line_items pli ON pli.po_id = po.id
     JOIN books b ON b.id = pli.book_id
     ${where(conditions)}
     ORDER BY po.created_at DESC, po.id, b.title`,
    params,
  );
}

export async function openPurchaseOrders(q: Queryable, branchId: number | undefined): Promise<Record<string, unknown>[]> {
  const b = poBranch(branchId);
  return reportRows(
    q,
    `SELECT ${PO_REFERENCE('po.id')} AS po_reference, s.name AS supplier_name,
            TO_CHAR(po.created_at, 'YYYY-MM-DD') AS order_date,
            TO_CHAR(po.expected_delivery_date, 'YYYY-MM-DD') AS expected_date,
            po.status, po.financial_status, po.total_amount,
            COALESCE((SELECT SUM(quantity) FROM po_line_items WHERE po_id = po.id), 0)::INTEGER AS ordered_qty,
            COALESCE((SELECT SUM(received_quantity) FROM po_line_items WHERE po_id = po.id), 0)::INTEGER AS received_qty,
            ${OUTSTANDING}::NUMERIC AS outstanding_amount
     FROM purchase_orders po
     JOIN suppliers s ON s.id = po.supplier_id
     ${where([`po.status NOT IN ('closed', 'cancelled')`, ...b.conditions])}
     ORDER BY po.created_at DESC`,
    b.params,
  );
}

export async function supplierBalances(q: Queryable, branchId: number | undefined): Promise<Array<{
  supplier_id: number; supplier_name: string; open_po_count: number; received_value: string; paid: string; credited: string;
}>> {
  const b = poBranch(branchId);
  return reportRows(
    q,
    `SELECT s.id AS supplier_id, s.name AS supplier_name,
            COUNT(DISTINCT po.id) FILTER (WHERE po.status NOT IN ('closed', 'cancelled'))::INTEGER AS open_po_count,
            COALESCE(SUM(${RECEIVED_VALUE}), 0)::NUMERIC AS received_value,
            COALESCE(SUM(${PAID}), 0)::NUMERIC AS paid,
            COALESCE(SUM(${CREDITED}), 0)::NUMERIC AS credited
     FROM purchase_orders po
     JOIN suppliers s ON s.id = po.supplier_id
     ${where([`po.status NOT IN ('draft', 'cancelled')`, ...b.conditions])}
     GROUP BY s.id, s.name
     ORDER BY s.name ASC`,
    b.params,
  );
}

/**
 * What is still owed per PO, with the days since its last goods receipt
 * (the event that created the payable; a PO has no due date). The days are
 * counted on the database's calendar, like every other report date.
 */
export async function payables(q: Queryable, branchId: number | undefined): Promise<Array<{
  supplier_name: string; po_reference: string; outstanding_amount: string; last_receipt_date: string | null; days_since_receipt: number | null;
}>> {
  const b = poBranch(branchId);
  return reportRows(
    q,
    `SELECT s.name AS supplier_name, ${PO_REFERENCE('po.id')} AS po_reference,
            ${OUTSTANDING}::NUMERIC AS outstanding_amount,
            TO_CHAR(lr.last_receipt_at, 'YYYY-MM-DD') AS last_receipt_date,
            (CURRENT_DATE - lr.last_receipt_at::date)::INTEGER AS days_since_receipt
     FROM purchase_orders po
     JOIN suppliers s ON s.id = po.supplier_id
     LEFT JOIN LATERAL (SELECT MAX(r.received_at) AS last_receipt_at FROM po_receipts r WHERE r.po_id = po.id) lr ON true
     ${where([`po.status NOT IN ('draft', 'cancelled')`, ...b.conditions])}
     ORDER BY po.id`,
    b.params,
  );
}

export async function purchasesBySupplier(q: Queryable, scope: ReportScope): Promise<Array<{
  supplier_id: number; supplier_name: string; po_count: number; ordered_value: string; received_value: string;
}>> {
  const { conditions, params } = scopeConditions(scope, 'po');
  return reportRows(
    q,
    `SELECT s.id AS supplier_id, s.name AS supplier_name,
            COUNT(DISTINCT po.id)::INTEGER AS po_count,
            COALESCE(SUM(po.total_amount), 0)::NUMERIC AS ordered_value,
            COALESCE(SUM(${RECEIVED_VALUE}), 0)::NUMERIC AS received_value
     FROM purchase_orders po
     JOIN suppliers s ON s.id = po.supplier_id
     ${where([`po.status <> 'cancelled'`, ...conditions])}
     GROUP BY s.id, s.name
     ORDER BY ordered_value DESC`,
    params,
  );
}

export async function purchasesByBook(q: Queryable, scope: ReportScope): Promise<Array<{
  book_id: number; title: string; isbn: string | null; ordered_qty: number; received_qty: number; total_value: string;
}>> {
  const { conditions, params } = scopeConditions(scope, 'po');
  return reportRows(
    q,
    `SELECT pli.book_id, b.title, b.isbn,
            SUM(pli.quantity)::INTEGER AS ordered_qty,
            SUM(pli.received_quantity)::INTEGER AS received_qty,
            SUM(pli.quantity * pli.unit_cost)::NUMERIC AS total_value
     FROM po_line_items pli
     JOIN purchase_orders po ON po.id = pli.po_id
     JOIN books b ON b.id = pli.book_id
     ${where([`po.status <> 'cancelled'`, ...conditions])}
     GROUP BY pli.book_id, b.title, b.isbn
     ORDER BY total_value DESC`,
    params,
  );
}

/** Payments made to suppliers in the range; a reversed payment was a mistake and never paid. */
export async function supplierPayments(q: Queryable, scope: ReportScope): Promise<Array<{
  date_str: string; supplier_name: string; po_reference: string; amount: string; payment_method: string; source: string; staff_username: string | null;
}>> {
  const { conditions, params } = scopeConditions(scope, 'sp');
  return reportRows(
    q,
    `SELECT TO_CHAR(sp.created_at, 'YYYY-MM-DD') AS date_str, s.name AS supplier_name,
            ${PO_REFERENCE('sp.po_id')} AS po_reference,
            sp.amount, sp.payment_method, sp.source, st.username AS staff_username
     FROM supplier_payments sp
     JOIN suppliers s ON s.id = sp.supplier_id
     LEFT JOIN staff st ON st.id = sp.created_by
     ${where(['sp.reversed_at IS NULL', ...conditions])}
     ORDER BY sp.created_at DESC`,
    params,
  );
}
