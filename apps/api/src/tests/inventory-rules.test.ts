import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

// Inventory rules from the move to the layered structure (#21, part 1 of 2).
// Each test names what the endpoint did before.

const STAFF_PREFIX = 'invrule_test_';
const BRANCH_PREFIX = 'Inv Rule ';

describe('Inventory rules', () => {
  let branchA: number;
  let branchB: number;
  let locA: number;
  let locA2: number;
  let locB: number;
  let bookId: number;
  let admin: string;
  let clerk: string;
  let sales: string;
  let globalAdmin: string;
  const api = () => request(getTestApp());
  const as = (r: request.Test, token: string) => r.set('Authorization', `Bearer ${token}`);

  async function setStock(locationId: number, quantity: number, reorderPoint = 3) {
    await db.query(
      `INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version) VALUES ($1, $2, $3, $4, 0)
       ON CONFLICT (book_id, location_id) DO UPDATE SET quantity = $3, reorder_point = $4, version = 0`,
      [bookId, locationId, quantity, reorderPoint],
    );
  }

  async function version(locationId: number): Promise<number> {
    return (await db.query(`SELECT version FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locationId]))
      .rows[0].version;
  }

  async function cleanUp() {
    const branches = (await db.query(`SELECT id FROM branches WHERE name LIKE $1`, [`${BRANCH_PREFIX}%`])).rows.map((r) => r.id);
    if (branches.length) {
      const locs = `(SELECT id FROM locations WHERE branch_id = ANY($1))`;
      await db.query(`DELETE FROM outbox WHERE (payload->>'locationId')::int IN ${locs}`, [branches]);
      await db.query(`DELETE FROM inventory_history WHERE location_id IN ${locs}`, [branches]);
      await db.query(`DELETE FROM inventory WHERE location_id IN ${locs}`, [branches]);
      await db.query(`DELETE FROM locations WHERE branch_id = ANY($1)`, [branches]);
    }
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    branchA = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    branchB = (await createTestBranch({ name: `${BRANCH_PREFIX}B` })).branchId;
    const location = async (branchId: number, name: string) =>
      (await db.query(`INSERT INTO locations (branch_id, name) VALUES ($1, $2) RETURNING id`, [branchId, name])).rows[0].id as number;
    locA = await location(branchA, 'Inv Rule A1');
    locA2 = await location(branchA, 'Inv Rule A2');
    locB = await location(branchB, 'Inv Rule B1');
    bookId = (await db.query(`SELECT id FROM books WHERE is_active = true ORDER BY id LIMIT 1`)).rows[0].id;

    admin = (await createTestStaff({ username: `${STAFF_PREFIX}admin`, role: 'Admin', branchId: branchA })).token;
    clerk = (await createTestStaff({ username: `${STAFF_PREFIX}clerk`, role: 'Stock_Clerk', branchId: branchA })).token;
    sales = (await createTestStaff({ username: `${STAFF_PREFIX}sales`, role: 'Sales', branchId: branchA })).token;
    const g = await createTestStaff({ username: `${STAFF_PREFIX}global`, role: 'Admin', branchId: branchA });
    await db.query(`UPDATE staff SET is_all_branches = true WHERE id = $1`, [g.staffId]);
    globalAdmin = g.token;
  });

  afterAll(cleanUp);

  beforeEach(async () => {
    await setStock(locA, 10);
  });

  describe('manual stock-out', () => {
    it('is refused to Sales, who sell through POS and orders (was: 200)', async () => {
      const res = await as(api().post('/api/v1/inventory/stock-out'), sales).send({ bookId, locationId: locA, quantity: 1, version: 0 });
      expect(res.status).toBe(403);
    });

    it('is allowed to a Stock_Clerk', async () => {
      const res = await as(api().post('/api/v1/inventory/stock-out'), clerk).send({ bookId, locationId: locA, quantity: 1, version: 0 });
      expect(res.status).toBe(200);
      expect(res.body.quantity).toBe(9);
    });

    it('refuses a reference type the database does not accept with 400 (was: 500)', async () => {
      const res = await as(api().post('/api/v1/inventory/stock-out'), clerk)
        .send({ bookId, locationId: locA, quantity: 1, version: 0, referenceType: 'gift' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });
  });

  describe('adjustment reasons', () => {
    const adjust = (delta: number, reasonCode: string) =>
      as(api().post('/api/v1/inventory/adjust'), clerk).send({ bookId, locationId: locA, delta, reasonCode, version: 0 });

    it('refuses damage or loss that adds stock (was: 200)', async () => {
      for (const reasonCode of ['damage', 'loss']) {
        const res = await adjust(5, reasonCode);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('VALIDATION_ERROR');
      }
      expect((await db.query(`SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locA])).rows[0].quantity).toBe(10);
    });

    it('refuses a return that takes stock away (was: 200)', async () => {
      const res = await adjust(-1, 'return');
      expect(res.status).toBe(400);
    });

    it('accepts damage that reduces stock, and a correction either way', async () => {
      expect((await adjust(-2, 'damage')).body.quantity).toBe(8);
      await setStock(locA, 10);
      expect((await adjust(3, 'correction')).body.quantity).toBe(13);
      await setStock(locA, 10);
      expect((await adjust(-3, 'correction')).body.quantity).toBe(7);
    });
  });

  describe('branch picker', () => {
    beforeEach(async () => {
      await setStock(locB, 1);
      await db.query(`DELETE FROM inventory_history WHERE location_id = $1`, [locB]);
      await db.query(
        `INSERT INTO inventory_history (book_id, location_id, qty_before, qty_after, delta, reason_code, movement_type, staff_id)
         VALUES ($1, $2, 0, 1, 1, 'correction', 'adjustment', (SELECT id FROM staff WHERE username = $3))`,
        [bookId, locB, `${STAFF_PREFIX}global`],
      );
    });

    it('shows another branch\'s low stock to staff with access to all branches (was: the session branch)', async () => {
      const res = await as(api().get(`/api/v1/inventory/low-stock?branchId=${branchB}&pageSize=100`), globalAdmin);
      expect(res.status).toBe(200);
      expect(res.body.items.map((i: { locationId: number }) => i.locationId)).toContain(locB);
    });

    it('shows another branch\'s stock movements to staff with access to all branches (was: the session branch)', async () => {
      const res = await as(api().get(`/api/v1/inventory/history?branchId=${branchB}&pageSize=100`), globalAdmin);
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeGreaterThan(0);
      expect(res.body.items.every((i: { locationId: number }) => i.locationId === locB)).toBe(true);
    });

    it('refuses another branch to everyone else with 403 (was: 200 with the session branch)', async () => {
      expect((await as(api().get(`/api/v1/inventory/low-stock?branchId=${branchB}`), admin)).status).toBe(403);
      expect((await as(api().get(`/api/v1/inventory/history?branchId=${branchB}`), admin)).status).toBe(403);
    });
  });

  describe('reorder point and initialize', () => {
    it('refuses a reorder point for a malformed book id with 400 (was: 500)', async () => {
      const res = await as(api().put('/api/v1/inventory/reorder-point'), admin).send({ bookId: 'abc', locationId: locA, reorderPoint: 4 });
      expect(res.status).toBe(400);
    });

    it('answers 404 for a book with no stock at the location', async () => {
      const res = await as(api().put('/api/v1/inventory/reorder-point'), admin).send({ bookId: 2_000_000_000, locationId: locA, reorderPoint: 4 });
      expect(res.status).toBe(404);
    });

    it('has retired POST /inventory/initialize (was: 200)', async () => {
      const res = await as(api().post('/api/v1/inventory/initialize'), admin).send({ bookId, locationId: locA2 });
      expect(res.status).toBe(410);
      expect(res.body.error).toBe('DEPRECATED');
    });
  });

  describe('stock alerts', () => {
    const alerts = async (event: string) =>
      Number((await db.query(
        `SELECT COUNT(*) FROM outbox WHERE event_type = $1 AND (payload->>'locationId')::int = $2`,
        [event, locA],
      )).rows[0].count);

    beforeEach(async () => {
      await db.query(`DELETE FROM outbox WHERE (payload->>'locationId')::int = $1`, [locA]);
      await setStock(locA, 6, 3);
    });

    it('are raised once when stock falls to the reorder point, and once when it runs out (was: on every sale below it)', async () => {
      for (const quantity of [2, 2, 1, 1]) {
        const res = await as(api().post('/api/v1/inventory/stock-out'), clerk)
          .send({ bookId, locationId: locA, quantity, version: await version(locA) });
        expect(res.status).toBe(200);
      }
      expect(await alerts('inventory.low_stock')).toBe(1);
      expect(await alerts('inventory.out_of_stock')).toBe(1);
    });

    it('are not raised when a refused change rolls back', async () => {
      const res = await as(api().post('/api/v1/inventory/stock-out'), clerk)
        .send({ bookId, locationId: locA, quantity: 50, version: await version(locA) });
      expect(res.status).toBe(422);
      expect(await alerts('inventory.stock_out')).toBe(0);
      expect(await alerts('inventory.low_stock')).toBe(0);
    });
  });
});
