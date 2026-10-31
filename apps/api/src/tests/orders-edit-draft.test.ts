/**
 * orders-edit-draft.test.ts
 *
 * #174 PR 1 (owner decision 1a, 2026-10-31): a draft order is edited until it
 * is confirmed: its lines, customer, discounts, location, channel, sale type
 * and notes, with the same checks as creating it, by the selling roles of its
 * branch, audited. Each line says how its discount was given, so the screen
 * opens a draft as it was entered. Before, there was no way to change a
 * draft: it was cancelled and created again.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'oedit_test_';
const BRANCH_PREFIX = 'Order Edit ';
const CUSTOMER_PREFIX = 'OEDIT-';

describe('Editing a draft order (#174)', () => {
  let branchA: number;
  let location: number;
  let books: Array<{ id: number; price: number }>;
  let customerId: number;
  const t: Record<string, string> = {};
  const api = () => request(getTestApp());
  const as = (token: string) => ({
    get: (path: string) => api().get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) => api().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object = {}) => api().put(path).set('Authorization', `Bearer ${token}`).send(body),
  });
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  const draft = async (items: object[] = [{ bookId: books[0].id, quantity: 1 }]) => {
    const res = await as(t.sales).post('/api/v1/orders', { locationId: location, saleType: 'cash_sale', items });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; orderNumber: string; total: number };
  };

  async function cleanUp() {
    const branches = `SELECT id FROM branches WHERE name LIKE '${BRANCH_PREFIX}%'`;
    for (const statement of [
      `DELETE FROM order_refunds WHERE payment_id IN (SELECT id FROM order_payments WHERE order_id IN (SELECT id FROM orders WHERE branch_id IN (${branches})))`,
      `DELETE FROM order_payments WHERE order_id IN (SELECT id FROM orders WHERE branch_id IN (${branches}))`,
      `DELETE FROM cash_session_movements WHERE session_id IN (SELECT id FROM cash_sessions WHERE branch_id IN (${branches}))`,
      `DELETE FROM inventory_reservations WHERE order_id IN (SELECT id FROM orders WHERE branch_id IN (${branches}))`,
      `DELETE FROM orders WHERE branch_id IN (${branches})`,
      `DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM customers WHERE customer_code LIKE '${CUSTOMER_PREFIX}%'`,
    ]) {
      await db.query(statement).catch((err: { code?: string }) => {
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
    location = (await one(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Edit shelf', true) RETURNING id`, [branchA])).id;
    for (const [name, role, branch] of [
      ['sales', 'Sales', branchA], ['manager', 'Manager', branchA], ['clerk', 'Stock_Clerk', branchA], ['salesB', 'Sales', branchB],
    ] as const) {
      t[name] = (await createTestStaff({ username: `${STAFF_PREFIX}${name}`, role, branchId: branch })).token;
    }
    books = (await db.query(`SELECT id, default_price::float AS price FROM books WHERE is_active = true AND default_price > 0 ORDER BY id LIMIT 3`)).rows;
    for (const b of books) {
      await db.query(`INSERT INTO inventory (book_id, location_id, quantity, average_cost) VALUES ($1, $2, 10, 1)`, [b.id, location]);
    }
    customerId = (await one(
      `INSERT INTO customers (branch_id, customer_code, full_name, is_active) VALUES ($1, '${CUSTOMER_PREFIX}1', 'Edit Customer', true) RETURNING id`,
      [branchA],
    )).id;
  });

  afterAll(cleanUp);

  it('changes a draft\'s lines, customer, discounts, sale type and notes, priced again (was: no way to edit)', async () => {
    const order = await draft();
    expect((await as(t.sales).get(`/api/v1/orders/${order.id}`)).body.allowedActions).toContain('edit');
    const res = await as(t.manager).put(`/api/v1/orders/${order.id}`, {
      customerId, locationId: location, channel: 'phone', saleType: 'credit_sale', notes: 'Call before delivery',
      items: [
        { bookId: books[1].id, quantity: 2, discountMode: 'Percentage', discountPct: 10, discountType: 'Merchant' },
        { bookId: books[2].id, quantity: 1 },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const subtotal = books[1].price * 2 + books[2].price;
    expect(res.body).toMatchObject({
      id: order.id, orderNumber: order.orderNumber, status: 'DRAFT', customerId, channel: 'phone', saleType: 'credit_sale', notes: 'Call before delivery',
    });
    expect(res.body.total).toBeCloseTo(subtotal - books[1].price * 2 * 0.1, 2);
    expect(res.body.lineItems.map((l: { bookId: number; quantity: number; discountType: string; discountMode: string; discountPct: number }) =>
      [l.bookId, l.quantity, l.discountType, l.discountMode, l.discountPct])).toEqual([
      [books[1].id, 2, 'Merchant', 'Percentage', 10],
      [books[2].id, 1, 'Normal', 'Amount', 0],
    ]);
    const audit = await one(
      `SELECT action, meta FROM audit_logs WHERE entity_type = 'order' AND entity_id = $1 AND action = 'UPDATE' ORDER BY id DESC LIMIT 1`, [order.id],
    );
    expect(audit.meta).toMatchObject({ orderNumber: order.orderNumber, before: { total: order.total, itemCount: 1 }, after: { itemCount: 2 } });
  });

  it('checks an edit as it checks a new order, and leaves the draft as it was when refused', async () => {
    const order = await draft();
    const cases: Array<[object, number, string]> = [
      [{ saleType: 'credit_sale', items: [{ bookId: books[0].id, quantity: 1 }] }, 422, 'CREDIT_REQUIRES_CUSTOMER'],
      [{ items: [{ bookId: books[0].id, quantity: 1, discountMode: 'Percentage', discountPct: 100 }] }, 422, 'DISCOUNT_EXCEEDS_LIMIT'],
      [{ locationId: location, items: [{ bookId: books[0].id, quantity: 11 }] }, 422, 'INSUFFICIENT_STOCK'],
      [{ items: [] }, 400, 'VALIDATION_ERROR'],
    ];
    for (const [body, status, code] of cases) {
      const res = await as(t.sales).put(`/api/v1/orders/${order.id}`, body);
      expect([res.status, res.body.error], JSON.stringify(body)).toEqual([status, code]);
    }
    const after = (await as(t.sales).get(`/api/v1/orders/${order.id}`)).body;
    expect([after.total, after.lineItems.length, after.saleType]).toEqual([order.total, 1, 'cash_sale']);
  });

  it('is refused once the order is confirmed, which then offers no edit', async () => {
    const order = await draft();
    const confirmed = await as(t.sales).post(`/api/v1/orders/${order.id}/confirm`, { paymentMethod: 'cash' });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body.allowedActions).not.toContain('edit');
    const res = await as(t.sales).put(`/api/v1/orders/${order.id}`, { items: [{ bookId: books[0].id, quantity: 2 }] });
    expect([res.status, res.body.error]).toEqual([422, 'INVALID_STATE']);
  });

  it('is done by the selling roles of the order\'s branch only', async () => {
    const order = await draft();
    const body = { items: [{ bookId: books[0].id, quantity: 2 }] };
    expect((await as(t.clerk).put(`/api/v1/orders/${order.id}`, body)).status).toBe(403);
    expect((await as(t.salesB).put(`/api/v1/orders/${order.id}`, body)).status).toBe(404);
    expect((await as(t.clerk).get(`/api/v1/orders/${order.id}`)).body.allowedActions ?? []).not.toContain('edit');
  });
});
