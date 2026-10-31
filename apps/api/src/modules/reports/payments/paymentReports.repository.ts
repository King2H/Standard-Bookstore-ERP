import type { Queryable } from '../../../db/tx.js';
import { reportRows } from '../../../db/reportDb.js';
import { scopeConditions, where, type ReportFilters, type ReportScope } from '../reportScope.js';

// Payment reports (#22). Customer money in and out (owner decision a): order,
// POS and exchange payments and collections of exchange differences owed in;
// order refunds, return refunds and exchange refunds out, each dated when the
// money moved. A voided sale or exchange
// handed its money back, so it is left out altogether.

export const CUSTOMER_MONEY = `
  WITH money AS (
    SELECT op.payment_method AS method, op.amount, 'in' AS direction, op.processed_at AS at, o.branch_id
    FROM order_payments op JOIN orders o ON o.id = op.order_id
    -- A refunded payment still came in; its refund goes out below (#167).
    WHERE op.status IN ('success', 'partially_refunded', 'refunded')
    UNION ALL
    SELECT tp.method, tp.amount, 'in', tp.created_at, t.branch_id
    FROM transaction_payments tp JOIN transactions t ON t.id = tp.transaction_id
    WHERE t.status <> 'voided'
    UNION ALL
    SELECT COALESCE(ese.method, 'cash'), ese.amount,
           CASE WHEN ese.entry_type = 'cash_payment' THEN 'in' ELSE 'out' END, ese.created_at, e.branch_id
    FROM exchange_settlement_entries ese JOIN exchanges e ON e.id = ese.exchange_id
    WHERE ese.entry_type IN ('cash_payment', 'cash_refund') AND e.status IN ('Completed', 'COMPLETED')
    UNION ALL
    -- An exchange difference owed has no payment flow of its own: its
    -- receivable's collections are booked in the ledger.
    SELECT COALESCE(ft.method, 'cash'), ft.amount, 'in', ft.created_at, ft.branch_id
    FROM financial_transactions ft
    WHERE ft.type = 'payment' AND ft.exchange_id IS NOT NULL
    UNION ALL
    SELECT COALESCE(ore.method, op2.payment_method, 'cash'), ore.refund_amount, 'out', ore.created_at, o2.branch_id
    FROM order_refunds ore JOIN orders o2 ON o2.id = ore.order_id
    LEFT JOIN order_payments op2 ON op2.id = ore.payment_id
    UNION ALL
    -- A credit note took the value off a debt: no money went out.
    SELECT rf.method, rf.amount, 'out', rf.created_at, r.branch_id
    FROM refunds rf JOIN returns r ON r.id = rf.return_id
    WHERE r.status = 'completed' AND rf.method <> 'credit_note'
  )`;

export async function moneyTotals(q: Queryable, scope: ReportScope): Promise<{ collected: string; refunded: string }> {
  const { conditions, params } = scopeConditions(scope, 'm', { column: 'at' });
  const [row] = await reportRows<{ collected: string; refunded: string }>(
    q,
    `${CUSTOMER_MONEY}
     SELECT COALESCE(SUM(CASE WHEN m.direction = 'in' THEN m.amount END), 0)::NUMERIC AS collected,
            COALESCE(SUM(CASE WHEN m.direction = 'out' THEN m.amount END), 0)::NUMERIC AS refunded
     FROM money m ${where(conditions)}`,
    params,
  );
  return row;
}

/** Money in by method code. */
export async function collectedByMethod(q: Queryable, scope: ReportScope): Promise<Array<{ method: string; total: string; count: number }>> {
  const { conditions, params } = scopeConditions(scope, 'm', { column: 'at' });
  return reportRows(
    q,
    `${CUSTOMER_MONEY}
     SELECT m.method, COALESCE(SUM(m.amount), 0)::NUMERIC AS total, COUNT(*)::INTEGER AS count
     FROM money m ${where([`m.direction = 'in'`, ...conditions])}
     GROUP BY m.method
     ORDER BY total DESC, m.method`,
    params,
  );
}

