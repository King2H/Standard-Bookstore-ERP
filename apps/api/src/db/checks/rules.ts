/**
 * The data consistency check's rules (#165): what must hold across tables
 * that no single constraint can enforce. Each query returns the rows that
 * break the rule, as `tenant_id` and a short `ref` naming the row. Read-only;
 * run by `npm run db:check` as the database owner, so every tenant is seen.
 *
 * An error means money or stock is wrong; a warning means data to look at.
 * What a database constraint already guarantees is not repeated here (a
 * receivable's balance below 0, a purchase order line received above its
 * quantity).
 */

export type Severity = 'error' | 'warning';

export interface Check {
  id: string;
  area: string;
  title: string;
  severity: Severity;
  sql: string;
}

// The daily document series and where each one's numbers are stored (lib/documentNumber.ts).
const DAILY_SERIES: Array<[series: string, table: string, column: string]> = [
  ['ORD', 'orders', 'order_number'],
  ['PAY', 'order_payments', 'payment_reference'],
  ['POS', 'transactions', 'transaction_number'],
  ['RET', 'returns', 'return_number'],
  ['EXC', 'exchanges', 'exchange_reference'],
  ['SPAY', 'supplier_payments', 'payment_number'],
  ['SCN', 'supplier_credit_notes', 'credit_note_number'],
];

const dailyNumbers = DAILY_SERIES.map(
  ([series, table, column]) => `
    SELECT tenant_id, '${series}' AS series, split_part(${column}, '-', 2) AS period, split_part(${column}, '-', 3)::int AS seq
    FROM ${table} WHERE ${column} ~ '^${series}-[0-9]{8}-[0-9]+$'`,
).join(' UNION ALL ');

const CLOSED_ORDER = `lower(o.status) IN ('cancelled', 'fulfilled', 'completed')`;

