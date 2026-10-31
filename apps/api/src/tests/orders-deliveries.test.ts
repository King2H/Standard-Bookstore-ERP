/**
 * orders-deliveries.test.ts
 *
 * #174 PR 2 (owner decision 2a, 2026-10-31): an order is delivered in parts.
 * A delivery names the copies handed over per line, at most what is still
 * waiting; each is numbered DLV- by the shop's daily counter, audited, and
 * listed on the order. The order is "PART_DELIVERED" until every copy is
 * delivered, then completed as before; Fulfill delivers what is left. The
 * copies a part-delivered order handed over can be returned, the window
 * counting from the latest delivery. Before, delivery was all or nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'odlv_test_';
const BRANCH_PREFIX = 'Order Delivery ';
const SERVICE_CODE = 'ODLV-BIND';

interface Line { id: string; bookId: number; quantity: number; qtyReserved: number; qtyFulfilled: number }

describe('Delivering an order in parts (#174)', () => {
  let branchA: number;
  let location: number;
  let books: number[];
  const t: Record<string, string> = {};
  const api = () => request(getTestApp());
  const as = (token: string) => ({
    get: (path: string) => api().get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) => api().post(path).set('Authorization', `Bearer ${token}`).send(body),
  });
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  const reserved = async (book: number) =>
    Number((await one(`SELECT COALESCE(SUM(quantity), 0) AS q FROM inventory_reservations WHERE book_id = $1 AND location_id = $2 AND status = 'reserved'`, [book, location])).q);
  const onHand = async (book: number) => Number((await one(`SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`, [book, location])).quantity);
  const deliver = (orderId: string, body: object = {}, token = t.sales) => as(token).post(`/api/v1/orders/${orderId}/deliveries`, body);
  const lineOf = (order: { lineItems: Line[] }, book: number) => order.lineItems.find((l) => l.bookId === book)!;

  /** A confirmed cash order of 3 of the first book and 2 of the second. */
  async function confirmed(): Promise<{ id: string; orderNumber: string; lineItems: Line[] }> {
    const created = await as(t.sales).post('/api/v1/orders', {
      locationId: location, saleType: 'cash_sale', items: [{ bookId: books[0], quantity: 3 }, { bookId: books[1], quantity: 2 }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const res = await as(t.sales).post(`/api/v1/orders/${created.body.id}/confirm`, { paymentMethod: 'cash' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  }

  async function cleanUp() {
    const branches = `SELECT id FROM branches WHERE name LIKE '${BRANCH_PREFIX}%'`;
    const orders = `SELECT id FROM orders WHERE branch_id IN (${branches})`;
    for (const statement of [
      `DELETE FROM order_delivery_lines WHERE delivery_id IN (SELECT id FROM order_deliveries WHERE order_id IN (${orders}))`,
      `DELETE FROM order_deliveries WHERE order_id IN (${orders})`,
      `DELETE FROM return_line_items WHERE return_id IN (SELECT id FROM returns WHERE branch_id IN (${branches}))`,
      `DELETE FROM order_refunds WHERE payment_id IN (SELECT id FROM order_payments WHERE order_id IN (${orders}))`,
      `DELETE FROM returns WHERE branch_id IN (${branches})`,
      `DELETE FROM order_payments WHERE order_id IN (${orders})`,
      `DELETE FROM inventory_reservations WHERE order_id IN (${orders})`,
      `DELETE FROM service_jobs WHERE service_line_id IN (SELECT id FROM sale_service_lines WHERE service_id IN (SELECT id FROM services WHERE code = '${SERVICE_CODE}'))`,
      `DELETE FROM sale_service_lines WHERE service_id IN (SELECT id FROM services WHERE code = '${SERVICE_CODE}')`,
      `DELETE FROM orders WHERE branch_id IN (${branches})`,
      `DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM services WHERE code = '${SERVICE_CODE}'`,
      `DELETE FROM customers WHERE customer_code = '${SERVICE_CODE}'`,
    ]) {
      await db.query(statement).catch((err: { code?: string }) => {
        // Before the migration the delivery tables do not exist yet.
        if (err.code !== '42P01') throw err;
      });
    }
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    branchA = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    const branchB = (await createTestBranch({ name: `${BRANCH_PREFIX}B` })).branchId;
    location = (await one(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Delivery shelf', true) RETURNING id`, [branchA])).id;
    for (const [name, role, branch] of [
      ['sales', 'Sales', branchA], ['manager', 'Manager', branchA], ['clerk', 'Stock_Clerk', branchA], ['salesB', 'Sales', branchB],
    ] as const) {
      t[name] = (await createTestStaff({ username: `${STAFF_PREFIX}${name}`, role, branchId: branch })).token;
    }
    books = (await db.query(`SELECT id FROM books WHERE is_active = true AND default_price > 0 ORDER BY id LIMIT 2`)).rows.map((r) => r.id as number);
    for (const b of books) await db.query(`INSERT INTO inventory (book_id, location_id, quantity, average_cost) VALUES ($1, $2, 20, 1)`, [b, location]);
  });

  afterAll(cleanUp);

  it('delivers some copies, numbered DLV-, and the order waits for the rest (was: all or nothing)', async () => {
    const order = await confirmed();
    const stockBefore = await onHand(books[0]);
    const res = await deliver(order.id, { lines: [{ lineId: Number(lineOf(order, books[0]).id), quantity: 2 }], notes: 'Customer took two' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.status).toBe('PART_DELIVERED');
    expect(lineOf(res.body, books[0])).toMatchObject({ qtyFulfilled: 2, qtyReserved: 1 });
    expect(lineOf(res.body, books[1])).toMatchObject({ qtyFulfilled: 0, qtyReserved: 2 });
    expect(res.body.deliveries).toEqual([expect.objectContaining({
      notes: 'Customer took two', lines: [expect.objectContaining({ bookId: books[0], quantity: 2 })],
    })]);
    expect(res.body.deliveries[0].deliveryNumber).toMatch(/^DLV-\d{8}-\d{4}$/);
    expect(res.body.fulfilledAt).not.toBeNull();
    // The copies left stock at confirmation; delivering frees their reservation.
    expect([await onHand(books[0]), await reserved(books[0])]).toEqual([stockBefore, 1]);
    expect(res.body.allowedActions).toEqual(expect.arrayContaining(['deliver', 'fulfill']));
    expect(res.body.allowedActions).not.toContain('cancel');
    const audit = await one(`SELECT meta FROM audit_logs WHERE entity_type = 'order' AND entity_id = $1 AND meta->>'action' = 'deliver'`, [order.id]);
    expect(audit.meta).toMatchObject({ deliveryNumber: res.body.deliveries[0].deliveryNumber, toStatus: 'PART_DELIVERED' });

    // The rest, with no lines named: everything still waiting; the order completes.
    const rest = await deliver(order.id);
    expect(rest.status, JSON.stringify(rest.body)).toBe(201);
    expect(rest.body.status).toBe('COMPLETED');
    expect(rest.body.lineItems.map((l: Line) => [l.qtyFulfilled, l.qtyReserved])).toEqual([[3, 0], [2, 0]]);
    expect(rest.body.deliveries).toHaveLength(2);
    expect(await reserved(books[0])).toBe(0);
    expect((await deliver(order.id)).body.error).toBe('INVALID_STATE');
  });

  it('refuses more than is waiting, a line of another order, a draft, and roles that do not deliver', async () => {
    const order = await confirmed();
    const other = await confirmed();
    const line = Number(lineOf(order, books[1]).id);
    const over = await deliver(order.id, { lines: [{ lineId: line, quantity: 3 }] });
    expect([over.status, over.body.error]).toEqual([422, 'DELIVERY_EXCEEDS_REMAINING']);
    expect((await deliver(order.id, { lines: [{ lineId: Number(lineOf(other, books[1]).id), quantity: 1 }] })).status).toBe(404);
    const draft = await as(t.sales).post('/api/v1/orders', { locationId: location, items: [{ bookId: books[0], quantity: 1 }] });
    expect((await deliver(draft.body.id)).body.error).toBe('INVALID_STATE');
    expect((await deliver(order.id, {}, t.clerk)).status).toBe(403);
    expect((await deliver(order.id, {}, t.salesB)).status).toBe(404);
    const after = (await as(t.sales).get(`/api/v1/orders/${order.id}`)).body;
    expect([after.status, after.deliveries]).toEqual(['CONFIRMED', []]);
  });

  it('delivers what is left when fulfilled, and is not cancelled once part delivered', async () => {
    const order = await confirmed();
    await deliver(order.id, { lines: [{ lineId: Number(lineOf(order, books[0]).id), quantity: 1 }] });
    const cancel = await as(t.manager).post(`/api/v1/orders/${order.id}/cancel`, { reason: 'Changed mind', refundTo: 'original' });
    expect([cancel.status, cancel.body.error]).toEqual([422, 'ORDER_PART_DELIVERED']);
    // Still waiting for copies, so still a pending order on the dashboard.
    const pending = async () => (await as(t.manager).get('/api/v1/reports/kpis')).body.pendingOrders as number;
    const before = await pending();
    const res = await as(t.sales).post(`/api/v1/orders/${order.id}/fulfill`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('COMPLETED');
    expect(res.body.deliveries).toHaveLength(2);
    expect(res.body.deliveries[1].lines.map((l: { quantity: number }) => l.quantity)).toEqual([2, 2]);
    expect(await pending()).toBe(before - 1);
  });

  it('returns what a part-delivered order handed over, not what it did not', async () => {
    const order = await confirmed();
    const line = Number(lineOf(order, books[0]).id);
    await deliver(order.id, { lines: [{ lineId: line, quantity: 1 }] });
    const ret = (quantity: number) =>
      as(t.manager).post('/api/v1/returns', { orderId: Number(order.id), lines: [{ orderLineItemId: line, quantity }], reason: 'Not wanted' });
    const over = await ret(2);
    expect([over.status, over.body.error]).toEqual([422, 'OVER_RETURN']);
    const ok = await ret(1);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it('hands over the lines without a binding while a job is not ready, and the bound line once it is (#169)', async () => {
    const formatId = (await one(`SELECT id FROM book_formats ORDER BY id LIMIT 1`)).id;
    const serviceId = (await one(
      `INSERT INTO services (code, name, format_id, fee, standard_cost) VALUES ($1, 'Delivery binding', $2, 50, 20) RETURNING id`, [SERVICE_CODE, formatId],
    )).id;
    const customerId = (await one(
      `INSERT INTO customers (branch_id, customer_code, full_name, is_active) VALUES ($1, $2, 'Binding Customer', true) RETURNING id`, [branchA, SERVICE_CODE],
    )).id;
    const created = await as(t.sales).post('/api/v1/orders', {
      locationId: location, saleType: 'cash_sale', customerId,
      items: [{ bookId: books[0], quantity: 1, service: { serviceId, quantity: 1 } }, { bookId: books[1], quantity: 2 }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const order = (await as(t.sales).post(`/api/v1/orders/${created.body.id}/confirm`, { paymentMethod: 'cash' })).body;
    const bound = lineOf(order, books[0]) as Line & { service: { job: { id: number } } };
    const plain = await deliver(order.id, { lines: [{ lineId: Number(lineOf(order, books[1]).id), quantity: 2 }] });
    expect([plain.status, plain.body.status]).toEqual([201, 'PART_DELIVERED']);
    const early = await deliver(order.id, { lines: [{ lineId: Number(bound.id), quantity: 1 }] });
    expect([early.status, early.body.error]).toEqual([422, 'SERVICE_JOBS_OPEN']);
    await db.query(`UPDATE service_jobs SET status = 'READY' WHERE id = $1`, [bound.service.job.id]);
    const res = await deliver(order.id, { lines: [{ lineId: Number(bound.id), quantity: 1 }] });
    expect([res.status, res.body.status]).toEqual([201, 'COMPLETED']);
    expect((await one(`SELECT status FROM service_jobs WHERE id = $1`, [bound.service.job.id])).status).toBe('COLLECTED');
  });
});
