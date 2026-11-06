// #242 (#225 S1, M2, M4, S11; owner decision 3a, 2026-11-04). A branch's
// first location is its default, and one created as the default becomes it
// (was: always stored as not the default). A cash session left open from an
// earlier day says so (was: no warning). Z- and DAY- numbers carry the day
// they count (was: the day they were closed). A return to the supplier takes
// only the copies there (was: drafted for copies already gone).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'stockmoney_';
const BRANCH_PREFIX = 'Stock Money ';
const SUPPLIER = 'STOCKMONEY';

describe('Stock and money minors (#242)', () => {
  let branchId: number;
  let shelf: number;
  let bookId: number;
  let supplierId: number;
  const t: Record<string, string> = {};
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  const as = (token: string, branch = () => branchId) => ({
    get: (path: string) => request(getTestApp()).get(path).set('Authorization', `Bearer ${token}`).set('X-Branch-Id', String(branch())),
    post: (path: string, body: object = {}) =>
      request(getTestApp()).post(path).set('Authorization', `Bearer ${token}`).set('X-Branch-Id', String(branch())).send(body),
  });
  const ok = async (res: request.Response, status = 200) => { expect(res.status, JSON.stringify(res.body)).toBe(status); return res.body; };
  const daysAgo = async (n: number) => (await one(`SELECT (CURRENT_DATE - $1::int)::text AS d`, [n])).d as string;
  const compact = (day: string) => day.replaceAll('-', '');

  async function cleanUp() {
    const branches = `SELECT id FROM branches WHERE name LIKE '${BRANCH_PREFIX}%'`;
    const pos = `SELECT id FROM purchase_orders WHERE supplier_id IN (SELECT id FROM suppliers WHERE name = '${SUPPLIER}')`;
    for (const statement of [
      `DELETE FROM supplier_return_lines WHERE return_id IN (SELECT id FROM supplier_returns WHERE po_id IN (${pos}))`,
      `DELETE FROM supplier_returns WHERE po_id IN (${pos})`,
      `DELETE FROM po_receipt_items WHERE receipt_id IN (SELECT id FROM po_receipts WHERE po_id IN (${pos}))`,
      `DELETE FROM po_receipts WHERE po_id IN (${pos})`,
      `DELETE FROM supplier_payments WHERE po_id IN (${pos})`,
      `DELETE FROM po_line_items WHERE po_id IN (${pos})`,
      `DELETE FROM purchase_orders WHERE id IN (${pos})`,
      `DELETE FROM suppliers WHERE name = '${SUPPLIER}'`,
      `DELETE FROM business_days WHERE branch_id IN (${branches})`,
      `DELETE FROM cash_session_movements WHERE session_id IN (SELECT id FROM cash_sessions WHERE branch_id IN (${branches}))`,
      `DELETE FROM cash_sessions WHERE branch_id IN (${branches})`,
      `DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
    ]) {
      await db.query(statement).catch((err: { code?: string }) => { if (err.code !== '42P01' && err.code !== '42703') throw err; });
    }
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    for (const [name, role] of [['sales', 'Sales'], ['manager', 'Manager'], ['purchasor', 'Purchasor'], ['clerk', 'Stock_Clerk'], ['admin', 'Admin']] as const) {
      t[name] = (await createTestStaff({ username: `${STAFF_PREFIX}${name}`, role, branchId })).token;
    }
    bookId = (await one(`SELECT id FROM books WHERE is_active = true ORDER BY id LIMIT 1`)).id;
    supplierId = (await one(`INSERT INTO suppliers (name, contact_info, lead_time_days, supplier_type) VALUES ($1, '{}', 7, 'external') RETURNING id`, [SUPPLIER])).id;
  });

  afterAll(cleanUp);

  describe('locations (S1)', () => {
    it("makes a branch's first location its default (was: none was)", async () => {
      const first = await ok(await as(t.admin).post(`/api/v1/branches/${branchId}/locations`, { name: 'Front shelf' }), 201);
      expect(first.isDefaultFulfillment).toBe(true);
      shelf = first.id;
      const second = await ok(await as(t.admin).post(`/api/v1/branches/${branchId}/locations`, { name: 'Back room' }), 201);
      expect(second.isDefaultFulfillment).toBe(false);
    });

    it('makes a location created as the default the default (was: stored as not the default)', async () => {
      const third = await ok(await as(t.admin).post(`/api/v1/branches/${branchId}/locations`, { name: 'Window', isDefaultFulfillment: true }), 201);
      expect(third.isDefaultFulfillment).toBe(true);
      const defaults = await db.query(`SELECT name FROM locations WHERE branch_id = $1 AND is_default_fulfillment`, [branchId]);
      expect(defaults.rows.map((r) => r.name)).toEqual(['Window']);
      // Back to the front shelf for the rest.
      await db.query(`UPDATE locations SET is_default_fulfillment = false WHERE branch_id = $1`, [branchId]);
      await db.query(`UPDATE locations SET is_default_fulfillment = true WHERE id = $1`, [shelf]);
    });
  });

  describe('a cash session left open overnight (M2, M4)', () => {
    let sessionId: number;
    let openedOn: string;

    beforeAll(async () => {
      sessionId = (await ok(await as(t.sales).post('/api/v1/cash-sessions', { openingFloat: 0 }), 201)).id;
      openedOn = await daysAgo(2);
      await db.query(`UPDATE cash_sessions SET opened_at = opened_at - INTERVAL '2 days' WHERE id = $1`, [sessionId]);
    });

    it('says it is from an earlier day (was: no warning)', async () => {
      const current = await ok(await as(t.sales).get('/api/v1/cash-sessions/current'));
      expect(current.session.id).toBe(sessionId);
      expect(current.fromEarlierDay).toBe(true);
    });

    it('is numbered by the day it was opened (was: the day it was closed)', async () => {
      const closed = await ok(await as(t.sales).post(`/api/v1/cash-sessions/${sessionId}/close`, { countedCash: 0 }));
      expect(closed.zNumber).toMatch(new RegExp(`^Z-${compact(openedOn)}-\\d{4}$`));
    });

    it('numbers a closed day by that day (was: the day it was closed)', async () => {
      const day = await daysAgo(2);
      const closed = await ok(await as(t.manager).post('/api/v1/business-days/close', { day }), 201);
      expect(closed.dayNumber).toMatch(new RegExp(`^DAY-${compact(day)}-\\d{4}$`));
    });
  });

  it('drafts a return to the supplier only for copies still there (S11; was: drafted, refused only when sent)', async () => {
    const po = await ok(await as(t.purchasor).post('/api/v1/purchase-orders', { supplierId, lineItems: [{ bookId, quantity: 2, unitCost: 5 }] }), 201);
    expect((await ok(await as(t.purchasor).post(`/api/v1/purchase-orders/${po.id}/submit`))).status).toBe('approved');
    const detail = await ok(await as(t.purchasor).get(`/api/v1/purchase-orders/${po.id}`));
    await ok(await as(t.clerk).post(`/api/v1/purchase-orders/${po.id}/receive`, { locationId: shelf, items: [{ poLineItemId: Number(detail.lineItems[0].id), quantityReceived: 2 }] }));
    // Both copies leave the shelf (sold, say).
    await db.query(`UPDATE inventory SET quantity = 0 WHERE book_id = $1 AND location_id = $2`, [bookId, shelf]);
    const line = { poLineItemId: Number(detail.lineItems[0].id), locationId: shelf, source: 'stock', quantity: 2 };
    const refused = await as(t.purchasor).post('/api/v1/supplier-returns', { poId: Number(po.id), notes: null, lines: [line] });
    expect([refused.status, refused.body.error]).toEqual([422, 'INSUFFICIENT_STOCK']);
    await db.query(`UPDATE inventory SET quantity = 1 WHERE book_id = $1 AND location_id = $2`, [bookId, shelf]);
    await ok(await as(t.purchasor).post('/api/v1/supplier-returns', { poId: Number(po.id), notes: null, lines: [{ ...line, quantity: 1 }] }), 201);
  });
});
