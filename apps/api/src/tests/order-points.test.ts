// #249 (#225 M6; owner decision a, 2026-11-06). A customer order earns
// loyalty points at the counter's rate once every copy is delivered (or the
// rest cancelled) and it is paid in full, on what it kept: its total less what
// came back before (was: orders earned no points, counter sales did).
// Returning delivered books later takes back the points their value earned,
// as for a counter sale.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'orderpts_';
const BRANCH_PREFIX = 'Order Points ';
const CODE = 'ORDERPTS';

interface Line { id: string; bookId: number; quantity: number }
interface Order { id: string; orderNumber: string; status: string; total: number; lineItems: Line[] }

describe('Loyalty points on customer orders (#249, M6)', () => {
  let branchId: number;
  let location: number;
  let customerId: number;
  let bookId: number;
  let price: number;
  let rate: number;
  const t: Record<string, string> = {};
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  const as = (token: string) => ({
    post: (path: string, body: object = {}) =>
      request(getTestApp()).post(path).set('Authorization', `Bearer ${token}`).set('X-Branch-Id', String(branchId)).send(body),
  });
  const ok = async (res: request.Response, status = 200) => { expect(res.status, JSON.stringify(res.body)).toBe(status); return res.body; };
  const pointsOf = async (ref: string) => {
    const r = await one(`SELECT COALESCE(SUM(points_delta) FILTER (WHERE reason = 'ACCRUAL'), 0)::int AS earned,
                                COALESCE(-SUM(points_delta) FILTER (WHERE reason = 'RETURN_REVERSAL'), 0)::int AS reversed
                         FROM loyalty_history WHERE customer_id = $1 AND transaction_ref = $2`, [customerId, ref]);
    return { earned: r.earned as number, reversed: r.reversed as number };
  };
  const pointsFor = (amount: number) => Math.floor(Number((amount * rate).toFixed(4)));

  /** A confirmed order of `quantity` copies: a cash order paid at confirmation, or a credit order. */
  async function confirmed(quantity: number, sale: 'cash_sale' | 'credit_sale' = 'cash_sale'): Promise<Order> {
    const created = await ok(await as(t.sales).post('/api/v1/orders', { locationId: location, saleType: sale, customerId, items: [{ bookId, quantity }] }), 201);
    return ok(await as(t.sales).post(`/api/v1/orders/${created.id}/confirm`, sale === 'cash_sale' ? { paymentMethod: 'cash' } : { dueDate: '2099-12-31' }));
  }
  const deliver = async (o: Order, quantity: number) =>
    ok(await as(t.manager).post(`/api/v1/orders/${o.id}/deliveries`, { lines: [{ lineId: Number(o.lineItems[0].id), quantity }] }), 201) as Promise<Order>;

  async function cleanUp() {
    const branches = `SELECT id FROM branches WHERE name LIKE '${BRANCH_PREFIX}%'`;
    const orders = `SELECT id FROM orders WHERE branch_id IN (${branches})`;
    const customers = `SELECT id FROM customers WHERE full_name LIKE '${CODE}%'`;
    for (const statement of [
      `DELETE FROM order_deliveries WHERE order_id IN (${orders})`,
      `DELETE FROM refunds WHERE return_id IN (SELECT id FROM returns WHERE branch_id IN (${branches}))`,
      `DELETE FROM return_line_items WHERE return_id IN (SELECT id FROM returns WHERE branch_id IN (${branches}))`,
      `DELETE FROM order_refunds WHERE order_id IN (${orders})`,
      `DELETE FROM returns WHERE branch_id IN (${branches})`,
      `DELETE FROM order_payments WHERE order_id IN (${orders})`,
      `DELETE FROM financial_transactions WHERE receivable_id IN (SELECT id FROM receivables WHERE branch_id IN (${branches}))`,
      `DELETE FROM receivables WHERE branch_id IN (${branches})`,
      `DELETE FROM inventory_reservations WHERE order_id IN (${orders})`,
      `DELETE FROM cash_session_movements WHERE session_id IN (SELECT id FROM cash_sessions WHERE branch_id IN (${branches}))`,
      `DELETE FROM orders WHERE branch_id IN (${branches})`,
      `DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM loyalty_history WHERE customer_id IN (${customers})`,
      `DELETE FROM loyalty_accounts WHERE customer_id IN (${customers})`,
      `DELETE FROM store_credit_history WHERE customer_id IN (${customers})`,
      `DELETE FROM store_credit_accounts WHERE customer_id IN (${customers})`,
      `DELETE FROM customers WHERE id IN (${customers})`,
    ]) {
      await db.query(statement).catch((err: { code?: string }) => { if (err.code !== '42P01' && err.code !== '42703') throw err; });
    }
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    location = (await one(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Points shelf', true) RETURNING id`, [branchId])).id;
    for (const [name, role] of [['sales', 'Sales'], ['manager', 'Manager']] as const) {
      t[name] = (await createTestStaff({ username: `${STAFF_PREFIX}${name}`, role, branchId })).token;
    }
    const book = await one(`SELECT id, default_price::float AS price FROM books WHERE is_active = true AND default_price > 10 ORDER BY id LIMIT 1`);
    bookId = book.id;
    price = book.price;
    await db.query(`INSERT INTO inventory (book_id, location_id, quantity, average_cost) VALUES ($1, $2, 500, 4)`, [bookId, location]);
    customerId = (await ok(await as(t.sales).post('/api/v1/customers', { fullName: `${CODE} Selam`, phone: '+251911249006' }), 201)).id;
    const configured = await one(`SELECT value FROM system_config WHERE key = 'loyalty_accrual_rate'`);
    rate = configured ? Number(configured.value) : 0.01;
  });

  afterAll(cleanUp);

  // Enough copies that the order earns several points at the configured rate.
  const copies = () => Math.max(4, Math.ceil(10 / (price * rate)));

  it('earns points once a paid order is delivered in full (was: none)', async () => {
    const order = await confirmed(copies());
    const done = await deliver(order, copies());
    expect(done.status).toBe('COMPLETED');
    expect(await pointsOf(order.orderNumber)).toEqual({ earned: pointsFor(order.total), reversed: 0 });
  });

  it('earns them on a credit order only once it is paid in full', async () => {
    const order = await confirmed(copies(), 'credit_sale');
    await deliver(order, copies());
    expect((await pointsOf(order.orderNumber)).earned).toBe(0);
    await ok(await as(t.manager).post('/api/v1/payments', { orderId: Number(order.id), amount: order.total, paymentMethod: 'cash' }), 201);
    expect((await pointsOf(order.orderNumber)).earned).toBe(pointsFor(order.total));
  });

  it('earns them on what was delivered when the rest is cancelled', async () => {
    const n = copies() * 2;
    const order = await confirmed(n);
    await deliver(order, n / 2);
    expect((await pointsOf(order.orderNumber)).earned).toBe(0);
    const cancelled = await ok(await as(t.manager).post(`/api/v1/orders/${order.id}/cancel-rest`, { reason: 'Out of print', refundTo: 'original' }));
    expect(cancelled.status).toBe('COMPLETED');
    const kept = Number((order.total - (n / 2) * price).toFixed(2));
    expect((await pointsOf(order.orderNumber)).earned).toBe(pointsFor(kept));
  });

  it('takes back the points of delivered books returned later', async () => {
    const n = copies() * 2;
    const order = await confirmed(n);
    await deliver(order, n);
    const { earned } = await pointsOf(order.orderNumber);
    expect(earned).toBeGreaterThan(1);
    await ok(await as(t.manager).post('/api/v1/returns', {
      orderId: Number(order.id), reason: 'Bought twice', lines: [{ orderLineItemId: Number(order.lineItems[0].id), quantity: n / 2 }],
    }), 201);
    expect(await pointsOf(order.orderNumber)).toEqual({ earned, reversed: Math.floor(earned / 2) });
  });
});
