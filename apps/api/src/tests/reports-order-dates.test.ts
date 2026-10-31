/**
 * reports-order-dates.test.ts
 *
 * #175 (owner decision a, 2026-10-31): an order's events count on the day
 * they happen, so a closed day never changes. A sale counts on its
 * confirmation day, a cancellation on its own day as a minus, and revenue
 * on the delivery day. Before, the reports dated an order by its creation
 * and filtered it by its current status: confirming an old draft added a
 * sale to the day it was drafted, cancelling removed it from the day it was
 * taken, and completing added revenue to the day it was created.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'odate_test_';
const BRANCH_PREFIX = 'Order Dates ';
const CODE = 'ODATE';

describe('Order events count on the day they happen (#175)', () => {
  let location: number;
  let customerId: number;
  let book: number;
  const t: Record<string, string> = {};
  const day: Record<number, string> = {};
  const orders: Record<'A' | 'B' | 'C', { id: string; total: number }> = {} as never;
  const api = () => request(getTestApp());
  const as = (token: string) => ({
    get: (path: string) => api().get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) => api().post(path).set('Authorization', `Bearer ${token}`).send(body),
  });
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  const report = async (from: number, to = from) => (await as(t.manager).get(`/api/v1/reports/sales?dateFrom=${day[from]}&dateTo=${day[to]}`)).body;

  async function confirmed(quantity: number): Promise<{ id: string; total: number }> {
    const created = await as(t.sales).post('/api/v1/orders', { locationId: location, customerId, items: [{ bookId: book, quantity }] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const res = await as(t.sales).post(`/api/v1/orders/${created.body.id}/confirm`, { paymentMethod: 'cash' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return { id: res.body.id, total: res.body.total };
  }
  const at = (orderId: string, set: string) => db.query(`UPDATE orders SET ${set} WHERE id = $1`, [orderId]);

  async function cleanUp() {
    const branches = `SELECT id FROM branches WHERE name LIKE '${BRANCH_PREFIX}%'`;
    const ids = `SELECT id FROM orders WHERE branch_id IN (${branches})`;
    for (const statement of [
      `DELETE FROM order_deliveries WHERE order_id IN (${ids})`,
      `DELETE FROM order_refunds WHERE order_id IN (${ids})`,
      `DELETE FROM order_payments WHERE order_id IN (${ids})`,
      `DELETE FROM inventory_reservations WHERE order_id IN (${ids})`,
      `DELETE FROM cash_session_movements WHERE session_id IN (SELECT id FROM cash_sessions WHERE branch_id IN (${branches}))`,
      `DELETE FROM orders WHERE branch_id IN (${branches})`,
      `DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM customers WHERE customer_code = '${CODE}'`,
    ]) {
      await db.query(statement).catch((err: { code?: string }) => { if (err.code !== '42P01') throw err; });
    }
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    const branch = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    location = (await one(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Dates shelf', true) RETURNING id`, [branch])).id;
    for (const [name, role] of [['sales', 'Sales'], ['manager', 'Manager']] as const) {
      t[name] = (await createTestStaff({ username: `${STAFF_PREFIX}${name}`, role, branchId: branch })).token;
    }
    book = (await one(`SELECT id FROM books WHERE is_active = true AND default_price > 0 ORDER BY id LIMIT 1`)).id;
    await db.query(`INSERT INTO inventory (book_id, location_id, quantity, average_cost) VALUES ($1, $2, 50, 1)`, [book, location]);
    customerId = (await one(
      `INSERT INTO customers (branch_id, customer_code, full_name, is_active) VALUES ($1, $2, 'Dates Customer', true) RETURNING id`, [branch, CODE],
    )).id;
    for (const n of [0, 1, 2, 3, 4]) day[n] = (await one(`SELECT (CURRENT_DATE - $1::int)::text AS d`, [n])).d;

    // A: drafted 3 days ago, confirmed yesterday.
    orders.A = await confirmed(1);
    await at(orders.A.id, `created_at = now() - interval '3 days', confirmed_at = now() - interval '1 day'`);
    // B: confirmed 2 days ago, cancelled today.
    orders.B = await confirmed(2);
    await at(orders.B.id, `created_at = now() - interval '2 days', confirmed_at = now() - interval '2 days'`);
    const cancel = await as(t.manager).post(`/api/v1/orders/${orders.B.id}/cancel`, { reason: 'Changed mind', refundTo: 'original' });
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    // C: taken 4 days ago, delivered today.
    orders.C = await confirmed(4);
    expect((await as(t.sales).post(`/api/v1/orders/${orders.C.id}/fulfill`)).body.status).toBe('COMPLETED');
    await at(orders.C.id, `created_at = now() - interval '4 days', confirmed_at = now() - interval '4 days'`);
  });

  afterAll(cleanUp);

  it('counts a sale on its confirmation day, not the day it was drafted (was: the draft\'s day)', async () => {
    expect((await report(3)).summary).toMatchObject({ totalSales: 0, totalOrders: 0 });
    expect((await report(1)).summary).toMatchObject({ totalSales: orders.A.total, totalOrders: 1 });
    expect((await report(4)).summary).toMatchObject({ totalSales: orders.C.total, totalOrders: 1 });
  });

  it('keeps a cancelled order\'s sale on its day and counts the cancellation on its own (was: the sale vanished)', async () => {
    expect((await report(2)).summary).toMatchObject({ totalSales: orders.B.total, totalOrders: 1 });
    const today = await report(0);
    expect(today.summary).toMatchObject({ totalSales: -orders.B.total, totalOrders: -1 });
    const detail = (await as(t.manager).get(`/api/v1/reports/sales/detail?dateFrom=${day[0]}&dateTo=${day[0]}`)).body;
    expect(detail.rows.filter((r: { source: string }) => r.source === 'ORDER').map((r: { qty: number }) => r.qty)).toEqual([-2]);
    // Over the whole span the sale and its cancellation net out.
    expect((await report(4, 0)).summary).toMatchObject({ totalSales: orders.A.total + orders.C.total, totalOrders: 2 });
    const kpis = (await as(t.manager).get('/api/v1/reports/kpis')).body;
    expect(kpis.dailySales).toBeCloseTo(-orders.B.total, 2);
    const customers = (await as(t.manager).get(`/api/v1/reports/customers?dateFrom=${day[4]}&dateTo=${day[0]}`)).body;
    expect(customers.topCustomers.find((c: { fullName: string }) => c.fullName === 'Dates Customer'))
      .toMatchObject({ totalSpend: orders.A.total + orders.C.total, orderCount: 2 });
  });

  it('counts revenue on the delivery day (was: the day the order was created)', async () => {
    expect((await report(4)).summary.fulfilledRevenue).toBe(0);
    expect((await report(0)).summary.fulfilledRevenue).toBeCloseTo(orders.C.total, 2);
  });
});
