import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

// #109: stock leaving in a sale is recorded with reason "sale", so stock
// history and reports tell sales from shrinkage. POS sales were recorded as
// "loss" and confirmed orders as "correction".

const STAFF_PREFIX = 'salereason_test_';
const BRANCH_PREFIX = 'Sale Reason ';

describe('Stock leaving in a sale', () => {
  let branchId: number;
  let locationId: number;
  let bookId: number;
  let price: number;
  let manager: string;
  const api = () => request(getTestApp());
  const as = (r: request.Test) => r.set('Authorization', `Bearer ${manager}`).set('X-Branch-Id', String(branchId));

  const reasons = async (referenceType: string, referenceId: string): Promise<string[]> =>
    (await db.query(
      `SELECT reason_code FROM inventory_history WHERE movement_type = 'stock_out' AND reference_type = $1 AND reference_id = $2`,
      [referenceType, referenceId],
    )).rows.map((r) => r.reason_code);

  async function cleanUp() {
    const branches = `SELECT id FROM branches WHERE name LIKE '${BRANCH_PREFIX}%'`;
    const orders = `SELECT id FROM orders WHERE branch_id IN (${branches})`;
    const sales = `SELECT id FROM transactions WHERE branch_id IN (${branches})`;
    for (const statement of [
      `DELETE FROM order_payments WHERE order_id IN (${orders})`,
      `DELETE FROM inventory_reservations WHERE order_id IN (${orders})`,
      `DELETE FROM order_line_items WHERE order_id IN (${orders})`,
      `DELETE FROM orders WHERE id IN (${orders})`,
      `DELETE FROM transaction_payments WHERE transaction_id IN (${sales})`,
      `DELETE FROM transaction_line_items WHERE transaction_id IN (${sales})`,
      `DELETE FROM transactions WHERE id IN (${sales})`,
      `DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
    ]) {
      await db.query(statement);
    }
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    manager = (await createTestStaff({ username: `${STAFF_PREFIX}mgr`, role: 'Manager', branchId })).token;
    locationId = (await db.query(
      `INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Sale Reason Loc', true) RETURNING id`,
      [branchId],
    )).rows[0].id;
    const book = (await db.query(`SELECT id, default_price FROM books WHERE is_active = true AND default_price > 0 ORDER BY id LIMIT 1`)).rows[0];
    bookId = book.id;
    price = Number(book.default_price);
    await db.query(`INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version) VALUES ($1, $2, 50, 0, 0)`, [bookId, locationId]);
  });

  afterAll(cleanUp);

  it('records a POS sale as "sale" (was: "loss")', async () => {
    const res = await as(api().post('/api/v1/pos/transactions')).send({
      locationId, items: [{ bookId, quantity: 1 }], payments: [{ method: 'cash', amount: price }],
    });
    expect(res.status).toBe(201);
    expect(await reasons('sale', String(res.body.id))).toEqual(['sale']);
  });

  it('records a confirmed order as "sale" (was: "correction")', async () => {
    const created = await as(api().post('/api/v1/orders')).send({ locationId, items: [{ bookId, quantity: 1 }] });
    expect(created.status).toBe(201);
    const confirmed = await as(api().post(`/api/v1/orders/${created.body.id}/confirm`)).send({ paymentMethod: 'cash' });
    expect(confirmed.status).toBe(200);
    expect(await reasons('order_confirmed', String(created.body.id))).toEqual(['sale']);
  });

  it('still records a manual stock-out as "loss"', async () => {
    const { version } = (await db.query(`SELECT version FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locationId])).rows[0];
    const res = await as(api().post('/api/v1/inventory/stock-out')).send({
      bookId, locationId, quantity: 1, version, referenceType: 'manual', referenceId: 424242,
    });
    expect(res.status).toBe(200);
    expect(await reasons('manual', '424242')).toEqual(['loss']);
  });
});
