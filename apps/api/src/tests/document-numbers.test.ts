import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

// #68: order numbers and customer codes come from the document counters.
// Orders were numbered from the count of the day's orders, so two created at
// once, or one created after a draft of the day was deleted, took a number
// already used and failed with a 500. Customer codes were the highest code
// plus one, so two created at once collided the same way.

const STAFF_PREFIX = 'docnum_test_';
const BRANCH_PREFIX = 'Doc Number ';
const CUSTOMER_NAME = 'Doc Number Customer';

describe('Document numbers', () => {
  let branchId: number;
  let locationId: number;
  let bookId: number;
  let admin: string;
  const api = () => request(getTestApp());
  const as = (r: request.Test) => r.set('Authorization', `Bearer ${admin}`).set('X-Branch-Id', String(branchId));
  const createOrder = () => as(api().post('/api/v1/orders')).send({ locationId, items: [{ bookId, quantity: 1 }] });

  async function cleanUp() {
    const branches = `SELECT id FROM branches WHERE name LIKE '${BRANCH_PREFIX}%'`;
    const customers = `SELECT id FROM customers WHERE full_name = '${CUSTOMER_NAME}'`;
    for (const statement of [
      `DELETE FROM order_line_items WHERE order_id IN (SELECT id FROM orders WHERE branch_id IN (${branches}))`,
      `DELETE FROM orders WHERE branch_id IN (${branches})`,
      `DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM store_credit_accounts WHERE customer_id IN (${customers})`,
      `DELETE FROM loyalty_accounts WHERE customer_id IN (${customers})`,
      `DELETE FROM customers WHERE full_name = '${CUSTOMER_NAME}'`,
    ]) {
      await db.query(statement);
    }
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    admin = (await createTestStaff({ username: `${STAFF_PREFIX}admin`, role: 'Admin', branchId })).token;
    locationId = (await db.query(
      `INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Doc Number Loc', true) RETURNING id`,
      [branchId],
    )).rows[0].id;
    bookId = (await db.query(`SELECT id FROM books WHERE is_active = true AND default_price > 0 ORDER BY id LIMIT 1`)).rows[0].id;
    await db.query(`INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version) VALUES ($1, $2, 100, 0, 0)`, [bookId, locationId]);
  });

  afterAll(cleanUp);

  it('numbers a new order after a draft of the day was deleted (was: 500, number taken)', async () => {
    const first = await createOrder();
    const second = await createOrder();
    expect([first.status, second.status]).toEqual([201, 201]);
    expect((await as(api().delete(`/api/v1/orders/${first.body.id}`))).status).toBe(200);

    const third = await createOrder();
    expect(third.status).toBe(201);
    expect(third.body.orderNumber).not.toBe(second.body.orderNumber);
    expect(third.body.orderNumber).toMatch(/^ORD-\d{8}-\d{4,}$/);
  });

  it('gives orders created at the same moment distinct numbers (was: 500 for all but one)', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => createOrder()));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    expect(new Set(results.map((r) => r.body.orderNumber)).size).toBe(5);
  });

  it('gives customers created at the same moment distinct codes (was: 500 for all but one)', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => as(api().post('/api/v1/customers')).send({ fullName: CUSTOMER_NAME })),
    );
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    const codes = results.map((r) => r.body.customerCode as string);
    expect(new Set(codes).size).toBe(5);
    for (const code of codes) expect(code).toMatch(/^CUS-\d{4,}$/);
  });
});
