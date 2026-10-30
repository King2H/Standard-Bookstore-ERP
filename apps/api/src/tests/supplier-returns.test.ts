/**
 * supplier-returns.test.ts
 *
 * #173 (owner decisions 1a–6a, 2026-10-30): books going back to a supplier
 * against a purchase order, numbered RTS-. A return names lines of the
 * order, up to what arrived less what already went back, each taken from a
 * location of the receiving branch, from stock for sale or from damaged
 * copies. Admin, Manager and Purchasor of the receiving branch draft it;
 * Admin and Manager send it after a confirmation. Sending takes the copies
 * out at their cost, linked to the return, and creates a credit note at the
 * order's price; what it credits beyond what the order still owes is a
 * refund due from the supplier, recorded when the money arrives. Before,
 * a credit note moved no stock and nothing sent books back.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'rts_test_';
const BRANCH_PREFIX = 'Supplier Returns ';
const SUPPLIER_PREFIX = 'Supplier Returns Supplier';

interface Po {
  id: string;
  outstandingAmount: number;
  refundDue: number;
  refundsTotal: number;
  lineItems: Array<{ id: string; bookId: number; receivedQuantity: number; returnedQuantity: number }>;
  creditNotes: Array<{ id: string; creditNoteNumber: string; amount: number; reason: string }>;
  supplierRefunds: Array<{ refundNumber: string; amount: number; method: string; reference: string | null }>;
}

describe('Returns to supplier (#173)', () => {
  let branchA: number;
  let branchB: number;
  let shelf: number;
  let back: number;
  let shelfB: number;
  let supplierId: number;
  let books: number[];
  const t: Record<string, string> = {};
  const api = () => request(getTestApp());
  const as = (token: string) => ({
    get: (path: string) => api().get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) => api().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object = {}) => api().put(path).set('Authorization', `Bearer ${token}`).send(body),
  });
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  const level = async (book: number, location = shelf) =>
    one(`SELECT quantity, average_cost::float AS cost, damaged_quantity AS damaged, damaged_value::float AS "damagedValue"
         FROM inventory WHERE book_id = $1 AND location_id = $2`, [book, location]);
  const po = async (poId: string): Promise<Po> => (await as(t.manager).get(`/api/v1/purchase-orders/${poId}`)).body;
  const draft = (token: string, body: object) => as(token).post('/api/v1/supplier-returns', body);
  const send = (token: string, returnId: number) => as(token).post(`/api/v1/supplier-returns/${returnId}/send`);
  const refund = (poId: string, body: object, token = t.finance) => as(token).post(`/api/v1/purchase-orders/${poId}/supplier-refunds`, body);

  /** An order of 10 of the first book at 10.00 and 5 of the second at 4.00 (120.00), received in full on the shelf. */
  async function receivedOrder(): Promise<Po> {
    const created = await as(t.purchasor).post('/api/v1/purchase-orders', {
      supplierId, lineItems: [{ bookId: books[0], quantity: 10, unitCost: 10 }, { bookId: books[1], quantity: 5, unitCost: 4 }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await as(t.purchasor).post(`/api/v1/purchase-orders/${created.body.id}/submit`)).body.status).toBe('approved');
    const lines = created.body.lineItems as Po['lineItems'];
    const received = await as(t.clerk).post(`/api/v1/purchase-orders/${created.body.id}/receive`, {
      locationId: shelf, items: lines.map((l, i) => ({ poLineItemId: Number(l.id), quantityReceived: i === 0 ? 10 : 5 })),
    });
    expect(received.status, JSON.stringify(received.body)).toBe(200);
    return po(created.body.id);
  }
  const lineOf = (order: Po, book: number) => Number(order.lineItems.find((l) => l.bookId === book)!.id);

  async function cleanUp() {
    const pos = `SELECT id FROM purchase_orders WHERE supplier_id IN (SELECT id FROM suppliers WHERE name LIKE '${SUPPLIER_PREFIX}%')`;
    const branches = `SELECT id FROM branches WHERE name LIKE '${BRANCH_PREFIX}%'`;
    for (const statement of [
      `DELETE FROM supplier_return_lines WHERE return_id IN (SELECT id FROM supplier_returns WHERE po_id IN (${pos}))`,
      `DELETE FROM supplier_returns WHERE po_id IN (${pos})`,
      `DELETE FROM supplier_refunds WHERE po_id IN (${pos})`,
      `DELETE FROM po_receipt_items WHERE receipt_id IN (SELECT id FROM po_receipts WHERE po_id IN (${pos}))`,
      `DELETE FROM po_receipts WHERE po_id IN (${pos})`,
      `DELETE FROM supplier_payments WHERE po_id IN (${pos})`,
      `DELETE FROM supplier_credit_notes WHERE po_id IN (${pos})`,
      `DELETE FROM po_line_items WHERE po_id IN (${pos})`,
      `DELETE FROM purchase_orders WHERE id IN (${pos})`,
      `DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM suppliers WHERE name LIKE '${SUPPLIER_PREFIX}%'`,
    ]) {
      await db.query(statement).catch((err: { code?: string }) => {
        // Before the migration the return tables do not exist yet.
        if (err.code !== '42P01') throw err;
      });
    }
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    branchA = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    branchB = (await createTestBranch({ name: `${BRANCH_PREFIX}B` })).branchId;
    const loc = async (branch: number, name: string, isDefault: boolean) =>
      (await one(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, $2, $3) RETURNING id`, [branch, name, isDefault])).id as number;
    shelf = await loc(branchA, 'RTS shelf', true);
    back = await loc(branchA, 'RTS back room', false);
    shelfB = await loc(branchB, 'RTS B shelf', true);
    for (const [name, role, branch] of [
      ['purchasor', 'Purchasor', branchA], ['manager', 'Manager', branchA], ['clerk', 'Stock_Clerk', branchA],
      ['sales', 'Sales', branchA], ['finance', 'Finance_Officer', branchA], ['managerB', 'Manager', branchB],
    ] as const) {
      t[name] = (await createTestStaff({ username: `${STAFF_PREFIX}${name}`, role, branchId: branch })).token;
    }
    supplierId = (await one(
      `INSERT INTO suppliers (name, contact_info, lead_time_days, supplier_type) VALUES ($1, '{}', 7, 'external') RETURNING id`,
      [SUPPLIER_PREFIX],
    )).id;
    books = (await db.query(`SELECT id FROM books WHERE is_active = true ORDER BY id LIMIT 2`)).rows.map((r) => r.id as number);
  });

  afterAll(cleanUp);

  describe('drafting (1a, 5a)', () => {
    let order: Po;
    beforeAll(async () => { order = await receivedOrder(); });

    it('drafts a return of an order\'s lines, numbered RTS-, at the order\'s price; no stock moves yet (was: no return at all)', async () => {
      const res = await draft(t.purchasor, {
        poId: order.id, notes: 'Wrong edition', lines: [{ poLineItemId: lineOf(order, books[0]), locationId: shelf, source: 'stock', quantity: 2 }],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.returnNumber).toMatch(/^RTS-\d{8}-\d{4}$/);
      expect(res.body).toMatchObject({
        status: 'draft', poId: order.id, supplierId, branchId: branchA, notes: 'Wrong edition', creditValue: 20, costValue: null, creditNoteNumber: null,
      });
      expect(res.body.lines).toEqual([expect.objectContaining({ bookId: books[0], locationId: shelf, source: 'stock', quantity: 2, unitCredit: 10, creditValue: 20 })]);
      expect((await level(books[0])).quantity).toBe(10);
    });

    it('refuses more than arrived less what already went back', async () => {
      const res = await draft(t.purchasor, { poId: order.id, lines: [{ poLineItemId: lineOf(order, books[1]), locationId: shelf, source: 'stock', quantity: 6 }] });
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('RETURN_EXCEEDS_RECEIVED');
    });

    it('refuses an order with nothing received, a line of another order, and a location of another branch', async () => {
      const other = await as(t.purchasor).post('/api/v1/purchase-orders', { supplierId, lineItems: [{ bookId: books[0], quantity: 1, unitCost: 10 }] });
      const notReceived = await draft(t.purchasor, { poId: other.body.id, lines: [{ poLineItemId: Number(other.body.lineItems[0].id), locationId: shelf, source: 'stock', quantity: 1 }] });
      expect(notReceived.status).toBe(422);
      expect(notReceived.body.error).toBe('RETURN_EXCEEDS_RECEIVED');
      const foreignLine = await draft(t.purchasor, { poId: order.id, lines: [{ poLineItemId: Number(other.body.lineItems[0].id), locationId: shelf, source: 'stock', quantity: 1 }] });
      expect(foreignLine.status).toBe(404);
      const foreignLocation = await draft(t.purchasor, { poId: order.id, lines: [{ poLineItemId: lineOf(order, books[0]), locationId: shelfB, source: 'stock', quantity: 1 }] });
      expect(foreignLocation.status).toBe(403);
      expect(foreignLocation.body.error).toBe('BRANCH_ACCESS_DENIED');
    });

    it('is drafted by Admin, Manager and Purchasor of the receiving branch only (5a)', async () => {
      const body = { poId: order.id, lines: [{ poLineItemId: lineOf(order, books[0]), locationId: shelf, source: 'stock', quantity: 1 }] };
      expect((await draft(t.clerk, body)).status).toBe(403);
      expect((await draft(t.sales, body)).status).toBe(403);
      expect((await draft(t.managerB, body)).status).toBe(403);
    });

    it('edits and cancels a draft with a reason; another branch neither reads nor changes it', async () => {
      const created = await draft(t.purchasor, { poId: order.id, lines: [{ poLineItemId: lineOf(order, books[0]), locationId: shelf, source: 'stock', quantity: 1 }] });
      const rts = created.body.id as number;
      const edited = await as(t.purchasor).put(`/api/v1/supplier-returns/${rts}`, {
        notes: 'Two', lines: [{ poLineItemId: lineOf(order, books[1]), locationId: back, source: 'stock', quantity: 2 }],
      });
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      expect(edited.body).toMatchObject({ notes: 'Two', creditValue: 8 });
      expect(edited.body.lines).toEqual([expect.objectContaining({ bookId: books[1], locationId: back, quantity: 2 })]);
      expect((await as(t.managerB).get(`/api/v1/supplier-returns/${rts}`)).status).toBe(404);
      expect((await as(t.managerB).post(`/api/v1/supplier-returns/${rts}/cancel`, { reason: 'x' })).status).toBe(404);
      expect((await as(t.purchasor).post(`/api/v1/supplier-returns/${rts}/cancel`, {})).status).toBe(400);
      const cancelled = await as(t.purchasor).post(`/api/v1/supplier-returns/${rts}/cancel`, { reason: 'Supplier will replace them' });
      expect(cancelled.status).toBe(200);
      expect(cancelled.body).toMatchObject({ status: 'cancelled', cancelReason: 'Supplier will replace them' });
      const again = await as(t.purchasor).put(`/api/v1/supplier-returns/${rts}`, { lines: [{ poLineItemId: lineOf(order, books[1]), locationId: shelf, source: 'stock', quantity: 1 }] });
      expect(again.status).toBe(422);
      expect(again.body.error).toBe('SUPPLIER_RETURN_INVALID_STATUS');
    });

    it('lists the branch\'s returns by order and status', async () => {
      const res = await as(t.purchasor).get(`/api/v1/supplier-returns?poId=${order.id}&status=draft`);
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBe(1);
      expect(res.body.items[0]).toMatchObject({ status: 'draft', poId: order.id, supplierName: SUPPLIER_PREFIX, lineCount: 1, totalQuantity: 2 });
      expect((await as(t.managerB).get(`/api/v1/supplier-returns?poId=${order.id}`)).body.items).toEqual([]);
    });
  });

  describe('sending (2a, 3a)', () => {
    let order: Po;
    let rts: number;
    beforeAll(async () => {
      order = await receivedOrder();
      // The shelf holds both orders' copies (20 of the first book), now at 9.00 on average; 2 of the second book are damaged, worth 6.00.
      await db.query(`UPDATE inventory SET average_cost = 9 WHERE book_id = $1 AND location_id = $2`, [books[0], shelf]);
      await db.query(`UPDATE inventory SET damaged_quantity = 2, damaged_value = 6 WHERE book_id = $1 AND location_id = $2`, [books[1], shelf]);
      rts = (await draft(t.purchasor, {
        poId: order.id,
        lines: [
          { poLineItemId: lineOf(order, books[0]), locationId: shelf, source: 'stock', quantity: 2 },
          { poLineItemId: lineOf(order, books[1]), locationId: shelf, source: 'damaged', quantity: 1 },
        ],
      })).body.id;
    });

    it('is sent by Admin and Manager only (5a)', async () => {
      expect((await send(t.purchasor, rts)).status).toBe(403);
      expect((await send(t.clerk, rts)).status).toBe(403);
    });

    it('takes the copies out at their cost and credits the order at its price, the difference a gain or loss (3a)', async () => {
      const before = await one(`SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`, [books[1], shelf]);
      const res = await send(t.manager, rts);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      // 2 × 9.00 from stock and 1 of the damaged at 3.00; credit 2 × 10.00 + 1 × 4.00.
      expect(res.body).toMatchObject({ status: 'sent', creditValue: 24, costValue: 21, gainLoss: 3 });
      expect(res.body.creditNoteNumber).toMatch(/^SCN-\d{8}-\d{4}$/);
      expect(res.body.lines.map((l: { unitCost: number }) => l.unitCost)).toEqual([9, 3]);
      expect(await level(books[0])).toMatchObject({ quantity: 18, cost: 9 });
      expect(await level(books[1])).toMatchObject({ quantity: Number(before.quantity), damaged: 1, damagedValue: 3 });
      const history = (await db.query(
        `SELECT book_id, delta, reason_code, reference_type, reference_id::int AS reference_id, unit_cost::float AS unit_cost FROM inventory_history
         WHERE reference_type = 'supplier_return' AND reference_id = $1 ORDER BY book_id`, [rts],
      )).rows;
      expect(history).toEqual([
        { book_id: books[0], delta: -2, reason_code: 'supplier_return', reference_type: 'supplier_return', reference_id: rts, unit_cost: 9 },
        { book_id: books[1], delta: 0, reason_code: 'supplier_return', reference_type: 'supplier_return', reference_id: rts, unit_cost: 3 },
      ]);
      const after = await po(order.id);
      expect(after.creditNotes).toEqual([expect.objectContaining({ creditNoteNumber: res.body.creditNoteNumber, amount: 24, reason: `Return ${res.body.returnNumber}` })]);
      expect(after.lineItems.map((l) => l.returnedQuantity)).toEqual([2, 1]);
      expect(after.outstandingAmount).toBe(96);
      expect(after.refundDue).toBe(0);
      const audit = await one(`SELECT meta FROM audit_logs WHERE entity_type = 'supplier_return' AND entity_id = $1 AND meta->>'action' = 'send'`, [String(rts)]);
      expect(audit.meta).toMatchObject({ returnNumber: res.body.returnNumber, creditValue: '24.00', costValue: '21.00' });
    });

    it('is sent once; a sent return is neither edited nor cancelled (2a)', async () => {
      for (const res of [await send(t.manager, rts), await as(t.manager).post(`/api/v1/supplier-returns/${rts}/cancel`, { reason: 'x' })]) {
        expect(res.status).toBe(422);
        expect(res.body.error).toBe('SUPPLIER_RETURN_INVALID_STATUS');
      }
    });

    it('counts what went back against what can still go back', async () => {
      const res = await draft(t.purchasor, { poId: order.id, lines: [{ poLineItemId: lineOf(order, books[0]), locationId: shelf, source: 'stock', quantity: 9 }] });
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('RETURN_EXCEEDS_RECEIVED');
    });

    it('refuses to send more than the location holds, and changes nothing', async () => {
      const short = (await draft(t.purchasor, { poId: order.id, lines: [
        { poLineItemId: lineOf(order, books[0]), locationId: shelf, source: 'stock', quantity: 1 },
        { poLineItemId: lineOf(order, books[0]), locationId: back, source: 'stock', quantity: 1 },
      ] })).body.id;
      const res = await send(t.manager, short);
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('INSUFFICIENT_STOCK');
      expect((await level(books[0])).quantity).toBe(18);
      expect((await as(t.manager).get(`/api/v1/supplier-returns/${short}`)).body.status).toBe('draft');
    });
  });

  describe('money (4a)', () => {
    it('credits what the order still owes', async () => {
      const order = await receivedOrder();
      await as(t.finance).post(`/api/v1/purchase-orders/${order.id}/payments`, { amount: 50, paymentMethod: 'cash' });
      const rts = (await draft(t.purchasor, { poId: order.id, lines: [{ poLineItemId: lineOf(order, books[0]), locationId: shelf, source: 'stock', quantity: 2 }] })).body.id;
      expect((await send(t.manager, rts)).status).toBe(200);
      expect(await po(order.id)).toMatchObject({ outstandingAmount: 50, refundDue: 0 });
    });

    it('makes a refund due beyond it, recorded by the ordering branch when the money arrives', async () => {
      const order = await receivedOrder();
      await as(t.finance).post(`/api/v1/purchase-orders/${order.id}/payments`, { amount: 120, paymentMethod: 'cash' });
      const rts = (await draft(t.purchasor, { poId: order.id, lines: [{ poLineItemId: lineOf(order, books[0]), locationId: shelf, source: 'stock', quantity: 3 }] })).body.id;
      expect((await send(t.manager, rts)).status).toBe(200);
      expect(await po(order.id)).toMatchObject({ outstandingAmount: -30, refundDue: 30, refundsTotal: 0 });

      // A payment beyond the order is still refused.
      expect((await as(t.finance).post(`/api/v1/purchase-orders/${order.id}/payments`, { amount: 1, paymentMethod: 'cash' })).status).toBe(422);
      expect((await refund(order.id, { amount: 10, method: 'cash' }, t.purchasor)).status).toBe(403);
      expect((await refund(order.id, { amount: 10, method: 'bank' })).status).toBe(400);
      const over = await refund(order.id, { amount: 31, method: 'cash' });
      expect(over.status).toBe(422);
      expect(over.body.error).toBe('REFUND_EXCEEDS_DUE');

      const res = await refund(order.id, { amount: 30, method: 'cheque', reference: 'CHQ-77', notes: 'Returned edition' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({ outstandingAmount: 0, refundDue: 0, refundsTotal: 30 });
      expect(res.body.supplierRefunds).toEqual([expect.objectContaining({ amount: 30, method: 'cheque', reference: 'CHQ-77' })]);
      expect(res.body.supplierRefunds[0].refundNumber).toMatch(/^SREF-\d{8}-\d{4}$/);
      expect((await refund(order.id, { amount: 1, method: 'cash' })).body.error).toBe('REFUND_EXCEEDS_DUE');

      const ledger = await as(t.finance).get(`/api/v1/suppliers/${supplierId}/ledger`);
      const types = ledger.body.entries.filter((e: { reference: string }) => e.reference.startsWith(`PO-${order.id.padStart(6, '0')}`))
        .map((e: { type: string; amount: number }) => [e.type, e.amount]);
      expect(types).toEqual(expect.arrayContaining([['CREDIT_NOTE', -30], ['SUPPLIER_REFUND', 30]]));
    });
  });
});
