/**
 * Module 7 — Export Integrity regression tests.
 *
 * Covers the two money-accuracy bugs found in the CSV export layer, plus
 * the CSV/formula-injection guard added alongside them:
 *
 *   1. Sales export (formerly getSalesExportRows, now the Prompt 2
 *      getSalesReportRows() unified per-line export) double-subtracted
 *      discount_total from net_profit even though `orders.total` is
 *      already post-discount.
 *   2. Receivables export (getReceivablesExportRows) was hardcoded to
 *      source_type = 'order_credit_sale', silently excluding
 *      pos_credit_sale and exchange_difference receivables.
 *   3. csvBuilder.escapeCell() now neutralizes formula-trigger characters
 *      (=, +, -, @) at the start of free-text cells, without corrupting
 *      legitimate negative numbers in numeric columns.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';
import { db } from '../db/index.js';
import { buildCsv, type CsvColumnDef } from '../lib/csvBuilder.js';

const STAFF_PREFIX = 'exp_test_';
const BRANCH_PREFIX = 'Export Test ';
const ORDER_PREFIX = 'EXPTEST-';

// Parses a simple CSV body (no embedded newlines in our test fixtures) into
// an array of column->value row objects, keyed by header.
function parseCsv(csv: string): Record<string, string>[] {
  const body = csv.replace(/^\uFEFF/, '');
  const lines = body.split('\r\n').filter(l => l.length > 0);
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => {
    // Naive split is fine here — none of our fixture values contain commas.
    const cells = line.split(',');
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = cells[i]; });
    return row;
  });
}

async function getTestBook(): Promise<number> {
  const result = await db.query(`SELECT id FROM books WHERE is_active = true LIMIT 1`);
  if (!result.rows.length) throw new Error('No active books found');
  return result.rows[0].id as number;
}

async function getTestSupplier(): Promise<number> {
  const result = await db.query(
    `SELECT id FROM suppliers WHERE is_active = true AND is_blacklisted = false LIMIT 1`,
  );
  if (result.rows.length) return result.rows[0].id as number;
  const created = await db.query(
    `INSERT INTO suppliers (name, contact_info, lead_time_days, supplier_type)
     VALUES ('Export Test Supplier', '{"phone":"555-EXPT"}', 7, 'external')
     RETURNING id`,
  );
  return created.rows[0].id as number;
}

describe('Export Integrity (Module 7)', () => {
  let managerToken: string;
  let branchId: number;
  let staffId: number;
  let customerId: number;
  let bookId: number;
  let poId: number;

  const UNIT_COST = 20.00;
  const QTY = 2;
  const PURCHASE_COST = UNIT_COST * QTY; // 40.00
  const ORDER_SUBTOTAL = 100.00;
  const ORDER_DISCOUNT = 15.00;
  const ORDER_TOTAL = ORDER_SUBTOTAL - ORDER_DISCOUNT; // 85.00 — already net of discount

  beforeAll(async () => {
    await db.query(`DELETE FROM orders WHERE order_number LIKE $1`, [`${ORDER_PREFIX}%`]);
    await db.query(`DELETE FROM po_line_items WHERE po_id IN (SELECT id FROM purchase_orders WHERE notes LIKE '%exp_test%')`);
    await db.query(`DELETE FROM purchase_orders WHERE notes LIKE '%exp_test%'`);
    await db.query(`DELETE FROM receivables WHERE source_ref_id LIKE $1`, [`${ORDER_PREFIX}%`]);
    await db.query(`DELETE FROM customers WHERE customer_code LIKE 'EXPCUS%'`);
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);

    const branch = await createTestBranch({ name: 'Export Test Branch' });
    branchId = branch.branchId;

    const mgr = await createTestStaff({ username: 'exp_test_mgr', role: 'Manager', branchId });
    managerToken = mgr.token;
    staffId = mgr.staffId;

    const custRes = await db.query(
      `INSERT INTO customers (branch_id, customer_code, full_name, phone, is_active, created_at)
       VALUES ($1, 'EXPCUS-001', 'Export Test Customer', '555-8888', true, now())
       ON CONFLICT (customer_code) DO UPDATE SET branch_id = EXCLUDED.branch_id
       RETURNING id`,
      [branchId],
    );
    customerId = custRes.rows[0].id as number;

    bookId = await getTestBook();
    const supplierId = await getTestSupplier();

    // A PO line item gives the cost-basis fallback a deterministic unit_cost
    // to look up (most-recent po_line_items row for the book) — the PO
    // itself doesn't need to be received for this lookup.
    const poRes = await db.query(
      `INSERT INTO purchase_orders (branch_id, supplier_id, status, total_amount, created_by, notes)
       VALUES ($1, $2, 'draft', $3, $4, 'exp_test cost basis PO')
       RETURNING id`,
      [branchId, supplierId, PURCHASE_COST, staffId],
    );
    poId = poRes.rows[0].id as number;
    await db.query(
      `INSERT INTO po_line_items (po_id, book_id, quantity, unit_cost) VALUES ($1, $2, $3, $4)`,
      [poId, bookId, QTY, UNIT_COST],
    );

    // A FULFILLED cash order with a known discount, so net_profit is fully
    // deterministic: total (already net of discount) − purchase cost.
    const orderRes = await db.query(
      `INSERT INTO orders (
         order_number, customer_id, branch_id, status, sale_type,
         total, subtotal, discount_amount, discount_total, tax_amount,
         payment_status, created_by, created_at, updated_at
       ) VALUES ($1, $2, $3, 'FULFILLED', 'cash_sale',
         $4, $5, $6, $6, 0.00, 'paid', $7, now(), now())
       ON CONFLICT (order_number) DO NOTHING
       RETURNING id`,
      [`${ORDER_PREFIX}A`, customerId, branchId, ORDER_TOTAL, ORDER_SUBTOTAL, ORDER_DISCOUNT, staffId],
    );
    const orderId = orderRes.rows[0].id as number;
    await db.query(
      `INSERT INTO order_line_items (order_id, book_id, quantity, unit_price, discount_amount, total_price)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [orderId, bookId, QTY, ORDER_SUBTOTAL / QTY, ORDER_DISCOUNT, ORDER_TOTAL],
    );

    // One receivable of each source_type, all dated today, so the
    // receivables export (no default date filter needed) picks up all three.
    await db.query(
      `INSERT INTO receivables
         (source_type, source_ref_id, source_entity_id, customer_id, branch_id,
          original_amount, outstanding_amount, currency, status)
       VALUES
         ('order_credit_sale', $1, $2, $3, $4, 50.00, 50.00, 'ETB', 'Pending'),
         ('pos_credit_sale',   $5, $2, $3, $4, 60.00, 60.00, 'ETB', 'Pending'),
         ('exchange_difference', $6, $2, $3, $4, 70.00, 70.00, 'ETB', 'Pending')`,
      [`${ORDER_PREFIX}ORD`, orderId, customerId, branchId, `${ORDER_PREFIX}POS`, `${ORDER_PREFIX}EXC`],
    );
  });

  afterAll(async () => {
    await db.query(`DELETE FROM receivables WHERE source_ref_id LIKE $1`, [`${ORDER_PREFIX}%`]);
    await db.query(`DELETE FROM orders WHERE order_number LIKE $1`, [`${ORDER_PREFIX}%`]);
    await db.query(`DELETE FROM po_line_items WHERE po_id = $1`, [poId]);
    await db.query(`DELETE FROM purchase_orders WHERE id = $1`, [poId]);
    await db.query(`DELETE FROM customers WHERE customer_code LIKE 'EXPCUS%'`);
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  // ── 1. Unified sales export: ORDER row shape and net-amount math ──────────
  // (Dashboard Standardization & Unified Reports Engine) — the CSV no longer
  // has purchase_cost/net_profit columns (that's an accrual/COGS concept the
  // new line-item-level export deliberately doesn't carry — see
  // financialReport.service.ts); it verifies gross/discount/net instead.

  it('1. Unified sales export: ORDER row has correct gross/discount/net amounts and reference', async () => {
    const res = await request(getTestApp())
      .get(`/api/reports/sales/export?branchId=${branchId}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(res.status).toBe(200);
    const rows = parseCsv(res.text);
    const row = rows.find(r => r['Invoice No'] === `${ORDER_PREFIX}A`);
    expect(row).toBeDefined();

    expect(row!.Source).toBe('ORDER');
    expect(row!.Customer).toBe('Export Test Customer');
    expect(parseInt(row!.Qty, 10)).toBe(QTY);
    expect(parseFloat(row!.Discount)).toBeCloseTo(ORDER_DISCOUNT, 2);
    expect(parseFloat(row!['Gross Amount'])).toBeCloseTo(ORDER_SUBTOTAL, 2);
    // Net Sales Amount = order_line_items.total_price, already gross − discount.
    expect(parseFloat(row!['Net Sales Amount'])).toBeCloseTo(ORDER_TOTAL, 2);
    expect(row!['Payment Status']).toBe('PAID');
  });

  // ── 2. Receivables export includes all source types ───────────────────────

  it('2. Receivables export includes order_credit_sale, pos_credit_sale, and exchange_difference rows', async () => {
    const res = await request(getTestApp())
      .get(`/api/reports/receivables/export?branchId=${branchId}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(res.status).toBe(200);
    const rows = parseCsv(res.text);
    const refs = rows.map(r => r.order_reference);

    expect(refs).toContain(`${ORDER_PREFIX}ORD`);
    expect(refs).toContain(`${ORDER_PREFIX}POS`);
    expect(refs).toContain(`${ORDER_PREFIX}EXC`);
  });

  // ── 3. Inventory export succeeds (regression: GROUP BY ungrouped column) ──

  it('3. Inventory export returns 200 (getInventoryExportRowsV2 GROUP BY bug)', async () => {
    // Bug: the category column's correlated subquery referenced b.id, but
    // the GROUP BY only listed b.sku/b.isbn/b.title/b.publisher — not b.id
    // itself — so Postgres rejected every call to this endpoint with
    // "subquery uses ungrouped column b.id from outer query" (a 500 on
    // every /reports/inventory/export request, reported live in prod).
    const locRes = await db.query(
      `INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Export Test Loc', true) RETURNING id`,
      [branchId],
    );
    await db.query(
      `INSERT INTO inventory (book_id, location_id, quantity) VALUES ($1, $2, 5)
       ON CONFLICT (book_id, location_id) DO UPDATE SET quantity = 5`,
      [bookId, locRes.rows[0].id],
    );

    const res = await request(getTestApp())
      .get(`/api/reports/inventory/export?branchId=${branchId}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(res.status).toBe(200);
    const rows = parseCsv(res.text);
    expect(rows.length).toBeGreaterThan(0);
  });
});

// ── 3. csvBuilder — formula-injection guard (unit tests, no DB) ──────────────

describe('csvBuilder — CSV/formula injection guard', () => {
  const stringCol: CsvColumnDef[] = [{ key: 'name', header: 'name', type: 'string' }];
  const numberCol: CsvColumnDef[] = [{ key: 'amount', header: 'amount', type: 'number' }];

  it('prefixes a string cell starting with = with a single quote', () => {
    const csv = buildCsv([{ name: '=1+1' }], stringCol);
    expect(csv).toContain(`'=1+1`);
  });

  it('prefixes a string cell starting with @ (e.g. HYPERLINK-style payloads)', () => {
    const csv = buildCsv([{ name: '@SUM(A1:A9)' }], stringCol);
    expect(csv).toContain(`'@SUM(A1:A9)`);
  });

  it('does NOT prefix a normal string value', () => {
    const csv = buildCsv([{ name: 'Regular Customer Name' }], stringCol);
    expect(csv).not.toContain(`'Regular`);
    expect(csv).toContain('Regular Customer Name');
  });

  it('does NOT corrupt a negative number in a numeric column', () => {
    const csv = buildCsv([{ amount: -150 }], numberCol);
    const dataLine = csv.split('\r\n')[1];
    expect(dataLine).toBe('-150.00');
  });
});
