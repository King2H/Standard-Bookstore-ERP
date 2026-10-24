import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

// The dashboard's Cash Collected is the money that came in less the money
// that went back, in and out shown (owner decision, 2026-10-23), the same
// figures as the Payments report for the same period and branch. It counted
// order and POS payments as taken: a return's refund and a cancelled
// order's refund stayed in it, and a fully refunded payment left it while
// its refund was never taken off.

const STAFF_PREFIX = 'kpicash_test_';
const BRANCH_PREFIX = 'KPI Cash ';

describe('Cash Collected: money in less money out, as the Payments report counts it', () => {
  let branchId: number;
  let locationId: number;
  let bookId: number;
  let price: number;
  let manager: string;
  let sales: string;
  const api = () => request(getTestApp());
  const as = (r: request.Test, token = manager) => r.set('Authorization', `Bearer ${token}`).set('X-Branch-Id', String(branchId));
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];

  async function cleanUp() {
    const branches = `SELECT id FROM branches WHERE name LIKE '${BRANCH_PREFIX}%'`;
    const orders = `SELECT id FROM orders WHERE branch_id IN (${branches})`;
    for (const statement of [
      `DELETE FROM refunds WHERE return_id IN (SELECT id FROM returns WHERE branch_id IN (${branches}))`,
      `DELETE FROM return_line_items WHERE return_id IN (SELECT id FROM returns WHERE branch_id IN (${branches}))`,
      `DELETE FROM returns WHERE branch_id IN (${branches})`,
      `DELETE FROM transaction_payments WHERE transaction_id IN (SELECT id FROM transactions WHERE branch_id IN (${branches}))`,
      `DELETE FROM transaction_line_items WHERE transaction_id IN (SELECT id FROM transactions WHERE branch_id IN (${branches}))`,
      `DELETE FROM transactions WHERE branch_id IN (${branches})`,
      `DELETE FROM order_refunds WHERE order_id IN (${orders})`,
      `DELETE FROM order_payments WHERE order_id IN (${orders})`,
      `DELETE FROM receivables WHERE branch_id IN (${branches})`,
      `DELETE FROM inventory_reservations WHERE order_id IN (${orders})`,
      `DELETE FROM order_line_items WHERE order_id IN (${orders})`,
      `DELETE FROM orders WHERE id IN (${orders})`,
      `DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
    ]) {
      await db.query(statement);
    }
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  async function paidOrder(): Promise<string> {
    const created = await as(api().post('/api/v1/orders'), sales).send({ locationId, saleType: 'cash_sale', items: [{ bookId, quantity: 1 }] });
    expect(created.status).toBe(201);
    const id = String(created.body.id);
    expect((await as(api().post(`/api/v1/orders/${id}/confirm`)).send({ paymentMethod: 'cash' })).status).toBe(200);
    return id;
  }

  beforeAll(async () => {
    await cleanUp();
    branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    manager = (await createTestStaff({ username: `${STAFF_PREFIX}mgr`, role: 'Manager', branchId })).token;
    sales = (await createTestStaff({ username: `${STAFF_PREFIX}sales`, role: 'Sales', branchId })).token;
    locationId = (await one(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'KPI Cash Loc', true) RETURNING id`, [branchId])).id;
    const book = await one(`SELECT id, default_price FROM books WHERE is_active = true AND default_price > 10 ORDER BY id LIMIT 1`);
    bookId = book.id;
    price = Number(book.default_price);
    await db.query(`INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version, average_cost) VALUES ($1, $2, 100, 5, 0, 4)`, [bookId, locationId]);

    // A POS sale of two copies, one brought back: 2 in, 1 out.
    const sale = await as(api().post('/api/v1/pos/transactions')).send({
      locationId, items: [{ bookId, quantity: 2 }], payments: [{ method: 'cash', amount: price * 2 }],
    });
    expect(sale.status).toBe(201);
    const returned = await as(api().post('/api/v1/returns')).send({
      transactionId: Number(sale.body.id), lines: [{ transactionLineItemId: Number(sale.body.lineItems[0].id), quantity: 1 }],
    });
    expect(returned.status).toBe(201);
    // A paid order that stays: 1 in.
    await paidOrder();
    // A paid order cancelled, its money given back: 1 in, 1 out.
    const cancelled = await paidOrder();
    expect((await as(api().post(`/api/v1/orders/${cancelled}/cancel`)).send({ reason: 'Customer withdrew', refundTo: 'original' })).status).toBe(200);
  });

  afterAll(cleanUp);

  it('shows the money in, the money out and what is left, for the period (was: payments as taken, refunds never taken off)', async () => {
    const res = await as(api().get('/api/v1/reports/kpis/period?period=today'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ cashIn: price * 4, cashOut: price * 2, cashCollected: price * 2 });
  });

  it('gives the Payments report\'s figures for the same day and branch', async () => {
    const kpi = (await as(api().get('/api/v1/reports/kpis/period?period=today'))).body;
    const day = kpi.dateFrom as string;
    const report = await as(api().get(`/api/v1/reports/payments?dateFrom=${day}&dateTo=${day}`));
    expect(report.status).toBe(200);
    expect(report.body.summary).toMatchObject({ totalCollected: kpi.cashIn, totalRefunded: kpi.cashOut, netCollected: kpi.cashCollected });
  });

  it('lists in the Payments ledger the rows that make it up (Money In & Out, owner decision b)', async () => {
    const kpi = (await as(api().get('/api/v1/reports/kpis/period?period=today'))).body;
    const ledger = await as(api().get(`/api/v1/reports/payments-ledger?dateFrom=${kpi.dateFrom}&dateTo=${kpi.dateTo}`));
    expect(ledger.status).toBe(200);
    const customer = (ledger.body.rows as Array<{ referenceType: string; direction: string; amount: number }>).filter((r) => r.referenceType !== 'PO');
    const sum = (d: string) => Math.round(customer.filter((r) => r.direction === d).reduce((t, r) => t + r.amount * 100, 0)) / 100;
    expect({ in: sum('IN'), out: sum('OUT') }).toEqual({ in: kpi.cashIn, out: kpi.cashOut });
    expect(customer.map((r) => `${r.direction} ${r.referenceType}`).sort()).toEqual(['IN ORDER', 'IN ORDER', 'IN POS', 'OUT ORDER', 'OUT RETURN']);
  });

  it('counts today\'s and this month\'s cash the same way', async () => {
    const res = await as(api().get('/api/v1/reports/kpis'));
    expect(res.status).toBe(200);
    expect(res.body.dailyRevenue).toBe(price * 2);
    expect(res.body.monthlyRevenue).toBe(price * 2);
  });
});
