import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

// Stock movements after the move of inventoryTransaction.service into the
// Inventory module (#21, part 2 of 2). Each test names what happened before.

const STAFF_PREFIX = 'invmove_test_';
const BRANCH_PREFIX = 'Inv Move ';

describe('Stock movements', () => {
  let branchId: number;
  let locationId: number;
  let bookId: number;
  let price: number;
  let clerk: string;
  let sales: string;
  let superAdmin: string;
  const api = () => request(getTestApp());
  const as = (r: request.Test, token: string) => r.set('Authorization', `Bearer ${token}`);

  async function setStock(quantity: number, opts: { reorderPoint?: number; averageCost?: string } = {}) {
    await db.query(
      `INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version, average_cost) VALUES ($1, $2, $3, $4, 0, $5)
       ON CONFLICT (book_id, location_id) DO UPDATE SET quantity = $3, reorder_point = $4, version = 0, average_cost = $5`,
      [bookId, locationId, quantity, opts.reorderPoint ?? 0, opts.averageCost ?? '0'],
    );
  }

  async function level() {
    return (await db.query(`SELECT quantity, version, average_cost FROM inventory WHERE book_id = $1 AND location_id = $2`, [
      bookId,
      locationId,
    ])).rows[0] as { quantity: number; version: number; average_cost: string };
  }

  async function lastMovement() {
    return (await db.query(
      `SELECT qty_before, qty_after, delta, unit_cost, total_cost FROM inventory_history
       WHERE book_id = $1 AND location_id = $2 ORDER BY id DESC LIMIT 1`,
      [bookId, locationId],
    )).rows[0];
  }

  const allowNegativeStock = (value: boolean) =>
    as(api().put('/api/v1/config/system/allow_negative_stock'), superAdmin).send({ value });

  async function cleanUp() {
    const branches = (await db.query(`SELECT id FROM branches WHERE name LIKE $1`, [`${BRANCH_PREFIX}%`])).rows.map((r) => r.id);
    if (branches.length) {
      const locs = `(SELECT id FROM locations WHERE branch_id = ANY($1))`;
      const txs = `(SELECT id FROM transactions WHERE branch_id = ANY($1))`;
      await db.query(`DELETE FROM outbox WHERE (payload->>'locationId')::int IN ${locs}`, [branches]);
      await db.query(`DELETE FROM transaction_payments WHERE transaction_id IN ${txs}`, [branches]);
      await db.query(`DELETE FROM transaction_line_items WHERE transaction_id IN ${txs}`, [branches]);
      await db.query(`DELETE FROM transactions WHERE branch_id = ANY($1)`, [branches]);
      await db.query(`DELETE FROM inventory_history WHERE location_id IN ${locs}`, [branches]);
      await db.query(`DELETE FROM inventory WHERE location_id IN ${locs}`, [branches]);
      await db.query(`DELETE FROM locations WHERE branch_id = ANY($1)`, [branches]);
    }
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}Branch` })).branchId;
    locationId = (await db.query(
      `INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Inv Move Floor', true) RETURNING id`,
      [branchId],
    )).rows[0].id;
    const book = (await db.query(
      `SELECT id, default_price FROM books WHERE is_active = true AND default_price > 0 ORDER BY id LIMIT 1`,
    )).rows[0];
    bookId = book.id;
    price = Number(book.default_price);
    clerk = (await createTestStaff({ username: `${STAFF_PREFIX}clerk`, role: 'Stock_Clerk', branchId })).token;
    sales = (await createTestStaff({ username: `${STAFF_PREFIX}sales`, role: 'Sales', branchId })).token;
    superAdmin = (await createTestStaff({ username: `${STAFF_PREFIX}super`, role: 'Super_Admin', branchId })).token;
  });

  afterAll(async () => {
    await allowNegativeStock(false);
    await cleanUp();
  });

  describe('negative stock, when the shop allows it', () => {
    beforeAll(async () => {
      expect((await allowNegativeStock(true)).status).toBe(200);
    });

    afterAll(async () => {
      expect((await allowNegativeStock(false)).status).toBe(200);
    });

    it('lets a stock-out go below zero, matching its history (was: quantity 0, history -5)', async () => {
      await setStock(2);
      const res = await as(api().post('/api/v1/inventory/stock-out'), clerk).send({ bookId, locationId, quantity: 5, version: 0 });
      expect(res.status).toBe(200);
      expect(res.body.quantity).toBe(-3);
      expect(await lastMovement()).toMatchObject({ qty_before: 2, qty_after: -3, delta: -5 });
    });

    it('lets a manual adjustment go below zero (was: 422 INSUFFICIENT_STOCK)', async () => {
      await setStock(2);
      const res = await as(api().post('/api/v1/inventory/adjust'), clerk)
        .send({ bookId, locationId, delta: -5, reasonCode: 'loss', version: 0 });
      expect(res.status).toBe(200);
      expect(res.body.quantity).toBe(-3);
    });

    it('brings a negative shelf back to the true count with the next receipt', async () => {
      await setStock(-3);
      const res = await as(api().post('/api/v1/inventory/stock-in'), clerk).send({ bookId, locationId, quantity: 10, version: 0 });
      expect(res.status).toBe(200);
      expect(res.body.quantity).toBe(7);
    });
  });

  it('still refuses to go below zero while negative stock is not allowed', async () => {
    await setStock(2);
    const res = await as(api().post('/api/v1/inventory/stock-out'), clerk).send({ bookId, locationId, quantity: 5, version: 0 });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('INSUFFICIENT_STOCK');
    expect((await level()).quantity).toBe(2);
  });

  it('values an adjustment at the average cost, leaving the average as it was (was: no cost)', async () => {
    await setStock(10, { averageCost: '12.5000' });
    const res = await as(api().post('/api/v1/inventory/adjust'), clerk)
      .send({ bookId, locationId, delta: -2, reasonCode: 'damage', version: 0 });
    expect(res.status).toBe(200);
    expect(await lastMovement()).toMatchObject({ delta: -2, unit_cost: '12.50', total_cost: '25.00' });
    expect((await level()).average_cost).toBe('12.5000');
  });

  describe('stock alerts from sales', () => {
    const alerts = async (event: string) =>
      Number((await db.query(
        `SELECT COUNT(*) FROM outbox WHERE event_type = $1 AND (payload->>'locationId')::int = $2`,
        [event, locationId],
      )).rows[0].count);

    beforeEach(async () => {
      await db.query(`DELETE FROM outbox WHERE (payload->>'locationId')::int = $1`, [locationId]);
    });

    it('are raised by a POS sale that takes stock to the reorder point (was: none)', async () => {
      await setStock(5, { reorderPoint: 3, averageCost: '10' });
      const res = await as(api().post('/api/v1/pos/transactions'), sales).send({
        locationId,
        items: [{ bookId, quantity: 2 }],
        payments: [{ method: 'cash', amount: price * 2 }],
      });
      expect(res.status).toBe(201);
      expect((await level()).quantity).toBe(3);
      expect(await alerts('inventory.low_stock')).toBe(1);
    });

    it('are raised by a POS sale that empties the shelf (was: none)', async () => {
      await setStock(1, { reorderPoint: 3, averageCost: '10' });
      const res = await as(api().post('/api/v1/pos/transactions'), sales).send({
        locationId,
        items: [{ bookId, quantity: 1 }],
        payments: [{ method: 'cash', amount: price }],
      });
      expect(res.status).toBe(201);
      expect(await alerts('inventory.out_of_stock')).toBe(1);
    });
  });
});