/** Money in and out per day, week or month (the bucket name is from a fixed list, never request text). */
export async function moneyByPeriod(q: Queryable, filters: ReportFilters): Promise<Array<{ period: string; collected: string; refunded: string }>> {
  const { conditions, params } = scopeConditions(filters, 'm', { column: 'at' });
  const bucket = `date_trunc('${filters.groupBy}', m.at)`;
  return reportRows(
    q,
    `${CUSTOMER_MONEY}
     SELECT ${bucket}::TEXT AS period,
            COALESCE(SUM(CASE WHEN m.direction = 'in' THEN m.amount END), 0)::NUMERIC AS collected,
            COALESCE(SUM(CASE WHEN m.direction = 'out' THEN m.amount END), 0)::NUMERIC AS refunded
     FROM money m ${where(conditions)}
     GROUP BY ${bucket}
     ORDER BY ${bucket}`,
    params,
  );
}

/** Order payments recorded but not yet confirmed. */
export async function pendingOrderPayments(q: Queryable, scope: ReportScope): Promise<string> {
  const { conditions, params } = scopeConditions(scope, 'op', { column: 'processed_at', branchAlias: 'o' });
  const [row] = await reportRows<{ pending: string }>(
    q,
    `SELECT COALESCE(SUM(op.amount), 0)::NUMERIC AS pending
     FROM order_payments op JOIN orders o ON o.id = op.order_id
     ${where([`op.status = 'pending'`, ...conditions])}`,
    params,
  );
  return row.pending;
}

export interface LedgerRow {
  receipt_no: string;
  party: string;
  reference_no: string;
  payment_method: string | null;
  payer_bank: string | null;
  payment_ref: string | null;
  amount: string;
  entry_type?: string;
  date_str: string;
  staff_username: string | null;
}

