/**
 * damaged-stock.test.ts
 *
 * #168 (owner decisions 1a, 2a, 3a, 4a, 2026-10-24): damaged copies came in
 * (a damaged return or trade-in) but could never go out. They keep their
 * cost apart from the stock for sale (2a); Admin, Manager and Stock_Clerk
 * write them off or put them back for sale after repair, with a reason (3a);
 * return to a supplier is #173 (1a). Each test names what happened before.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'damaged_test_';
const BRANCH_PREFIX = 'Damaged Stock ';

describe('Damaged copies', () => {
  let branchId: number;
  let locationId: number;
  let otherLocationId: number;
  let bookId: number;
  let price: number;
  let manager: string;
  let clerk: string;
  let sales: string;
  const api = () => request(getTestApp());
  const as = (r: request.Test, token = manager) => r.set('Authorization', `Bearer ${token}`).set('X-Branch-Id', String(branchId));
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  const level = () => one(
    `SELECT quantity, damaged_quantity, damaged_value, average_cost, inventory_value FROM inventory WHERE book_id = $1 AND location_id = $2`,
    [bookId, locationId],
  );
  const lastMovement = () => one(
    `SELECT movement_type, reason_code, unit_cost, notes, qty_before, qty_after FROM inventory_history
     WHERE book_id = $1 AND location_id = $2 ORDER BY id DESC LIMIT 1`,
    [bookId, locationId],
  );

  /** Sells `quantity` copies at the counter and takes them back damaged. */
  async function damagedReturn(quantity: number) {
    const sale = await as(api().post('/api/v1/pos/transactions')).send({
      locationId, items: [{ bookId, quantity }], payments: [{ method: 'cash', amount: price * quantity }],
    });
    expect(sale.status).toBe(201);
    const ret = await as(api().post('/api/v1/returns')).send({
      transactionId: Number(sale.body.id),
      lines: [{ transactionLineItemId: Number(sale.body.lineItems[0].id), quantity, disposition: 'DAMAGED' }],
    });
    expect(ret.status).toBe(201);
  }
  const writeOff = (body: object, token = manager) => as(api().post('/api/v1/inventory/damaged/write-off'), token).send({ bookId, locationId, ...body });
  const repair = (body: object, token = manager) => as(api().post('/api/v1/inventory/damaged/repair'), token).send({ bookId, locationId, ...body });

  async function cleanUp() {
    const branches = `SELECT id FROM branches WHERE name LIKE '${BRANCH_PREFIX}%'`;
    for (const statement of [
      `DELETE FROM refunds WHERE return_id IN (SELECT id FROM returns WHERE branch_id IN (${branches}))`,
      `DELETE FROM return_line_items WHERE return_id IN (SELECT id FROM returns WHERE branch_id IN (${branches}))`,
      `DELETE FROM returns WHERE branch_id IN (${branches})`,
      `DELETE FROM transaction_payments WHERE transaction_id IN (SELECT id FROM transactions WHERE branch_id IN (${branches}))`,
      `DELETE FROM transaction_line_items WHERE transaction_id IN (SELECT id FROM transactions WHERE branch_id IN (${branches}))`,
      `DELETE FROM transactions WHERE branch_id IN (${branches})`,
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
    const otherBranch = (await createTestBranch({ name: `${BRANCH_PREFIX}B` })).branchId;
    manager = (await createTestStaff({ username: `${STAFF_PREFIX}mgr`, role: 'Manager', branchId })).token;
    clerk = (await createTestStaff({ username: `${STAFF_PREFIX}clerk`, role: 'Stock_Clerk', branchId })).token;
    sales = (await createTestStaff({ username: `${STAFF_PREFIX}sales`, role: 'Sales', branchId })).token;
    locationId = (await one(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Damaged Loc', true) RETURNING id`, [branchId])).id;
    otherLocationId = (await one(`INSERT INTO locations (branch_id, name) VALUES ($1, 'Damaged Other Loc') RETURNING id`, [otherBranch])).id;
    const book = await one(`SELECT id, default_price FROM books WHERE is_active = true AND default_price > 10 ORDER BY id LIMIT 1`);
    bookId = book.id;
    price = Number(book.default_price);
    await db.query(
      `INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version, average_cost) VALUES ($1, $2, 20, 1, 0, 4)`,
      [bookId, locationId],
    );
  });

  afterAll(cleanUp);

  it('keeps the cost a damaged return left at (was: damaged copies had no value)', async () => {
    await damagedReturn(3);
    expect(await level()).toMatchObject({ quantity: 17, damaged_quantity: 3, damaged_value: '12.00' });
    expect(Number((await lastMovement()).unit_cost)).toBe(4);
  });

  it('shows the damaged count and value with the stock (was: not on Stock Levels)', async () => {
    const res = await as(api().get(`/api/v1/inventory?bookId=${bookId}&locationId=${locationId}`));
    expect(res.body.items[0]).toMatchObject({ quantity: 17, damaged: 3, damagedValue: 12 });
  });

  it('counts damaged copies apart from those for sale (was: taken off the for-sale count too)', async () => {
    const res = await as(api().get(`/api/v1/inventory/book/${bookId}/breakdown`));
    expect(res.body.items.find((l: { locationId: number }) => l.locationId === locationId)).toMatchObject({ quantity: 17, damaged: 3, sellable: 17 });
  });

  it('writes damaged copies off with a reason: count and value go, recorded and audited (was: no way out)', async () => {
    const res = await writeOff({ quantity: 1, reason: 'Water damage, pages stuck' }, clerk);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ quantity: 17, damaged: 2, damagedValue: 8 });
    expect(await level()).toMatchObject({ quantity: 17, damaged_quantity: 2, damaged_value: '8.00', inventory_value: '68.00' });
    const moved = await lastMovement();
    expect(moved).toMatchObject({ movement_type: 'stock_out', reason_code: 'damage_write_off', notes: 'Water damage, pages stuck', qty_before: 17, qty_after: 17 });
    expect(Number(moved.unit_cost)).toBe(4);
    const audit = await one(
      `SELECT meta FROM audit_logs WHERE entity_type = 'inventory_damaged' AND entity_id = $1 ORDER BY id DESC LIMIT 1`,
      [`${bookId}:${locationId}`],
    );
    expect(audit.meta).toMatchObject({ action: 'write_off', quantity: 1, value: '4.00', reason: 'Water damage, pages stuck' });
  });

  it('puts repaired copies back for sale at their cost (was: no way out)', async () => {
    await db.query(`UPDATE inventory SET average_cost = 6 WHERE book_id = $1 AND location_id = $2`, [bookId, locationId]);
    const res = await repair({ quantity: 1, reason: 'Cover reglued' }, clerk);
    expect(res.status).toBe(200);
    // 17 at 6 and 1 at 4: 106 for 18.
    expect(await level()).toMatchObject({ quantity: 18, damaged_quantity: 1, damaged_value: '4.00', inventory_value: '106.00' });
    expect(Number((await level()).average_cost)).toBeCloseTo(106 / 18, 4);
    expect(await lastMovement()).toMatchObject({ movement_type: 'stock_in', reason_code: 'damage_repaired', notes: 'Cover reglued', qty_before: 17, qty_after: 18 });
  });

  it('takes the last damaged copy with what is left of the value', async () => {
    await damagedReturn(2);
    // 1 at 4.00 and 2 more at the sale's cost.
    const before = await level();
    const res = await writeOff({ quantity: before.damaged_quantity, reason: 'Pulped' });
    expect(res.status).toBe(200);
    expect(await level()).toMatchObject({ damaged_quantity: 0, damaged_value: '0.00' });
  });

  it('refuses more than is damaged, and needs a reason', async () => {
    await damagedReturn(1);
    const tooMany = await writeOff({ quantity: 5, reason: 'x' });
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.error).toBe('INSUFFICIENT_STOCK');
    expect((await repair({ quantity: 1 })).status).toBe(400);
    expect((await writeOff({ quantity: 1, reason: '   ' })).status).toBe(400);
  });

  it('is warehouse work: Sales cannot write off or repair', async () => {
    expect((await writeOff({ quantity: 1, reason: 'x' }, sales)).status).toBe(403);
    expect((await repair({ quantity: 1, reason: 'x' }, sales)).status).toBe(403);
  });

  it("refuses another branch's location", async () => {
    const res = await as(api().post('/api/v1/inventory/damaged/write-off')).send({ bookId, locationId: otherLocationId, quantity: 1, reason: 'x' });
    expect([403, 404]).toContain(res.status);
  });
});
