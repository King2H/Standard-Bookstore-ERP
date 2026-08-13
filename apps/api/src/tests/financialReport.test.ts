/**
 * Dashboard Standardization & Unified Reports Engine — regression tests for
 * FinancialReportService (financialReport.service.ts).
 *
 * Covers the ticket's three acceptance criteria directly:
 *   1. The unified Sales CSV export contains all four revenue-moving
 *      channels (ORDER, POS, RETURN, EXCHANGE) for a single fixture branch.
 *   2. Cancelled orders, voided POS transactions, rejected returns, and
 *      cancelled exchanges are excluded automatically.
 *   3. The CSV export's summed net_amount for a date range reconciles 1:1
 *      with the Dashboard KPI's dailyNetSalesRevenue for that same range —
 *      proving no mathematical discrepancy between the two surfaces.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'fr_test_';
const BRANCH_PREFIX = 'FinReport Test ';
const REF_PREFIX = 'FRTEST-';

function parseCsv(csv: string): Record<string, string>[] {
  const body = csv.replace(/^﻿/, '');
  const lines = body.split('\r\n').filter(l => l.length > 0);
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => {
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

describe('FinancialReportService — unified Sales CSV export & Dashboard reconciliation', () => {
  let managerToken: string;
  let branchId: number;
  let locationId: number;
  let staffId: number;
  let customerId: number;
  let bookId: number;
  let posTransactionId: number;
  let orderId: number;
  let exchangeId: number;
  let voidedTransactionId: number;
  let cancelledOrderId: number;
  let cancelledExchangeId: number;

  // ── Fixture amounts ──────────────────────────────────────────────────────
  // ORDER: gross 100, discount 10, net 90
  const ORDER_SUBTOTAL = 100.00;
  const ORDER_DISCOUNT = 10.00;
  const ORDER_TOTAL = ORDER_SUBTOTAL - ORDER_DISCOUNT; // 90.00
  // POS: gross 80, discount 8, net 72
  const POS_UNIT_PRICE = 80.00;
  const POS_DISCOUNT = 8.00;
  const POS_LINE_TOTAL = POS_UNIT_PRICE - POS_DISCOUNT; // 72.00
  // RETURN: refund 20 (reduces net sales by 20)
  const RETURN_REFUND = 20.00;
  // EXCHANGE: incoming (trade-in) 30, outgoing (resale) 45 → net +15
  const EXCHANGE_INCOMING = 30.00;
  const EXCHANGE_OUTGOING = 45.00;

  // Expected netSalesRevenue for this branch/day, summed across all four
  // channels: 90 (order) + 72 (pos) − 20 (return) + (45 − 30) (exchange)
  const EXPECTED_NET_SALES_REVENUE = ORDER_TOTAL + POS_LINE_TOTAL - RETURN_REFUND + (EXCHANGE_OUTGOING - EXCHANGE_INCOMING);

  beforeAll(async () => {
    await db.query(`DELETE FROM customers WHERE customer_code LIKE 'FRCUS%'`);
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);

    const branch = await createTestBranch({ name: 'FinReport Test Branch' });
    branchId = branch.branchId;

    const locRes = await db.query(
      `INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'FinReport Test Loc', true) RETURNING id`,
      [branchId],
    );
    locationId = locRes.rows[0].id as number;

    const mgr = await createTestStaff({ username: 'fr_test_mgr', role: 'Manager', branchId });
    managerToken = mgr.token;
    staffId = mgr.staffId;

    const custRes = await db.query(
      `INSERT INTO customers (branch_id, customer_code, full_name, phone, is_active, created_at)
       VALUES ($1, 'FRCUS-001', 'FinReport Test Customer', '555-7777', true, now())
       ON CONFLICT (customer_code) DO UPDATE SET branch_id = EXCLUDED.branch_id
       RETURNING id`,
      [branchId],
    );
    customerId = custRes.rows[0].id as number;

    bookId = await getTestBook();

    // ── ORDER (counted) ────────────────────────────────────────────────────
    const orderRes = await db.query(
      `INSERT INTO orders (
         order_number, customer_id, branch_id, status, sale_type,
         total, subtotal, discount_amount, discount_total, tax_amount,
         payment_status, created_by, created_at, updated_at
       ) VALUES ($1, $2, $3, 'FULFILLED', 'cash_sale',
         $4, $5, $6, $6, 0.00, 'paid', $7, now(), now())
       RETURNING id`,
      [`${REF_PREFIX}ORD-A`, customerId, branchId, ORDER_TOTAL, ORDER_SUBTOTAL, ORDER_DISCOUNT, staffId],
    );
    orderId = orderRes.rows[0].id as number;
    await db.query(
      `INSERT INTO order_line_items (order_id, book_id, quantity, unit_price, discount_amount, total_price)
       VALUES ($1, $2, 2, $3, $4, $5)`,
      [orderId, bookId, ORDER_SUBTOTAL / 2, ORDER_DISCOUNT, ORDER_TOTAL],
    );

    // ── ORDER (excluded — Cancelled) ───────────────────────────────────────
    const cancelledOrderRes = await db.query(
      `INSERT INTO orders (
         order_number, customer_id, branch_id, status, sale_type,
         total, subtotal, discount_amount, discount_total, tax_amount,
         payment_status, created_by, created_at, updated_at
       ) VALUES ($1, $2, $3, 'Cancelled', 'cash_sale',
         500.00, 500.00, 0.00, 0.00, 0.00, 'unpaid', $4, now(), now())
       RETURNING id`,
      [`${REF_PREFIX}ORD-CANCEL`, customerId, branchId, staffId],
    );
    cancelledOrderId = cancelledOrderRes.rows[0].id as number;
    await db.query(
      `INSERT INTO order_line_items (order_id, book_id, quantity, unit_price, discount_amount, total_price)
       VALUES ($1, $2, 1, 500.00, 0.00, 500.00)`,
      [cancelledOrderId, bookId],
    );

    // ── POS (counted) ──────────────────────────────────────────────────────
    const txRes = await db.query(
      `INSERT INTO transactions (
         branch_id, location_id, customer_id, staff_id, transaction_number,
         subtotal, discount_total, tax_total, grand_total, status, payment_status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0.00, $8, 'completed', 'paid')
       RETURNING id`,
      [branchId, locationId, customerId, staffId, `${REF_PREFIX}POS-A`, POS_UNIT_PRICE, POS_DISCOUNT, POS_LINE_TOTAL],
    );
    posTransactionId = txRes.rows[0].id as number;
    const posLineRes = await db.query(
      `INSERT INTO transaction_line_items (transaction_id, book_id, quantity, unit_price, discount_amount, line_total)
       VALUES ($1, $2, 1, $3, $4, $5)
       RETURNING id`,
      [posTransactionId, bookId, POS_UNIT_PRICE, POS_DISCOUNT, POS_LINE_TOTAL],
    );
    const posLineItemId = posLineRes.rows[0].id as number;
    await db.query(
      `INSERT INTO transaction_payments (transaction_id, method, amount)
       VALUES ($1, 'cash', $2)`,
      [posTransactionId, POS_LINE_TOTAL],
    );

    // ── POS (excluded — voided) ────────────────────────────────────────────
    const voidedRes = await db.query(
      `INSERT INTO transactions (
         branch_id, location_id, customer_id, staff_id, transaction_number,
         subtotal, discount_total, tax_total, grand_total, status, payment_status
       ) VALUES ($1, $2, $3, $4, $5, 300.00, 0.00, 0.00, 300.00, 'voided', 'paid')
       RETURNING id`,
      [branchId, locationId, customerId, staffId, `${REF_PREFIX}POS-VOID`],
    );
    voidedTransactionId = voidedRes.rows[0].id as number;
    await db.query(
      `INSERT INTO transaction_line_items (transaction_id, book_id, quantity, unit_price, discount_amount, line_total)
       VALUES ($1, $2, 1, 300.00, 0.00, 300.00)`,
      [voidedTransactionId, bookId],
    );

    // ── RETURN (counted) ───────────────────────────────────────────────────
    const returnRes = await db.query(
      `INSERT INTO returns (
         return_number, transaction_id, branch_id, customer_id,
         total_refund_amount, refund_method, status, processed_by
       ) VALUES ($1, $2, $3, $4, $5, 'cash', 'completed', $6)
       RETURNING id`,
      [`${REF_PREFIX}RET-A`, posTransactionId, branchId, customerId, RETURN_REFUND, staffId],
    );
    const returnId = returnRes.rows[0].id as number;
    await db.query(
      `INSERT INTO return_line_items (return_id, transaction_line_item_id, book_id, quantity, unit_price, line_refund_amount)
       VALUES ($1, $2, $3, 1, $4, $5)`,
      [returnId, posLineItemId, bookId, RETURN_REFUND, RETURN_REFUND],
    );

    // ── RETURN (excluded — rejected) ───────────────────────────────────────
    const rejectedReturnRes = await db.query(
      `INSERT INTO returns (
         return_number, transaction_id, branch_id, customer_id,
         total_refund_amount, refund_method, status, processed_by
       ) VALUES ($1, $2, $3, $4, 999.00, 'cash', 'rejected', $5)
       RETURNING id`,
      [`${REF_PREFIX}RET-REJ`, posTransactionId, branchId, customerId, staffId],
    );
    const rejectedReturnId = rejectedReturnRes.rows[0].id as number;
    await db.query(
      `INSERT INTO return_line_items (return_id, transaction_line_item_id, book_id, quantity, unit_price, line_refund_amount)
       VALUES ($1, $2, $3, 1, 999.00, 999.00)`,
      [rejectedReturnId, posLineItemId, bookId],
    );

    // ── EXCHANGE (counted) — legacy Quick Exchange shape ───────────────────
    const exchangeRes = await db.query(
      `INSERT INTO exchanges (
         exchange_reference, branch_id, location_id, customer_id, status,
         total_incoming_value, total_outgoing_value, net_balance, settlement_type, created_by
       ) VALUES ($1, $2, $3, $4, 'Completed', $5, $6, $7, 'Customer_Pays', $8)
       RETURNING id`,
      [`${REF_PREFIX}EXC-A`, branchId, locationId, customerId, EXCHANGE_INCOMING, EXCHANGE_OUTGOING, EXCHANGE_OUTGOING - EXCHANGE_INCOMING, staffId],
    );
    exchangeId = exchangeRes.rows[0].id as number;
    await db.query(
      `INSERT INTO exchange_incoming_items (exchange_id, book_id, quantity, evaluated_unit_price, total_price)
       VALUES ($1, $2, 1, $3, $3)`,
      [exchangeId, bookId, EXCHANGE_INCOMING],
    );
    await db.query(
      `INSERT INTO exchange_outgoing_items (exchange_id, book_id, quantity, selling_unit_price, total_price)
       VALUES ($1, $2, 1, $3, $3)`,
      [exchangeId, bookId, EXCHANGE_OUTGOING],
    );

    // ── EXCHANGE (excluded — Cancelled) ─────────────────────────────────────
    const cancelledExchangeRes = await db.query(
      `INSERT INTO exchanges (
         exchange_reference, branch_id, location_id, customer_id, status,
         total_incoming_value, total_outgoing_value, net_balance, settlement_type, created_by
       ) VALUES ($1, $2, $3, $4, 'Cancelled', 200.00, 200.00, 0.00, 'Even', $5)
       RETURNING id`,
      [`${REF_PREFIX}EXC-CANCEL`, branchId, locationId, customerId, staffId],
    );
    cancelledExchangeId = cancelledExchangeRes.rows[0].id as number;
    await db.query(
      `INSERT INTO exchange_incoming_items (exchange_id, book_id, quantity, evaluated_unit_price, total_price)
       VALUES ($1, $2, 1, 200.00, 200.00)`,
      [cancelledExchangeId, bookId],
    );
  });

  afterAll(async () => {
    await db.query(`DELETE FROM exchange_outgoing_items WHERE exchange_id IN ($1, $2)`, [exchangeId, cancelledExchangeId]);
    await db.query(`DELETE FROM exchange_incoming_items WHERE exchange_id IN ($1, $2)`, [exchangeId, cancelledExchangeId]);
    await db.query(`DELETE FROM exchanges WHERE id IN ($1, $2)`, [exchangeId, cancelledExchangeId]);
    await db.query(`DELETE FROM order_line_items WHERE order_id IN ($1, $2)`, [orderId, cancelledOrderId]);
    await db.query(`DELETE FROM orders WHERE id IN ($1, $2)`, [orderId, cancelledOrderId]);
    // returns/transactions reference customers — must be gone before the
    // customer row itself, which in turn must be gone before the branch.
    await db.query(`DELETE FROM refunds WHERE return_id IN (SELECT id FROM returns WHERE transaction_id IN ($1, $2))`, [posTransactionId, voidedTransactionId]);
    await db.query(`DELETE FROM return_line_items WHERE return_id IN (SELECT id FROM returns WHERE transaction_id IN ($1, $2))`, [posTransactionId, voidedTransactionId]);
    await db.query(`DELETE FROM returns WHERE transaction_id IN ($1, $2)`, [posTransactionId, voidedTransactionId]);
    await db.query(`DELETE FROM transaction_payments WHERE transaction_id IN ($1, $2)`, [posTransactionId, voidedTransactionId]);
    await db.query(`DELETE FROM transaction_line_items WHERE transaction_id IN ($1, $2)`, [posTransactionId, voidedTransactionId]);
    await db.query(`DELETE FROM transactions WHERE id IN ($1, $2)`, [posTransactionId, voidedTransactionId]);
    await db.query(`DELETE FROM customers WHERE customer_code LIKE 'FRCUS%'`);
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  // ── 1. All four channels present in the unified CSV export ────────────────

  it('1. Sales CSV export includes ORDER, POS, RETURN, and EXCHANGE rows for the fixture branch', async () => {
    const res = await request(getTestApp())
      .get(`/api/reports/sales/export?branchId=${branchId}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(res.status).toBe(200);
    const rows = parseCsv(res.text);
    const byRef = new Map(rows.map(r => [r['Invoice No'], r]));

    const orderRow = byRef.get(`${REF_PREFIX}ORD-A`);
    expect(orderRow).toBeDefined();
    expect(orderRow!.Source).toBe('ORDER');
    expect(parseFloat(orderRow!['Gross Amount'])).toBeCloseTo(ORDER_SUBTOTAL, 2);
    expect(parseFloat(orderRow!.Discount)).toBeCloseTo(ORDER_DISCOUNT, 2);
    expect(parseFloat(orderRow!['Net Sales Amount'])).toBeCloseTo(ORDER_TOTAL, 2);

    const posRow = byRef.get(`${REF_PREFIX}POS-A`);
    expect(posRow).toBeDefined();
    expect(posRow!.Source).toBe('POS');
    expect(parseFloat(posRow!['Gross Amount'])).toBeCloseTo(POS_UNIT_PRICE, 2);
    expect(parseFloat(posRow!.Discount)).toBeCloseTo(POS_DISCOUNT, 2);
    expect(parseFloat(posRow!['Net Sales Amount'])).toBeCloseTo(POS_LINE_TOTAL, 2);

    const returnRow = byRef.get(`${REF_PREFIX}RET-A`);
    expect(returnRow).toBeDefined();
    expect(returnRow!.Source).toBe('RETURN');
    expect(parseInt(returnRow!.Qty, 10)).toBe(-1);
    expect(parseFloat(returnRow!['Net Sales Amount'])).toBeCloseTo(-RETURN_REFUND, 2);

    const exchangeRows = rows.filter(r => r['Invoice No'] === `${REF_PREFIX}EXC-A`);
    expect(exchangeRows.length).toBe(2); // one incoming, one outgoing
    expect(exchangeRows.every(r => r.Source === 'EXCHANGE')).toBe(true);
    const exchangeNetSum = exchangeRows.reduce((sum, r) => sum + parseFloat(r['Net Sales Amount']), 0);
    expect(exchangeNetSum).toBeCloseTo(EXCHANGE_OUTGOING - EXCHANGE_INCOMING, 2);
  });

  // ── 2. Cancelled/voided/rejected transactions are excluded ────────────────

  it('2. Sales CSV export excludes cancelled orders, voided POS sales, rejected returns, and cancelled exchanges', async () => {
    const res = await request(getTestApp())
      .get(`/api/reports/sales/export?branchId=${branchId}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(res.status).toBe(200);
    const rows = parseCsv(res.text);
    const refs = new Set(rows.map(r => r['Invoice No']));

    expect(refs.has(`${REF_PREFIX}ORD-CANCEL`)).toBe(false);
    expect(refs.has(`${REF_PREFIX}POS-VOID`)).toBe(false);
    expect(refs.has(`${REF_PREFIX}RET-REJ`)).toBe(false);
    expect(refs.has(`${REF_PREFIX}EXC-CANCEL`)).toBe(false);
  });

  // ── 3. Dashboard vs CSV reconciliation ─────────────────────────────────────

  it('3. Dashboard KPI dailyNetSalesRevenue reconciles 1:1 with the summed Net Sales Amount of the CSV export', async () => {
    const exportRes = await request(getTestApp())
      .get(`/api/reports/sales/export?branchId=${branchId}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));
    expect(exportRes.status).toBe(200);
    const rows = parseCsv(exportRes.text);
    // Exclude the appended TOTAL row (Prompt 2) — it already IS the sum, so
    // including it would double-count.
    const lineRows = rows.filter(r => r.Customer !== 'TOTAL');
    const csvNetSum = lineRows.reduce((sum, r) => sum + parseFloat(r['Net Sales Amount']), 0);

    // Sanity-check the fixture's own arithmetic before comparing against the
    // Dashboard — this is the number both surfaces are expected to produce.
    expect(csvNetSum).toBeCloseTo(EXPECTED_NET_SALES_REVENUE, 2);

    // The appended TOTAL row's own Net Sales Amount must match the summed
    // line rows too — proves the totals row itself is internally consistent.
    const totalRow = rows.find(r => r.Customer === 'TOTAL');
    expect(totalRow).toBeDefined();
    expect(parseFloat(totalRow!['Net Sales Amount'])).toBeCloseTo(csvNetSum, 2);

    const kpiRes = await request(getTestApp())
      .get(`/api/reports/kpis?branchId=${branchId}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));
    expect(kpiRes.status).toBe(200);

    // All fixture rows are dated "now()" (today) and this is a dedicated,
    // freshly-created test branch, so dailyNetSalesRevenue for this branch
    // is driven entirely by these fixtures — no other data can leak in.
    expect(kpiRes.body.dailyNetSalesRevenue).toBeCloseTo(csvNetSum, 2);
    expect(kpiRes.body.monthlyNetSalesRevenue).toBeCloseTo(csvNetSum, 2);
  });

  // ── 4. Prompt 2 — Gross Profit (the single "Net Profit" KPI) reconciles
  //      across all three surfaces that must never disagree: the Sales
  //      Report export, /reports/kpis (legacy daily/monthly fields), and
  //      /reports/kpis/period?period=today (what the redesigned dashboard's
  //      Sales Performance cards actually render). All three are backed by
  //      the same per-line accrual+cost engine (financialReport.service.ts),
  //      so this doesn't hardcode an expected cost basis — it only proves
  //      the three surfaces can't drift apart from each other.

  it('4. Gross Profit (single Net Profit KPI) reconciles across the Sales export, /kpis, and /kpis/period', async () => {
    const exportRes = await request(getTestApp())
      .get(`/api/reports/sales/export?branchId=${branchId}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));
    expect(exportRes.status).toBe(200);
    const rows = parseCsv(exportRes.text);
    const lineRows = rows.filter(r => r.Customer !== 'TOTAL');
    const csvNetSum = lineRows.reduce((sum, r) => sum + parseFloat(r['Net Sales Amount']), 0);
    const csvGrossProfitSum = lineRows.reduce((sum, r) => sum + parseFloat(r['Gross Profit']), 0);

    const totalRow = rows.find(r => r.Customer === 'TOTAL');
    expect(totalRow).toBeDefined();
    expect(parseFloat(totalRow!['Gross Profit'])).toBeCloseTo(csvGrossProfitSum, 2);

    const kpiRes = await request(getTestApp())
      .get(`/api/reports/kpis?branchId=${branchId}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));
    expect(kpiRes.status).toBe(200);
    expect(kpiRes.body.dailyNetProfitUnified).toBeCloseTo(csvGrossProfitSum, 2);
    expect(kpiRes.body.monthlyNetProfitUnified).toBeCloseTo(csvGrossProfitSum, 2);
    // procurementExpense was a Prompt 1-era field folded into the old
    // (rejected) cash-basis KPI — it must not resurface on the response.
    expect(kpiRes.body.procurementExpense).toBeUndefined();

    const periodRes = await request(getTestApp())
      .get(`/api/reports/kpis/period?branchId=${branchId}&period=today`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));
    expect(periodRes.status).toBe(200);
    // All fixture rows are dated "now()" — the "today" period window covers
    // exactly this fixture set for this dedicated test branch.
    expect(periodRes.body.netSales).toBeCloseTo(csvNetSum, 2);
    expect(periodRes.body.grossProfit).toBeCloseTo(csvGrossProfitSum, 2);
  });
});
