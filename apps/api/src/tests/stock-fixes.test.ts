// #238 (#225 S14, S12, S7, S3, S10; owner decisions 1a–4a, 2026-11-04).
// A copy damaged on the shelf goes to damaged stock at its cost, to be
// repaired, written off or sent back (was: taken out as a loss at once).
// Adjust no longer takes customer returns: they go through Returns, with
// their refund. Goods received on a purchase order are recorded as a purchase
// (was: "initial", like opening stock). Purchase orders and goods receipts are
// numbered in a counted series like every other document (was: the row id).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'stockfix_';
const BRANCH_PREFIX = 'Stock Fixes ';
const SUPPLIER = 'STOCKFIX';
const PO_SERIES = /^PO-\d{8}-\d{4}$/;
const GRN_SERIES = /^GRN-\d{8}-\d{4}$/;

describe('Stock fixes (#238)', () => {
  let branchId: number;
  let shelf: number;
  let bookId: number;
  let supplierId: number;
  const t: Record<string, string> = {};
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  const as = (token: string) => ({
    get: (path: string) => request(getTestApp()).get(path).set('Authorization', `Bearer ${token}`).set('X-Branch-Id', String(branchId)),
    post: (path: string, body: object = {}) =>
      request(getTestApp()).post(path).set('Authorization', `Bearer ${token}`).set('X-Branch-Id', String(branchId)).send(body),
  });
  const ok = async (res: request.Response, status = 200) => { expect(res.status, JSON.stringify(res.body)).toBe(status); return res.body; };
  const level = () => one(`SELECT quantity, average_cost, damaged_quantity, damaged_value, version FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, shelf]);
  const lastMovement = () => one(`SELECT reason_code, movement_type, qty_before, qty_after, unit_cost FROM inventory_history WHERE book_id = $1 AND location_id = $2 ORDER BY id DESC LIMIT 1`, [bookId, shelf]);
  const adjust = async (delta: number, reasonCode: string) =>
    as(t.clerk).post('/api/v1/inventory/adjust', { bookId, locationId: shelf, delta, reasonCode, notes: 'Shelf check', version: (await level()).version });

  async function newPo(): Promise<{ id: string; poNumber: string }> {
    const po = await ok(await as(t.purchasor).post('/api/v1/purchase-orders', { supplierId, lineItems: [{ bookId, quantity: 4, unitCost: 6 }] }), 201);
    expect((await ok(await as(t.purchasor).post(`/api/v1/purchase-orders/${po.id}/submit`))).status).toBe('approved');
    return po;
  }

  async function cleanUp() {
    const branches = `SELECT id FROM branches WHERE name LIKE '${BRANCH_PREFIX}%'`;
    const pos = `SELECT id FROM purchase_orders WHERE supplier_id IN (SELECT id FROM suppliers WHERE name = '${SUPPLIER}')`;
    for (const statement of [
      `DELETE FROM po_receipt_items WHERE receipt_id IN (SELECT id FROM po_receipts WHERE po_id IN (${pos}))`,
      `DELETE FROM po_receipts WHERE po_id IN (${pos})`,
      `DELETE FROM po_line_items WHERE po_id IN (${pos})`,
      `DELETE FROM purchase_orders WHERE id IN (${pos})`,
      `DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM suppliers WHERE name = '${SUPPLIER}'`,
    ]) {
      await db.query(statement).catch((err: { code?: string }) => { if (err.code !== '42P01') throw err; });
    }
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    shelf = (await one(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Fixes shelf', true) RETURNING id`, [branchId])).id;
    for (const [name, role] of [['clerk', 'Stock_Clerk'], ['purchasor', 'Purchasor'], ['manager', 'Manager']] as const) {
      t[name] = (await createTestStaff({ username: `${STAFF_PREFIX}${name}`, role, branchId })).token;
    }
    bookId = (await one(`SELECT id FROM books WHERE is_active = true ORDER BY id LIMIT 1`)).id;
    await db.query(`INSERT INTO inventory (book_id, location_id, quantity, average_cost) VALUES ($1, $2, 10, 4)`, [bookId, shelf]);
    supplierId = (await one(`INSERT INTO suppliers (name, contact_info, lead_time_days, supplier_type) VALUES ($1, '{}', 7, 'external') RETURNING id`, [SUPPLIER])).id;
  });

  afterAll(cleanUp);

  describe('a copy damaged on the shelf (S14, 1a)', () => {
    it('goes to damaged stock at its cost, the stock value with it (was: out of stock as a loss)', async () => {
      await ok(await adjust(-2, 'damage'));
      const after = await level();
      expect({ quantity: after.quantity, damaged: after.damaged_quantity, damagedValue: after.damaged_value }).toEqual({ quantity: 8, damaged: 2, damagedValue: '8.00' });
      expect(await lastMovement()).toMatchObject({ reason_code: 'damage', movement_type: 'adjustment', qty_before: 10, qty_after: 8 });
    });

    it('is then written off, repaired or sent back like any damaged copy', async () => {
      await ok(await as(t.clerk).post('/api/v1/inventory/damaged/repair', { bookId, locationId: shelf, quantity: 1, reason: 'Cover reglued', version: (await level()).version }));
      await ok(await as(t.clerk).post('/api/v1/inventory/damaged/write-off', { bookId, locationId: shelf, quantity: 1, reason: 'Water damage', version: (await level()).version }));
      expect(await level()).toMatchObject({ quantity: 9, damaged_quantity: 0, damaged_value: '0.00' });
    });

    it('is refused when more copies are damaged than are on hand', async () => {
      const res = await adjust(-50, 'damage');
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect((await level()).damaged_quantity).toBe(0);
    });
  });

  it('takes no customer return through Adjust: Returns does, with its refund (S12, 2a)', async () => {
    const res = await adjust(1, 'return');
    expect([res.status, res.body.error]).toEqual([400, 'VALIDATION_ERROR']);
  });

  describe('purchase orders and goods receipts (S7 3a, S3 and S10 4a)', () => {
    it('numbers purchase orders in a counted series (was: the row id, PO-000003)', async () => {
      const first = await newPo();
      const second = await newPo();
      expect(first.poNumber).toMatch(PO_SERIES);
      expect(Number(second.poNumber.slice(-4))).toBe(Number(first.poNumber.slice(-4)) + 1);
      const listed = (await ok(await as(t.purchasor).get(`/api/v1/purchase-orders/${first.id}`))).poNumber;
      expect(listed).toBe(first.poNumber);
    });

    it('records goods received as a purchase, numbered GRN- in a counted series (was: "initial", GRN-<row id>)', async () => {
      const po = await newPo();
      const detail = await ok(await as(t.purchasor).get(`/api/v1/purchase-orders/${po.id}`));
      await ok(await as(t.clerk).post(`/api/v1/purchase-orders/${po.id}/receive`, {
        locationId: shelf, items: [{ poLineItemId: Number(detail.lineItems[0].id), quantityReceived: 4 }],
      }));
      expect(await lastMovement()).toMatchObject({ reason_code: 'purchase', movement_type: 'stock_in' });
      const received = await ok(await as(t.purchasor).get(`/api/v1/purchase-orders/${po.id}`));
      const grn = received.receipts[0].receiptNumber as string;
      expect(grn).toMatch(GRN_SERIES);
      const ledger = await ok(await as(t.manager).get(`/api/v1/suppliers/${supplierId}/ledger`));
      expect(ledger.entries.map((e: { reference: string }) => e.reference)).toContain(`${po.poNumber} / ${grn}`);
    });

    it('keeps an existing order the number printed on it', async () => {
      const id = (await one(
        `INSERT INTO purchase_orders (branch_id, supplier_id, created_by, currency, po_number)
         VALUES ($1, $2, (SELECT MIN(id) FROM staff), 'ETB', 'PO-000777') RETURNING id`, [branchId, supplierId],
      )).id;
      expect((await ok(await as(t.purchasor).get(`/api/v1/purchase-orders/${id}`))).poNumber).toBe('PO-000777');
    });
  });
});
