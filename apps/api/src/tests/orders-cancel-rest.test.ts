/**
 * orders-cancel-rest.test.ts
 *
 * #174 (owner decisions 1a–5a, 2026-10-31): what a part-delivered order will
 * never deliver is cancelled in one step. It is recorded as a return (RET-)
 * of the undelivered copies, marked as never delivered, so the reports
 * subtract it as they subtract returns. The copies go back to stock at the
 * cost they left at; a credit order's debt takes the value first and the
 * rest goes back the way it was paid or as store credit. Whoever sells
 * cancels, with PROCESS_REFUND when money goes back. The order is completed.
 * Before, a part-delivered order could only be delivered in full.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'ocrest_test_';
const BRANCH_PREFIX = 'Order Cancel Rest ';
const CODE = 'OCREST';

interface Line { id: string; bookId: number; quantity: number; qtyReserved: number; qtyFulfilled: number; qtyReturned: number; qtyCancelled: number }
interface Order { id: string; orderNumber: string; status: string; total: number; amountPaid: number; lineItems: Line[]; allowedActions: string[] }

describe('Cancelling what a part-delivered order did not deliver (#174)', () => {
  let branchA: number;
  let location: number;
  let customerId: number;
  let books: Array<{ id: number; price: number }>;
  const t: Record<string, string> = {};
  const api = () => request(getTestApp());
  const as = (token: string) => ({
    get: (path: string) => api().get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) => api().post(path).set('Authorization', `Bearer ${token}`).send(body),
  });
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  const onHand = async (book: number) => Number((await one(`SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`, [book, location])).quantity);
  const reserved = async (orderId: string) =>
    Number((await one(`SELECT COALESCE(SUM(quantity), 0) AS q FROM inventory_reservations WHERE order_id = $1 AND status = 'reserved'`, [orderId])).q);
  const lineOf = (order: Order, book: number) => order.lineItems.find((l) => l.bookId === book)!;
  const cancelRest = (orderId: string, body: object, token = t.manager) => as(token).post(`/api/v1/orders/${orderId}/cancel-rest`, body);

  /** A confirmed order of 3 of the first book and 2 of the second, 2 of the first delivered. */
  async function partDelivered(sale: 'cash_sale' | 'credit_sale' = 'cash_sale', items?: object[]): Promise<Order> {
    const created = await as(t.sales).post('/api/v1/orders', {
      locationId: location, saleType: sale, customerId,
      items: items ?? [{ bookId: books[0].id, quantity: 3 }, { bookId: books[1].id, quantity: 2 }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const confirm = sale === 'cash_sale' ? { paymentMethod: 'cash' } : { dueDate: '2099-12-31' };
    const confirmed = await as(t.sales).post(`/api/v1/orders/${created.body.id}/confirm`, confirm);
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    const first = lineOf(confirmed.body, books[0].id);
    const res = await as(t.sales).post(`/api/v1/orders/${created.body.id}/deliveries`, { lines: [{ lineId: Number(first.id), quantity: Math.min(2, first.quantity) }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
  }

  async function cleanUp() {
    const branches = `SELECT id FROM branches WHERE name LIKE '${BRANCH_PREFIX}%'`;
    const orders = `SELECT id FROM orders WHERE branch_id IN (${branches})`;
    const customer = `SELECT id FROM customers WHERE customer_code = '${CODE}'`;
    for (const statement of [
      `DELETE FROM service_jobs WHERE service_line_id IN (SELECT id FROM sale_service_lines WHERE service_id IN (SELECT id FROM services WHERE code = '${CODE}'))`,
      `DELETE FROM sale_service_lines WHERE service_id IN (SELECT id FROM services WHERE code = '${CODE}')`,
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
      `DELETE FROM services WHERE code = '${CODE}'`,
      `DELETE FROM store_credit_history WHERE customer_id IN (${customer})`,
      `DELETE FROM store_credit_accounts WHERE customer_id IN (${customer})`,
      `DELETE FROM customers WHERE customer_code = '${CODE}'`,
    ]) {
      await db.query(statement).catch((err: { code?: string }) => {
        if (err.code !== '42P01' && err.code !== '42703') throw err;
      });
    }
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    branchA = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    const branchB = (await createTestBranch({ name: `${BRANCH_PREFIX}B` })).branchId;
    location = (await one(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Cancel shelf', true) RETURNING id`, [branchA])).id;
    for (const [name, role, branch] of [
      ['sales', 'Sales', branchA], ['manager', 'Manager', branchA], ['clerk', 'Stock_Clerk', branchA], ['managerB', 'Manager', branchB],
    ] as const) {
      t[name] = (await createTestStaff({ username: `${STAFF_PREFIX}${name}`, role, branchId: branch })).token;
    }
    books = (await db.query(`SELECT id, default_price::float AS price FROM books WHERE is_active = true AND default_price > 0 ORDER BY id LIMIT 2`)).rows;
    for (const b of books) await db.query(`INSERT INTO inventory (book_id, location_id, quantity, average_cost) VALUES ($1, $2, 30, 1)`, [b.id, location]);
    customerId = (await one(
      `INSERT INTO customers (branch_id, customer_code, full_name, is_active) VALUES ($1, $2, 'Cancel Rest Customer', true) RETURNING id`, [branchA, CODE],
    )).id;
  });

  afterAll(cleanUp);

  it('puts the undelivered copies back, refunds them as a return marked undelivered, and completes the order (was: no way)', async () => {
    const order = await partDelivered();
    const stock = [await onHand(books[0].id), await onHand(books[1].id)];
    const value = books[0].price + books[1].price * 2;
    const res = await cancelRest(order.id, { reason: 'Out of print', refundTo: 'original' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('COMPLETED');
    expect(res.body.lineItems.map((l: Line) => [l.qtyFulfilled, l.qtyReserved, l.qtyCancelled, l.qtyReturned])).toEqual([[2, 0, 1, 0], [0, 0, 2, 0]]);
    expect(res.body.amountPaid).toBeCloseTo(order.total - value, 2);
    expect(res.body.allowedActions).toEqual(expect.arrayContaining(['print', 'return']));
    expect(res.body.allowedActions).not.toContain('deliver');
    expect([await onHand(books[0].id), await onHand(books[1].id), await reserved(order.id)]).toEqual([stock[0] + 1, stock[1] + 2, 0]);

    const ret = await one(`SELECT id, return_number, undelivered, total_refund_amount::float AS total, refund_method, reason FROM returns WHERE order_id = $1`, [order.id]);
    expect(ret).toMatchObject({ undelivered: true, refund_method: 'cash', reason: 'Not delivered: Out of print' });
    expect(ret.total).toBeCloseTo(value, 2);
    const listed = (await as(t.manager).get(`/api/v1/returns/${ret.id}`)).body;
    expect(listed).toMatchObject({ returnNumber: ret.return_number, undelivered: true });
    const audit = await one(`SELECT meta FROM audit_logs WHERE entity_type = 'order' AND entity_id = $1 AND meta->>'action' = 'cancel_rest'`, [order.id]);
    expect(audit.meta).toMatchObject({ fromStatus: 'PART_DELIVERED', toStatus: 'COMPLETED', returnNumber: ret.return_number, reason: 'Out of print' });

    // What was delivered is returned as before; what was not cannot come back again.
    const back = (quantity: number) => as(t.manager).post('/api/v1/returns', {
      orderId: Number(order.id), lines: [{ orderLineItemId: Number(lineOf(order, books[0].id).id), quantity }], reason: 'Not wanted',
    });
    expect((await back(3)).body.error).toBe('OVER_RETURN');
    expect((await back(2)).status).toBe(201);
  });

  it('takes a credit order\'s undelivered value off its debt, which whoever sells may do', async () => {
    const order = await partDelivered('credit_sale');
    const value = books[0].price + books[1].price * 2;
    const res = await cancelRest(order.id, { reason: 'Customer changed mind' }, t.sales);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('COMPLETED');
    const debt = await one(`SELECT outstanding_amount::float AS owed FROM receivables WHERE source_type = 'order_credit_sale' AND source_entity_id = $1`, [order.id]);
    expect(debt.owed).toBeCloseTo(order.total - value, 2);
    const ret = await one(`SELECT undelivered, refund_method FROM returns WHERE order_id = $1`, [order.id]);
    expect(ret).toEqual({ undelivered: true, refund_method: 'credit_note' });
  });

  it('refuses an order with nothing delivered or nothing waiting, money back without a refunder, and other roles and branches', async () => {
    const order = await partDelivered();
    expect((await cancelRest(order.id, { reason: 'x', refundTo: 'original' }, t.sales)).status).toBe(403);
    expect((await cancelRest(order.id, { reason: 'x' })).body.error).toBe('VALIDATION_ERROR');
    expect((await cancelRest(order.id, { reason: 'x', refundTo: 'original' }, t.clerk)).status).toBe(403);
    expect((await cancelRest(order.id, { reason: 'x', refundTo: 'original' }, t.managerB)).status).toBe(404);
    const after = (await as(t.manager).get(`/api/v1/orders/${order.id}`)).body as Order;
    expect([after.status, lineOf(after, books[1].id).qtyReserved]).toEqual(['PART_DELIVERED', 2]);
    expect(await one(`SELECT id FROM returns WHERE order_id = $1`, [order.id])).toBeUndefined();

    const confirmed = await as(t.sales).post('/api/v1/orders', { locationId: location, saleType: 'cash_sale', items: [{ bookId: books[0].id, quantity: 1 }] });
    await as(t.sales).post(`/api/v1/orders/${confirmed.body.id}/confirm`, { paymentMethod: 'cash' });
    expect((await cancelRest(confirmed.body.id, { reason: 'x', refundTo: 'original' })).body.error).toBe('INVALID_STATE');
    await cancelRest(order.id, { reason: 'x', refundTo: 'original' });
    expect((await cancelRest(order.id, { reason: 'x', refundTo: 'original' })).body.error).toBe('INVALID_STATE');
  });

  it('leaves a waiting binding to be delivered or cancelled first', async () => {
    const formatId = (await one(`SELECT id FROM book_formats ORDER BY id LIMIT 1`)).id;
    const serviceId = (await one(
      `INSERT INTO services (code, name, format_id, fee, standard_cost) VALUES ($1, 'Rest binding', $2, 50, 20) RETURNING id`, [CODE, formatId],
    )).id;
    const order = await partDelivered('cash_sale', [{ bookId: books[0].id, quantity: 1 }, { bookId: books[1].id, quantity: 1, service: { serviceId, quantity: 1 } }]);
    const res = await cancelRest(order.id, { reason: 'x', refundTo: 'original' });
    expect([res.status, res.body.error]).toEqual([422, 'UNDELIVERED_BINDING']);
  });
});
