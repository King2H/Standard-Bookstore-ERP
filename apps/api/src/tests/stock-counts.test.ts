/**
 * stock-counts.test.ts
 *
 * #172 (owner decisions 1a–6a, 2026-10-30): a stocktake of one location,
 * the whole of it or chosen books, numbered CNT-; one open count per
 * location. Expected quantities are frozen when it opens and selling goes
 * on: each count is set against the stock when it was entered, so a sale
 * during the count is never a shortage. Admin, Manager and Stock_Clerk count,
 * blind; a book counted again replaces its count, the earlier kept. An Admin
 * or Manager reviews the differences and their value, sends books back for a
 * recount, posts (books never counted unchanged unless counted as 0) or
 * cancels with a reason. Posting writes one adjustment per difference at the
 * average cost, reason "count", linked to the count, audited. Before, stock
 * was corrected one book at a time with no record of what was found.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import type { StockCountLine } from '@bms/shared';
import { db } from '../db/index.js';
import { handleNotification, NOTIFICATION_EVENTS } from '../workers/notificationWorker.js';
import { HANDLERS } from '../workers/outboxPoller.js';

const STAFF_PREFIX = 'cnt_test_';
const BRANCH_PREFIX = 'Stock Counts ';

describe('Stock counts (#172)', () => {
  let branchA: number;
  let shelf: number;
  let back: number;
  let shelfB: number;
  let books: number[];
  const t: Record<string, string> = {};
  const id: Record<string, number> = {};
  const api = () => request(getTestApp());
  const as = (token: string) => ({
    get: (path: string) => api().get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) => api().post(path).set('Authorization', `Bearer ${token}`).send(body),
  });
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  const qty = async (book: number, location = shelf) =>
    Number((await one(`SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`, [book, location]))?.quantity ?? 0);
  const open = (token: string, body: object) => as(token).post('/api/v1/stock-counts', body);
  const count = (token: string, countId: number, items: Array<{ bookId: number; quantity: number }>) =>
    as(token).post(`/api/v1/stock-counts/${countId}/counts`, { items });
  const step = (token: string, countId: number, name: string, body: object = {}) => as(token).post(`/api/v1/stock-counts/${countId}/${name}`, body);
  const line = (body: { lines: StockCountLine[] }, book: number) => body.lines.find((l) => l.bookId === book)!;
  async function sellOne(book: number) {
    const level = await one(`SELECT version FROM inventory WHERE book_id = $1 AND location_id = $2`, [book, shelf]);
    const res = await as(t.clerk).post('/api/v1/inventory/stock-out', { bookId: book, locationId: shelf, quantity: 1, version: level.version });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }

  async function cleanUp() {
    const branches = `SELECT id FROM branches WHERE name LIKE '${BRANCH_PREFIX}%'`;
    const counts = `SELECT id FROM stock_counts WHERE branch_id IN (${branches})`;
    for (const statement of [
      `DELETE FROM notifications WHERE branch_id IN (${branches})`,
      `DELETE FROM stock_count_entries WHERE line_id IN (SELECT id FROM stock_count_lines WHERE count_id IN (${counts}))`,
      `DELETE FROM stock_count_lines WHERE count_id IN (${counts})`,
      `DELETE FROM stock_counts WHERE id IN (${counts})`,
      `DELETE FROM staff_locations WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
    ]) {
      await db.query(statement).catch((err: { code?: string }) => {
        // Before the migration the count tables do not exist yet.
        if (err.code !== '42P01') throw err;
      });
    }
    await cleanTestBranches(BRANCH_PREFIX);
    await cleanTestStaff(STAFF_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    branchA = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    const branchB = (await createTestBranch({ name: `${BRANCH_PREFIX}B` })).branchId;
    for (const [name, role, branch] of [
      ['clerk', 'Stock_Clerk', branchA], ['manager', 'Manager', branchA], ['sales', 'Sales', branchA],
      ['purchasor', 'Purchasor', branchA], ['managerB', 'Manager', branchB], ['limited', 'Stock_Clerk', branchA],
    ] as const) {
      const s = await createTestStaff({ username: `${STAFF_PREFIX}${name}`, role, branchId: branch });
      t[name] = s.token;
      id[name] = s.staffId;
    }
    const loc = async (branch: number, name: string, isDefault: boolean) =>
      (await one(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, $2, $3) RETURNING id`, [branch, name, isDefault])).id as number;
    shelf = await loc(branchA, 'Count shelf', true);
    back = await loc(branchA, 'Count back room', false);
    shelfB = await loc(branchB, 'Count B shelf', true);
    await db.query(`INSERT INTO staff_locations (staff_id, location_id) VALUES ($1, $2)`, [id.limited, back]);
    books = (await db.query(`SELECT id FROM books WHERE is_active = true ORDER BY id LIMIT 4`)).rows.map((r) => r.id as number);
    // The shelf: 10 at 6.00, 5 at 4.00, 3 at 2.00; nothing of the fourth.
    for (const [book, quantity, cost] of [[books[0], 10, 6], [books[1], 5, 4], [books[2], 3, 2]]) {
      await db.query(`INSERT INTO inventory (book_id, location_id, quantity, average_cost) VALUES ($1, $2, $3, $4)`, [book, shelf, quantity, cost]);
    }
  });

  afterAll(cleanUp);

  describe('opening (1a)', () => {
    it('opens a full count of a location with every book it holds, numbered CNT-, expected frozen', async () => {
      const res = await open(t.manager, { locationId: shelf, scope: 'full', notes: 'Month end' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      id.full = res.body.id;
      expect(res.body.countNumber).toMatch(/^CNT-\d{8}-\d{4}$/);
      expect(res.body).toMatchObject({ status: 'counting', scope: 'full', locationId: shelf, notes: 'Month end', lineCount: 3, countedLines: 0 });
      expect(line(res.body, books[0])).toMatchObject({ frozenQuantity: 10, countedQuantity: null, difference: null });
    });

    it('is one open count per location, of a location one may use, by Admin, Manager or Stock_Clerk', async () => {
      const again = await open(t.clerk, { locationId: shelf, scope: 'selected', bookIds: [books[0]] });
      expect(again.status).toBe(409);
      expect(again.body.error).toBe('STOCK_COUNT_OPEN');
      expect((await open(t.sales, { locationId: back, scope: 'full' })).status).toBe(403);
      expect((await open(t.purchasor, { locationId: back, scope: 'full' })).status).toBe(403);
      expect((await open(t.limited, { locationId: shelf, scope: 'full' })).status).toBe(403);
      expect((await open(t.manager, { locationId: shelfB, scope: 'full' })).status).toBe(403);
      expect((await open(t.manager, { locationId: back, scope: 'selected' })).status).toBe(400);
    });

    it('opens a count of chosen books, including one the location does not hold', async () => {
      const res = await open(t.limited, { locationId: back, scope: 'selected', bookIds: [books[0], books[3]] });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      id.selected = res.body.id;
      expect(res.body.lines.map((l: { bookId: number }) => l.bookId).sort()).toEqual([books[0], books[3]].sort());
    });
  });

  describe('counting (2a, 3a)', () => {
    it('is blind for a counter: no frozen or expected quantity, no difference', async () => {
      const res = await as(t.clerk).get(`/api/v1/stock-counts/${id.full}`);
      expect(res.status).toBe(200);
      expect(line(res.body, books[0])).toMatchObject({ frozenQuantity: null, expectedQuantity: null, difference: null, differenceValue: null });
      expect(res.body.totals).toBeNull();
      // The reviewer sees them.
      expect(line((await as(t.manager).get(`/api/v1/stock-counts/${id.full}`)).body, books[0])).toMatchObject({ frozenQuantity: 10 });
    });

    it('sets each count against the stock when it was entered, so a sale during the count is no shortage', async () => {
      await sellOne(books[0]); // 10 → 9 before it is counted
      const res = await count(t.clerk, id.full, [{ bookId: books[0], quantity: 9 }, { bookId: books[1], quantity: 4 }]);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await sellOne(books[0]); // 9 → 8 after it was counted
      const review = (await as(t.manager).get(`/api/v1/stock-counts/${id.full}`)).body;
      expect(line(review, books[0])).toMatchObject({ frozenQuantity: 10, expectedQuantity: 9, countedQuantity: 9, difference: 0 });
      expect(line(review, books[1])).toMatchObject({ expectedQuantity: 5, countedQuantity: 4, difference: -1, differenceValue: -4 });
    });

    it('replaces a count when counted again, keeping the earlier, and adds a book found', async () => {
      const res = await count(t.clerk, id.full, [{ bookId: books[1], quantity: 3 }, { bookId: books[3], quantity: 2 }]);
      expect(res.status).toBe(200);
      const review = (await as(t.manager).get(`/api/v1/stock-counts/${id.full}`)).body;
      expect(line(review, books[1])).toMatchObject({ countedQuantity: 3, previousCounts: [4], difference: -2 });
      expect(line(review, books[3])).toMatchObject({ frozenQuantity: 0, expectedQuantity: 0, countedQuantity: 2, difference: 2 });
      expect(review).toMatchObject({ lineCount: 4, countedLines: 3 });
    });

    it('refuses a negative count, and counting by a Sales person', async () => {
      expect((await count(t.clerk, id.full, [{ bookId: books[0], quantity: -1 }])).status).toBe(400);
      expect((await count(t.sales, id.full, [{ bookId: books[0], quantity: 1 }])).status).toBe(403);
    });
  });

  describe('review (4a)', () => {
    it('is submitted by a counter; the reviewers are told', async () => {
      const res = await step(t.clerk, id.full, 'submit');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.status).toBe('submitted');
      expect((await count(t.clerk, id.full, [{ bookId: books[2], quantity: 3 }])).body.error).toBe('STOCK_COUNT_INVALID_STATUS');
      const event = await one(`SELECT payload FROM outbox WHERE event_type = 'stock_count.submitted' AND payload->>'countId' = $1`, [String(id.full)]);
      expect(event.payload).toMatchObject({ branchId: branchA, countNumber: res.body.countNumber });
      await handleNotification({ ...event.payload, _eventType: 'stock_count.submitted' });
      const note = await one(`SELECT target_roles, entity_type FROM notifications WHERE event_type = 'stock_count.submitted' AND entity_id = $1`, [String(id.full)]);
      expect(note).toEqual({ target_roles: ['Manager', 'Admin'], entity_type: 'stock_count' });
      expect(NOTIFICATION_EVENTS).toContain('stock_count.submitted');
      expect(HANDLERS['stock_count.submitted']).toBe(handleNotification);
    });

    it('shows the differences and their value; the reviewer sends a book back for a recount', async () => {
      const review = (await as(t.manager).get(`/api/v1/stock-counts/${id.full}`)).body;
      // book 1 short 2 at 4.00; book 4 over 2 at 0 (never held, no cost).
      expect(review.totals).toEqual({ overQuantity: 2, shortQuantity: 2, overValue: 0, shortValue: 8 });
      expect((await step(t.clerk, id.full, 'recount', { bookIds: [books[1]] })).status).toBe(403);
      const res = await step(t.manager, id.full, 'recount', { bookIds: [books[1]] });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('counting');
      expect(line(res.body, books[1]).recountRequested).toBe(true);
      const recounted = await count(t.clerk, id.full, [{ bookId: books[1], quantity: 5 }]);
      expect(line(recounted.body, books[1]).recountRequested).toBe(false);
      expect((await step(t.clerk, id.full, 'submit')).status).toBe(200);
    });

    it('is posted by an Admin or Manager: one adjustment per difference at the average cost, linked and audited', async () => {
      expect((await step(t.clerk, id.full, 'post')).status).toBe(403);
      const res = await step(t.manager, id.full, 'post', { zeroBookIds: [books[2]] });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.status).toBe('posted');
      // book 1: counted 9 against 9, later sold to 8, no change. book 2: recounted 5 against 5, none.
      // book 3: never counted, counted as 0: 3 short. book 4: 2 found.
      expect(await qty(books[0])).toBe(8);
      expect(await qty(books[1])).toBe(5);
      expect(await qty(books[2])).toBe(0);
      expect(await qty(books[3])).toBe(2);
      const history = (await db.query(
        `SELECT book_id, delta, reason_code, movement_type, unit_cost FROM inventory_history WHERE reference_type = 'stock_count' AND reference_id = $1 ORDER BY book_id`,
        [id.full],
      )).rows;
      expect(history).toEqual([
        { book_id: books[2], delta: -3, reason_code: 'count', movement_type: 'adjustment', unit_cost: '2.00' },
        { book_id: books[3], delta: 2, reason_code: 'count', movement_type: 'adjustment', unit_cost: '0.00' },
      ].sort((a, b) => a.book_id - b.book_id));
      expect(line(res.body, books[2])).toMatchObject({ countedQuantity: 0, postedDelta: -3, postedUnitCost: 2 });
      const audit = (await db.query(`SELECT meta->>'action' AS action FROM audit_logs WHERE entity_type = 'stock_count' AND entity_id = $1 ORDER BY id`, [String(id.full)])).rows;
      expect(audit.map((r) => r.action)).toEqual(['open', 'count', 'count', 'submit', 'recount', 'count', 'submit', 'post']);
      expect((await step(t.manager, id.full, 'post')).body.error).toBe('STOCK_COUNT_INVALID_STATUS');
    });

    it('is cancelled with a reason, changing nothing; another count of the location may then open', async () => {
      expect((await step(t.manager, id.selected, 'cancel', {})).status).toBe(400);
      const res = await step(t.manager, id.selected, 'cancel', { reason: 'Started on the wrong shelf' });
      expect(res.body).toMatchObject({ status: 'cancelled', cancelReason: 'Started on the wrong shelf' });
      expect((await open(t.manager, { locationId: back, scope: 'full' })).status).toBe(201);
    });
  });

  describe('scope', () => {
    it('lists the branch\'s counts, and keeps them from another branch', async () => {
      const list = await as(t.clerk).get('/api/v1/stock-counts?status=posted');
      expect(list.status).toBe(200);
      expect(list.body.items.map((c: { id: number }) => c.id)).toEqual([id.full]);
      expect((await as(t.managerB).get('/api/v1/stock-counts')).body.items).toEqual([]);
      expect((await as(t.managerB).get(`/api/v1/stock-counts/${id.full}`)).status).toBe(404);
    });
  });
});