export const CHECKS: readonly Check[] = [
  // ── Stock ──────────────────────────────────────────────────────────────────
  {
    id: 'stock.matches-history',
    area: 'Stock',
    title: 'Quantity on hand equals the last movement in the history',
    severity: 'error',
    sql: `
      SELECT i.tenant_id, 'book ' || i.book_id || ' at location ' || i.location_id
             || ': on hand ' || i.quantity || ', history says ' || h.qty_after AS ref
      FROM inventory i
      JOIN LATERAL (
        SELECT qty_after FROM inventory_history h
        WHERE h.book_id = i.book_id AND h.location_id = i.location_id
        ORDER BY h.id DESC LIMIT 1
      ) h ON true
      WHERE h.qty_after <> i.quantity`,
  },
  {
    id: 'stock.has-history',
    area: 'Stock',
    title: 'Stock on hand has a movement history',
    severity: 'warning',
    sql: `
      SELECT i.tenant_id, 'book ' || i.book_id || ' at location ' || i.location_id || ': ' || i.quantity || ' on hand' AS ref
      FROM inventory i
      WHERE i.quantity <> 0
        AND NOT EXISTS (SELECT 1 FROM inventory_history h WHERE h.book_id = i.book_id AND h.location_id = i.location_id)`,
  },
  {
    id: 'stock.damaged-not-negative',
    area: 'Stock',
    title: 'Damaged counts are not negative',
    severity: 'error',
    sql: `
      SELECT tenant_id, 'book ' || book_id || ' at location ' || location_id || ': ' || damaged_quantity || ' damaged' AS ref
      FROM inventory WHERE damaged_quantity < 0`,
  },
  {
    id: 'stock.valued',
    area: 'Stock',
    title: 'Stock on hand has a cost (at 0 it adds nothing to the inventory value; Inventory > Revalue gives it one)',
    severity: 'warning',
    sql: `
      SELECT tenant_id, 'book ' || book_id || ' at location ' || location_id || ': ' || quantity || ' on hand at cost 0' AS ref
      FROM inventory WHERE quantity > 0 AND average_cost = 0`,
  },
  {
    id: 'stock.reservations-open-orders',
    area: 'Stock',
    title: 'Reserved stock belongs to an open order',
    severity: 'error',
    sql: `
      SELECT r.tenant_id, o.order_number || ' (' || o.status || '): book ' || r.book_id || ' x' || r.quantity || ' still reserved' AS ref
      FROM inventory_reservations r JOIN orders o ON o.id = r.order_id
      WHERE r.status = 'reserved' AND ${CLOSED_ORDER}`,
  },

  // ── Receivables ────────────────────────────────────────────────────────────
  {
    id: 'receivables.within-original',
    area: 'Receivables',
    title: 'A balance is no larger than the amount first owed',
    severity: 'error',
    sql: `
      SELECT tenant_id, 'receivable ' || id || ': owes ' || outstanding_amount || ' of ' || original_amount AS ref
      FROM receivables WHERE outstanding_amount > original_amount`,
  },
  {
    id: 'receivables.status-matches-balance',
    area: 'Receivables',
    title: 'An open receivable owes something; a settled, written-off or cancelled one owes nothing',
    severity: 'error',
    sql: `
      SELECT tenant_id, 'receivable ' || id || ' (' || status || '): owes ' || outstanding_amount AS ref
      FROM receivables
      WHERE (status IN ('Pending', 'PartiallyPaid', 'Overdue') AND outstanding_amount = 0)
         OR (status IN ('Settled', 'WrittenOff', 'Cancelled') AND outstanding_amount <> 0)`,
  },

  // ── Orders ─────────────────────────────────────────────────────────────────
  {
    id: 'orders.payment-status',
    area: 'Orders',
    title: "An order's payment status agrees with the payments taken less refunds",
    severity: 'error',
    // The same rule as payments.policy.ts orderPaymentStatus().
    sql: `
      WITH t AS (
        SELECT o.tenant_id, o.order_number, o.sale_type, o.total, o.payment_status,
          COALESCE((SELECT SUM(amount) FROM order_payments p
                    WHERE p.order_id = o.id AND p.status IN ('success', 'partially_refunded', 'refunded')), 0) AS paid,
          COALESCE((SELECT SUM(refund_amount) FROM order_refunds r WHERE r.order_id = o.id), 0) AS refunded
        FROM orders o WHERE o.total IS NOT NULL
      ), e AS (
        SELECT *, CASE
          WHEN sale_type <> 'credit_sale' AND paid > 0 AND refunded >= paid THEN 'refunded'
          WHEN paid - refunded <= 0 THEN 'unpaid'
          WHEN paid - refunded >= total THEN 'paid'
          ELSE 'partial' END AS expected
        FROM t
      )
      SELECT tenant_id, order_number || ': ' || payment_status || ', payments say ' || expected
             || ' (paid ' || paid || ', refunded ' || refunded || ', total ' || total || ')' AS ref
      FROM e WHERE payment_status IS DISTINCT FROM expected`,
  },

  {
    id: 'orders.cancelled-money-returned',
    area: 'Orders',
    title: 'A cancelled order holds no money: what it took was given back (refund it in Payments)',
    severity: 'error',
    // Cancelling gives the money back since #167; an order cancelled before kept it.
    sql: `
      SELECT o.tenant_id, o.order_number || ': holds ' || (paid - refunded) || ' (paid ' || paid || ', refunded ' || refunded || ')' AS ref
      FROM orders o
      CROSS JOIN LATERAL (
        SELECT COALESCE((SELECT SUM(amount) FROM order_payments p
                         WHERE p.order_id = o.id AND p.status IN ('success', 'partially_refunded', 'refunded')), 0) AS paid,
               COALESCE((SELECT SUM(refund_amount) FROM order_refunds r WHERE r.order_id = o.id), 0) AS refunded
      ) m
      WHERE lower(o.status) = 'cancelled' AND paid - refunded > 0`,
  },

  // ── Purchase orders ────────────────────────────────────────────────────────
  {
    id: 'procurement.status-matches-lines',
    area: 'Purchase orders',
    title: 'An order\'s status agrees with what its lines received',
    severity: 'error',
    sql: `
      WITH l AS (
        SELECT po_id, SUM(received_quantity) AS received, BOOL_AND(received_quantity >= quantity) AS complete
        FROM po_line_items GROUP BY po_id
      )
      SELECT po.tenant_id, 'purchase order ' || po.id || ' (' || po.status || '): '
             || l.received || ' received, ' || CASE WHEN l.complete THEN 'all lines complete' ELSE 'lines open' END AS ref
      FROM purchase_orders po JOIN l ON l.po_id = po.id
      WHERE (po.status = 'received' AND NOT l.complete)
         OR (po.status = 'partially_received' AND (l.received = 0 OR l.complete))
         OR (po.status IN ('draft', 'pending_approval', 'approved', 'ordered', 'cancelled') AND l.received > 0)`,
  },
  {
    id: 'procurement.paid-within-total',
    area: 'Purchase orders',
    title: 'Payments and credit notes together are at most the ordered total',
    severity: 'error',
    sql: `
      WITH m AS (
        SELECT po.id, po.tenant_id, po.total_amount,
          COALESCE((SELECT SUM(amount) FROM supplier_payments p WHERE p.po_id = po.id AND p.reversed_at IS NULL), 0)
          + COALESCE((SELECT SUM(amount) FROM supplier_credit_notes c WHERE c.po_id = po.id), 0) AS settled
        FROM purchase_orders po
      )
      SELECT tenant_id, 'purchase order ' || id || ': paid and credited ' || settled || ' of ' || total_amount AS ref
      FROM m WHERE settled > total_amount`,
  },

  // ── Bank ───────────────────────────────────────────────────────────────────
  {
    id: 'bank.matched-line-cleared',
    area: 'Bank',
    title: 'A matched statement line points to a cleared movement',
    severity: 'error',
    sql: `
      SELECT l.tenant_id, 'statement line ' || l.id || ': movement ' || l.entry_id || ' is ' || COALESCE(e.status, 'missing') AS ref
      FROM bank_statement_lines l LEFT JOIN bank_reconciliation e ON e.id = l.entry_id
      WHERE l.entry_id IS NOT NULL AND (e.id IS NULL OR e.status <> 'cleared')`,
  },
  {
    id: 'bank.cleared-one-line',
    area: 'Bank',
    title: 'A cleared movement is matched by exactly one statement line',
    severity: 'error',
    sql: `
      SELECT e.tenant_id, 'movement ' || e.id || ': ' || COUNT(l.id) || ' matched lines' AS ref
      FROM bank_reconciliation e LEFT JOIN bank_statement_lines l ON l.entry_id = e.id
      WHERE e.status = 'cleared'
      GROUP BY e.tenant_id, e.id HAVING COUNT(l.id) <> 1`,
  },

  // ── Document numbers ───────────────────────────────────────────────────────
  {
    id: 'numbers.daily-counters-ahead',
    area: 'Document numbers',
    title: "Today's counters are ahead of the highest number already used",
    severity: 'error',
    // Only today and later matter: a past day's series never hands out another number.
    sql: `
      WITH d AS (
        SELECT tenant_id, series, period, MAX(seq) AS used FROM (${dailyNumbers}) n
        WHERE period >= TO_CHAR(CURRENT_DATE, 'YYYYMMDD')
        GROUP BY tenant_id, series, period
      )
      SELECT d.tenant_id, d.series || '-' || d.period || ': highest used ' || d.used
             || ', counter at ' || COALESCE(c.last_value::text, 'none') AS ref
      FROM d LEFT JOIN document_counters c ON c.tenant_id = d.tenant_id AND c.series = d.series AND c.period = d.period
      WHERE c.last_value IS NULL OR c.last_value < d.used`,
  },
  {
    id: 'numbers.customer-counter-ahead',
    area: 'Document numbers',
    title: 'The customer code counter is ahead of the highest code already used',
    severity: 'error',
    sql: `
      WITH d AS (
        SELECT tenant_id, MAX(substring(customer_code FROM '^CUS-([0-9]+)$')::int) AS used
        FROM customers WHERE customer_code ~ '^CUS-[0-9]+$' GROUP BY tenant_id
      )
      SELECT d.tenant_id, 'CUS: highest used ' || d.used || ', counter at ' || COALESCE(c.last_value::text, 'none') AS ref
      FROM d LEFT JOIN document_counters c ON c.tenant_id = d.tenant_id AND c.series = 'CUS' AND c.period = ''
      WHERE c.last_value IS NULL OR c.last_value < d.used`,
  },

  // ── Test data ──────────────────────────────────────────────────────────────
  {
    id: 'test-data.branches',
    area: 'Test data',
    title: 'No branches left by the test suite',
    severity: 'warning',
    // tests/helpers/seed.ts gives every test branch this address and email.
    sql: `
      SELECT tenant_id, 'branch ' || id || ': ' || name AS ref
      FROM branches WHERE address = '123 Test Street' OR contact_info->>'email' = 'test@branch.com'`,
  },
  {
    id: 'test-data.staff',
    area: 'Test data',
    title: 'No staff accounts left by the test suite',
    severity: 'warning',
    // tests/helpers/seed.ts names every test account "Test Staff".
    sql: `SELECT tenant_id, 'staff ' || id || ': ' || username AS ref FROM staff WHERE full_name = 'Test Staff'`,
  },
];