/** Every receipt and payment of the ledger, one query per source, each with its own branch and date columns. */
export async function ledgerSources(q: Queryable, scope: ReportScope): Promise<Record<'order' | 'pos' | 'returnRefund' | 'orderRefund' | 'exchange' | 'exchangeCollection' | 'supplier', LedgerRow[]>> {
  const range = (alias: string, branch: string, column = 'created_at') => {
    const { conditions, params } = scopeConditions(scope, alias, { column, branchAlias: branch });
    return { and: conditions.map((c) => `AND ${c}`).join(' '), params };
  };
  const order = range('op', 'o', 'processed_at');
  const pos = range('t', 't');
  const returnRefund = range('rf', 'r');
  const orderRefund = range('ore', 'o2');
  const exchange = range('ese', 'e');
  const collection = range('ft', 'ft');
  const supplier = range('sp', 'sp');

  const [o, p, rr, orf, ex, col, sup] = await Promise.all([
    reportRows<LedgerRow>(
      q,
      `SELECT op.payment_reference AS receipt_no, COALESCE(c.full_name, 'Walk-in') AS party,
              o.order_number AS reference_no, op.payment_method,
              op.payer_bank, op.transaction_reference AS payment_ref,
              op.amount, TO_CHAR(op.processed_at, 'YYYY-MM-DD') AS date_str, s.username AS staff_username
       FROM order_payments op
       JOIN orders o ON o.id = op.order_id
       LEFT JOIN customers c ON c.id = o.customer_id
       LEFT JOIN staff s ON s.id = op.processed_by
       WHERE op.status IN ('success', 'partially_refunded', 'refunded') ${order.and}`,
      order.params,
    ),
    reportRows<LedgerRow>(
      q,
      `SELECT ('TXN-PAY-' || tp.id) AS receipt_no, COALESCE(c.full_name, 'Walk-in') AS party,
              t.transaction_number AS reference_no, tp.method AS payment_method,
              tp.payer_bank, tp.reference AS payment_ref,
              tp.amount, TO_CHAR(tp.created_at, 'YYYY-MM-DD') AS date_str, s.username AS staff_username
       FROM transaction_payments tp
       JOIN transactions t ON t.id = tp.transaction_id
       LEFT JOIN customers c ON c.id = t.customer_id
       LEFT JOIN staff s ON s.id = t.staff_id
       WHERE t.status <> 'voided' ${pos.and}`,
      pos.params,
    ),
    reportRows<LedgerRow>(
      q,
      `SELECT ('REF-' || rf.id) AS receipt_no, COALESCE(c.full_name, 'Walk-in') AS party,
              r.return_number AS reference_no, rf.method AS payment_method,
              NULL::text AS payer_bank, NULL::text AS payment_ref,
              rf.amount, TO_CHAR(rf.created_at, 'YYYY-MM-DD') AS date_str, s.username AS staff_username
       FROM refunds rf
       JOIN returns r ON r.id = rf.return_id
       LEFT JOIN customers c ON c.id = r.customer_id
       LEFT JOIN staff s ON s.id = r.processed_by
       WHERE r.status = 'completed' AND rf.method <> 'credit_note' ${returnRefund.and}`,
      returnRefund.params,
    ),
    reportRows<LedgerRow>(
      q,
      `SELECT ('OREF-' || ore.id) AS receipt_no, COALESCE(c.full_name, 'Walk-in') AS party,
              o2.order_number AS reference_no, COALESCE(ore.method, op2.payment_method, 'cash') AS payment_method,
              NULL::text AS payer_bank, NULL::text AS payment_ref,
              ore.refund_amount AS amount, TO_CHAR(ore.created_at, 'YYYY-MM-DD') AS date_str, s.username AS staff_username
       FROM order_refunds ore
       JOIN orders o2 ON o2.id = ore.order_id
       LEFT JOIN order_payments op2 ON op2.id = ore.payment_id
       LEFT JOIN customers c ON c.id = o2.customer_id
       LEFT JOIN staff s ON s.id = ore.processed_by
       WHERE true ${orderRefund.and}`,
      orderRefund.params,
    ),
    // A voided exchange handed its money back without a refund entry, so its
    // entries are left out (as voided POS sales are).
    reportRows<LedgerRow>(
      q,
      `SELECT ('EXST-' || ese.id) AS receipt_no, COALESCE(c.full_name, 'Walk-in') AS party,
              e.exchange_reference AS reference_no, COALESCE(ese.method, 'cash') AS payment_method,
              ese.payer_bank, ese.reference AS payment_ref,
              ese.amount, ese.entry_type, TO_CHAR(ese.created_at, 'YYYY-MM-DD') AS date_str, s.username AS staff_username
       FROM exchange_settlement_entries ese
       JOIN exchanges e ON e.id = ese.exchange_id
       LEFT JOIN customers c ON c.id = e.customer_id
       LEFT JOIN staff s ON s.id = ese.authorised_by
       WHERE ese.entry_type IN ('cash_payment', 'cash_refund') AND e.status IN ('Completed', 'COMPLETED') ${exchange.and}`,
      exchange.params,
    ),
    reportRows<LedgerRow>(
      q,
      `SELECT ('PAY-EXC-' || ft.id) AS receipt_no, COALESCE(c.full_name, 'Walk-in') AS party,
              e.exchange_reference AS reference_no, ft.method AS payment_method,
              ft.meta->>'payerBank' AS payer_bank, ft.meta->>'transactionReference' AS payment_ref,
              ft.amount, TO_CHAR(ft.created_at, 'YYYY-MM-DD') AS date_str, s.username AS staff_username
       FROM financial_transactions ft
       JOIN exchanges e ON e.id = ft.exchange_id
       LEFT JOIN customers c ON c.id = e.customer_id
       LEFT JOIN staff s ON s.id = ft.staff_id
       WHERE ft.type = 'payment' ${collection.and}`,
      collection.params,
    ),
    // A reversed supplier payment was a mistake: it was never paid.
    reportRows<LedgerRow>(
      q,
      `SELECT COALESCE(sp.payment_number, 'SUP-' || sp.id) AS receipt_no, s2.name AS party,
              ('PO-' || LPAD(sp.po_id::text, 6, '0')) AS reference_no, sp.payment_method,
              NULL::text AS payer_bank, NULL::text AS payment_ref,
              sp.amount, TO_CHAR(sp.created_at, 'YYYY-MM-DD') AS date_str, s.username AS staff_username
       FROM supplier_payments sp
       JOIN suppliers s2 ON s2.id = sp.supplier_id
       LEFT JOIN staff s ON s.id = sp.created_by
       WHERE sp.reversed_at IS NULL ${supplier.and}`,
      supplier.params,
    ),
  ]);
  return { order: o, pos: p, returnRefund: rr, orderRefund: orf, exchange: ex, exchangeCollection: col, supplier: sup };
}
