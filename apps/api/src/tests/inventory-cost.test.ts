import { createRequire } from 'node:module';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { closeOwnerDb, ownerDb } from './helpers/ownerDb.js';
import { db } from '../db/index.js';
import { withTransaction } from '../db/tx.js';
import { costBasisLateralJoin } from '../lib/costBasis.js';
import * as inventoryService from '../modules/inventory/inventory.service.js';
import { getStockExportRows } from '../modules/reports/inventory/inventoryReports.service.js';

// #163: stock that arrived without a cost was valued at 0. Stock-in by hand
// carries a cost (decision 1a); stock arriving without one on a row that has
// no cost takes the book's latest known cost (2a); rows still at 0 get a cost
// by a repair migration or by hand, Set cost (3a); the valuation export and
// the dashboard value stock the same way, at its average cost (4a).

const STAFF_PREFIX = 'invcost_test_';
const BRANCH_PREFIX = 'Inv Cost ';
const BOOK_PREFIX = 'InvCost Book ';

describe('Inventory cost (#163)', () => {
  let branchId: number;
  let otherBranchId: number;
  let shelfA: number;
  let shelfB: number;
  let otherShelf: number;
  let clerk: string;
  let manager: string;
  let clerkId: number;
  let books = 0;
  const api = () => request(getTestApp());
  const as = (r: request.Test, token: string) => r.set('Authorization', `Bearer ${token}`);

  async function newBook(): Promise<number> {
    books += 1;
    return (await db.query(
      `INSERT INTO books (isbn, title, default_price, is_active) VALUES ($1, $2, 30, true) RETURNING id`,
      [`979${String(Date.now()).slice(-7)}${String(books).padStart(3, '0')}`, `${BOOK_PREFIX}${books}`],
    )).rows[0].id;
  }

  /** A row the way v1 and the old stock-in left it: copies on hand, no cost. */
  async function unvalued(bookId: number, locationId: number, quantity: number) {
    await db.query(
      `INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version, average_cost) VALUES ($1, $2, $3, 0, 0, 0)`,
      [bookId, locationId, quantity],
    );
  }

  async function row(bookId: number, locationId: number) {
    const r = (await db.query(
      `SELECT quantity, version, average_cost, inventory_value FROM inventory WHERE book_id = $1 AND location_id = $2`,
      [bookId, locationId],
    )).rows[0];
    return r && { quantity: r.quantity as number, version: r.version as number, cost: r.average_cost as string, value: r.inventory_value as string };
  }

  async function lastMovement(bookId: number, locationId: number) {
    return (await db.query(
      `SELECT delta, reason_code, movement_type, unit_cost, notes FROM inventory_history
       WHERE book_id = $1 AND location_id = $2 ORDER BY id DESC LIMIT 1`,
      [bookId, locationId],
    )).rows[0];
  }

  const stockIn = (body: Record<string, unknown>) => as(api().post('/api/v1/inventory/stock-in'), clerk).send({ version: 0, ...body });
  const setCost = (token: string, body: Record<string, unknown>) => as(api().post('/api/v1/inventory/set-cost'), token).send(body);

  async function cleanUp() {
    const branches = (await db.query(`SELECT id FROM branches WHERE name LIKE $1`, [`${BRANCH_PREFIX}%`])).rows.map((r) => r.id);
    const bookIds = (await db.query(`SELECT id FROM books WHERE title LIKE $1`, [`${BOOK_PREFIX}%`])).rows.map((r) => r.id);
    if (branches.length) {
      const locs = `(SELECT id FROM locations WHERE branch_id = ANY($1))`;
      await db.query(`DELETE FROM outbox WHERE (payload->>'locationId')::int IN ${locs}`, [branches]);
      await db.query(`DELETE FROM inventory_history WHERE location_id IN ${locs}`, [branches]);
      await db.query(`DELETE FROM inventory WHERE location_id IN ${locs}`, [branches]);
      await db.query(`DELETE FROM audit_logs WHERE branch_id = ANY($1)`, [branches]);
      await db.query(`DELETE FROM locations WHERE branch_id = ANY($1)`, [branches]);
    }
    if (bookIds.length) await db.query(`DELETE FROM books WHERE id = ANY($1)`, [bookIds]);
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}Branch` })).branchId;
    otherBranchId = (await createTestBranch({ name: `${BRANCH_PREFIX}Other` })).branchId;
    const shelf = async (branch: number, name: string) =>
      (await db.query(`INSERT INTO locations (branch_id, name) VALUES ($1, $2) RETURNING id`, [branch, name])).rows[0].id as number;
    shelfA = await shelf(branchId, 'Inv Cost A');
    shelfB = await shelf(branchId, 'Inv Cost B');
    otherShelf = await shelf(otherBranchId, 'Inv Cost Elsewhere');
    const c = await createTestStaff({ username: `${STAFF_PREFIX}clerk`, role: 'Stock_Clerk', branchId });
    clerk = c.token;
    clerkId = c.staffId;
    manager = (await createTestStaff({ username: `${STAFF_PREFIX}manager`, role: 'Manager', branchId })).token;
  });

  afterAll(async () => {
    await cleanUp();
    await closeOwnerDb();
  });

  describe('stock-in by hand (decision 1a)', () => {
    it('refuses opening stock and a stock-in without a unit cost (was: booked at cost 0, so valued at 0)', async () => {
      const bookId = await newBook();
      for (const referenceType of [undefined, 'manual', 'initial_stock'] as const) {
        const res = await stockIn({ bookId, locationId: shelfA, quantity: 5, referenceType });
        expect({ referenceType, status: res.status, error: res.body.error }).toEqual({ referenceType, status: 400, error: 'VALIDATION_ERROR' });
      }
      const zero = await stockIn({ bookId, locationId: shelfA, quantity: 5, referenceType: 'initial_stock', unitCost: 0 });
      expect({ status: zero.status, error: zero.body.error }).toEqual({ status: 400, error: 'VALIDATION_ERROR' });
      expect(await row(bookId, shelfA)).toBeUndefined();
    });

    it('values opening stock at its unit cost, in the stock level, the history and the dashboard value', async () => {
      const bookId = await newBook();
      const res = await stockIn({ bookId, locationId: shelfA, quantity: 5, referenceType: 'initial_stock', unitCost: '12.50' });
      expect(res.status).toBe(200);
      expect(res.body.averageCost).toBe(12.5);
      expect(await row(bookId, shelfA)).toMatchObject({ quantity: 5, cost: '12.5000', value: '62.50' });
      expect(await lastMovement(bookId, shelfA)).toMatchObject({ reason_code: 'initial', unit_cost: '12.50' });
    });

    it('takes the book\'s latest known cost for a return named without one (was: 0)', async () => {
      const bookId = await newBook();
      expect((await stockIn({ bookId, locationId: shelfB, quantity: 3, unitCost: 8 })).status).toBe(200);
      const res = await stockIn({ bookId, locationId: shelfA, quantity: 2, referenceType: 'return' });
      expect(res.status).toBe(200);
      expect(await row(bookId, shelfA)).toMatchObject({ quantity: 2, cost: '8.0000', value: '16.00' });
      expect((await lastMovement(bookId, shelfA)).unit_cost).toBe('8.00');
    });

    it('leaves a return of a book with no known cost at 0, and its movement unvalued', async () => {
      const bookId = await newBook();
      expect((await stockIn({ bookId, locationId: shelfA, quantity: 2, referenceType: 'return' })).status).toBe(200);
      expect(await row(bookId, shelfA)).toMatchObject({ quantity: 2, cost: '0.0000', value: '0.00' });
      expect((await lastMovement(bookId, shelfA)).unit_cost).toBeNull();
    });
  });

  describe('stock arriving without a cost (decision 2a)', () => {
    const staff = () => ({ staffId: clerkId, role: 'Stock_Clerk', branchId });

    it('values stock coming back with no cost on an empty row at the latest known cost (cancelled order, void; was: 0)', async () => {
      const bookId = await newBook();
      expect((await stockIn({ bookId, locationId: shelfB, quantity: 1, unitCost: 15 })).status).toBe(200);
      await withTransaction({}, (tx) => inventoryService.receiveStock(tx, {
        bookId, locationId: shelfA, quantity: 3, referenceType: 'order_cancelled', reasonCode: 'return', staffCtx: staff(),
      }));
      expect(await row(bookId, shelfA)).toMatchObject({ quantity: 3, cost: '15.0000', value: '45.00' });
    });

    it('does not take a recorded cost of 0 as the book\'s cost (was: a sale out of unvalued stock made 0 its cost)', async () => {
      const bookId = await newBook();
      expect((await stockIn({ bookId, locationId: shelfB, quantity: 2, unitCost: 9 })).status).toBe(200);
      await unvalued(bookId, shelfA, 3);
      // Leaves at cost 0: the newest cost in the history is now 0.00.
      await withTransaction({}, (tx) => inventoryService.issueStock(tx, {
        bookId, locationId: shelfA, quantity: 1, reasonCode: 'sale', staffCtx: staff(),
      }));
      expect((await lastMovement(bookId, shelfA)).unit_cost).toBe('0.00');

      const { rows } = await db.query(`SELECT lc.unit_cost FROM (SELECT $1::int AS id) b ${costBasisLateralJoin('b.id')}`, [bookId]);
      expect(rows[0].unit_cost).toBe('9.00');
      await withTransaction({}, (tx) => inventoryService.receiveStock(tx, {
        bookId, locationId: shelfA, quantity: 1, referenceType: 'void', reasonCode: 'return', staffCtx: staff(),
      }));
      expect(await row(bookId, shelfA)).toMatchObject({ quantity: 3, cost: '9.0000', value: '27.00' });
    });

    it('values copies on hand at cost 0 at the cost of a priced arrival (was: averaged with 0, so 5 at 10 and 5 at 0 made 5.00)', async () => {
      const bookId = await newBook();
      await unvalued(bookId, shelfA, 5);
      expect((await stockIn({ bookId, locationId: shelfA, quantity: 5, unitCost: 10 })).status).toBe(200);
      expect(await row(bookId, shelfA)).toMatchObject({ quantity: 10, cost: '10.0000', value: '100.00' });
    });

    it('values copies on hand at cost 0 at the latest known cost on a correction upward (was: stayed 0)', async () => {
      const bookId = await newBook();
      expect((await stockIn({ bookId, locationId: shelfB, quantity: 1, unitCost: 7 })).status).toBe(200);
      await unvalued(bookId, shelfA, 2);
      const res = await as(api().post('/api/v1/inventory/adjust'), clerk)
        .send({ bookId, locationId: shelfA, delta: 1, reasonCode: 'correction', version: 0 });
      expect(res.status).toBe(200);
      expect(await row(bookId, shelfA)).toMatchObject({ quantity: 3, cost: '7.0000', value: '21.00' });
    });

    it('does not lower a destination\'s cost with copies transferred at cost 0 (was: 2 at 10 and 1 at 0 made 6.67)', async () => {
      const bookId = await newBook();
      expect((await stockIn({ bookId, locationId: shelfB, quantity: 2, unitCost: 10 })).status).toBe(200);
      await unvalued(bookId, shelfA, 3);
      const res = await as(api().post('/api/v1/inventory/transfer'), clerk)
        .send({ bookId, fromLocationId: shelfA, toLocationId: shelfB, quantity: 1, fromVersion: 0 });
      expect(res.status).toBe(200);
      expect(await row(bookId, shelfB)).toMatchObject({ quantity: 3, cost: '10.0000', value: '30.00' });
    });
  });

  describe('Set cost (decision 3a)', () => {
    it('gives stock at cost 0 a cost, with a reason, in the history and the audit log, without moving any copies', async () => {
      const bookId = await newBook();
      await unvalued(bookId, shelfA, 5);
      const res = await setCost(manager, { bookId, locationId: shelfA, unitCost: '11.25', reason: 'Counted opening stock, invoice 77', version: 0 });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ bookId, locationId: shelfA, quantity: 5, averageCost: 11.25, version: 1 });
      expect(await row(bookId, shelfA)).toMatchObject({ quantity: 5, cost: '11.2500', value: '56.25' });
      expect(await lastMovement(bookId, shelfA)).toEqual({
        delta: 0, reason_code: 'revaluation', movement_type: 'adjustment', unit_cost: '11.25', notes: 'Counted opening stock, invoice 77',
      });
      const audit = (await db.query(
        `SELECT entity_type, entity_id, meta FROM audit_logs WHERE entity_type = 'inventory_cost' AND entity_id = $1`,
        [`${bookId}:${shelfA}`],
      )).rows;
      expect(audit).toEqual([{
        entity_type: 'inventory_cost',
        entity_id: `${bookId}:${shelfA}`,
        meta: { bookId, locationId: shelfA, quantity: 5, averageCostBefore: '0.0000', averageCostAfter: '11.2500', reason: 'Counted opening stock, invoice 77' },
      }]);
    });

    it('is refused once the stock has a cost: the average then moves only with stock', async () => {
      const bookId = await newBook();
      expect((await stockIn({ bookId, locationId: shelfA, quantity: 2, unitCost: 4 })).status).toBe(200);
      const res = await setCost(manager, { bookId, locationId: shelfA, unitCost: 6, reason: 'Wrong cost', version: 1 });
      expect({ status: res.status, error: res.body.error }).toEqual({ status: 422, error: 'COST_ALREADY_SET' });
      expect((await row(bookId, shelfA)).cost).toBe('4.0000');
    });

    it('needs a reason, a cost above 0 and the current version', async () => {
      const bookId = await newBook();
      await unvalued(bookId, shelfA, 1);
      for (const body of [{ unitCost: 5, reason: ' ', version: 0 }, { unitCost: 0, reason: 'x', version: 0 }, { unitCost: 5, version: 0 }]) {
        const res = await setCost(manager, { bookId, locationId: shelfA, ...body });
        expect({ body, status: res.status, error: res.body.error }).toEqual({ body, status: 400, error: 'VALIDATION_ERROR' });
      }
      const stale = await setCost(manager, { bookId, locationId: shelfA, unitCost: 5, reason: 'x', version: 3 });
      expect({ status: stale.status, error: stale.body.error }).toEqual({ status: 409, error: 'VERSION_CONFLICT' });
      expect((await row(bookId, shelfA)).cost).toBe('0.0000');
    });

    it('is for Admin and Manager, in the session\'s branch', async () => {
      const bookId = await newBook();
      await unvalued(bookId, shelfA, 1);
      await unvalued(bookId, otherShelf, 1);
      expect((await setCost(clerk, { bookId, locationId: shelfA, unitCost: 5, reason: 'x', version: 0 })).status).toBe(403);
      const elsewhere = await setCost(manager, { bookId, locationId: otherShelf, unitCost: 5, reason: 'x', version: 0 });
      expect(elsewhere.status).toBeGreaterThanOrEqual(400);
      expect((await row(bookId, otherShelf)).cost).toBe('0.0000');
    });
  });

  describe('repair migration (decision 3a)', () => {
    it('values stock held at cost 0 at the book\'s latest known cost, audited, and leaves stock with no known cost at 0', async () => {
      const migration = createRequire(import.meta.url)('../db/migrations/1700000072_inventory_cost_repair.cjs') as {
        up: (pgm: { sql: (s: string) => void }) => void;
      };
      const known = await newBook();
      const unknown = await newBook();
      expect((await stockIn({ bookId: known, locationId: shelfB, quantity: 1, unitCost: 13 })).status).toBe(200);

      const client = await ownerDb().connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL app.tenant_id = '1'`);
        for (const bookId of [known, unknown]) {
          await client.query(`INSERT INTO inventory (book_id, location_id, quantity, average_cost) VALUES ($1, $2, 4, 0)`, [bookId, shelfA]);
        }
        const statements: string[] = [];
        migration.up({ sql: (s) => statements.push(s) });
        for (const s of statements) await client.query(s);

        const costs = (await client.query(
          `SELECT book_id, average_cost, inventory_value FROM inventory WHERE location_id = $1 AND book_id = ANY($2) ORDER BY book_id`,
          [shelfA, [known, unknown]],
        )).rows;
        expect(costs).toEqual([
          { book_id: known, average_cost: '13.0000', inventory_value: '52.00' },
          { book_id: unknown, average_cost: '0.0000', inventory_value: '0.00' },
        ]);
        const audit = (await client.query(
          `SELECT tenant_id, staff_id, entity_type, meta FROM audit_logs WHERE entity_type = 'inventory_cost' AND entity_id = ANY($1)`,
          [[`${known}:${shelfA}`, `${unknown}:${shelfA}`]],
        )).rows;
        expect(audit).toEqual([{
          tenant_id: 1,
          staff_id: null,
          entity_type: 'inventory_cost',
          meta: expect.objectContaining({ bookId: known, locationId: shelfA, quantity: 4, averageCostBefore: '0.0000', averageCostAfter: '13.0000' }),
        }]);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
  });

  describe('one valuation rule (decision 4a)', () => {
    it('values stock in the valuation export at its average cost, as the dashboard does (was: a fallback cost next to a value of 0)', async () => {
      const bookId = await newBook();
      expect((await stockIn({ bookId, locationId: shelfB, quantity: 1, unitCost: 12 })).status).toBe(200);
      await unvalued(bookId, shelfA, 5);
      const rows = (await getStockExportRows(branchId)).filter((r) => r.title === `${BOOK_PREFIX}${books}`);
      expect(rows.map((r) => ({ q: r.quantity_on_hand, cost: r.unit_cost, value: r.inventory_value })).sort((a, b) => a.q - b.q)).toEqual([
        { q: 1, cost: 12, value: 12 },
        { q: 5, cost: 0, value: 0 },
      ]);
    });

    it('shows each stock level\'s average cost', async () => {
      const bookId = await newBook();
      expect((await stockIn({ bookId, locationId: shelfA, quantity: 2, unitCost: '3.75' })).status).toBe(200);
      const res = await as(api().get('/api/v1/inventory'), clerk).query({ bookId, locationId: shelfA });
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([expect.objectContaining({ bookId, averageCost: 3.75 })]);
    });
  });
});
