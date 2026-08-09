import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'exc_test_';
const BRANCH_PREFIX = 'Exchange Test ';

async function getTestBooks(): Promise<Array<{ id: number; price: number }>> {
  const r = await db.query(`SELECT id, default_price FROM books WHERE is_active = true AND default_price IS NOT NULL LIMIT 2`);
  if (r.rows.length < 2) throw new Error('Need at least 2 active books with price');
  return r.rows.map(row => ({ id: row.id as number, price: parseFloat(row.default_price as string) }));
}

async function getOrCreateLocation(branchId: number): Promise<number> {
  const r = await db.query(`SELECT id FROM locations WHERE branch_id = $1 LIMIT 1`, [branchId]);
  if (r.rows.length) return r.rows[0].id as number;
  const c = await db.query(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Exc Test Loc', true) RETURNING id`, [branchId]);
  return c.rows[0].id as number;
}

async function ensureInventory(bookId: number, locationId: number, qty = 20) {
  await db.query(`INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version) VALUES ($1,$2,$3,5,0) ON CONFLICT (book_id, location_id) DO UPDATE SET quantity = $3, version = 0`, [bookId, locationId, qty]);
}

async function cleanExchanges(branchId: number) {
  await db.query(`DELETE FROM exchange_outgoing_items WHERE exchange_id IN (SELECT id FROM exchanges WHERE branch_id = $1)`, [branchId]);
  await db.query(`DELETE FROM exchange_incoming_items WHERE exchange_id IN (SELECT id FROM exchanges WHERE branch_id = $1)`, [branchId]);
  await db.query(`DELETE FROM exchanges WHERE branch_id = $1`, [branchId]);
}

describe('Exchanges — Merchant Exchange (In-Kind)', () => {
  let salesToken: string;
  let managerToken: string;
  let branchId: number;
  let locationId: number;
  let customerId: number;
  let book1: { id: number; price: number };
  let book2: { id: number; price: number };

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    const oldBranches = await db.query(`SELECT id FROM branches WHERE name LIKE 'Exchange Test %'`);
    for (const row of oldBranches.rows) await cleanExchanges(row.id as number);
    await cleanTestBranches(BRANCH_PREFIX);

    const branch = await createTestBranch({ name: 'Exchange Test Branch' });
    branchId = branch.branchId;
    const sales = await createTestStaff({ username: 'exc_test_sales', role: 'Sales', branchId });
    salesToken = sales.token;
    const mgr = await createTestStaff({ username: 'exc_test_mgr', role: 'Manager', branchId });
    managerToken = mgr.token;

    locationId = await getOrCreateLocation(branchId);
    const books = await getTestBooks();
    book1 = books[0];
    book2 = books[1];
    await ensureInventory(book1.id, locationId, 20);
    await ensureInventory(book2.id, locationId, 20);

    const custRes = await db.query(
      `INSERT INTO customers (full_name, customer_code, is_active) VALUES ('Exc Test Customer', 'EXC-TEST-001', true) RETURNING id`,
    );
    customerId = custRes.rows[0].id as number;
  });

  afterAll(async () => {
    await cleanExchanges(branchId);
    await db.query(`DELETE FROM store_credit_history WHERE customer_id = $1`, [customerId]).catch(() => {});
    await db.query(`DELETE FROM store_credit_accounts WHERE customer_id = $1`, [customerId]).catch(() => {});
    await db.query(`DELETE FROM receivables WHERE customer_id = $1`, [customerId]).catch(() => {});
    await db.query(`DELETE FROM customers WHERE id = $1`, [customerId]).catch(() => {});
    await db.query(`DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id = $1)`, [branchId]);
    await db.query(`DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id = $1)`, [branchId]);
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  // ── 1. Even exchange (equal value) ─────────────────────────────────────────

  it('1. Even exchange → settlementType=Even, status=Completed', async () => {
    await ensureInventory(book1.id, locationId, 20);
    const price = book1.price;

    const res = await request(getTestApp())
      .post('/api/exchanges')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        locationId,
        incomingItems: [{ bookId: book1.id, quantity: 1, unitPrice: price }],
        outgoingItems:  [{ bookId: book1.id, quantity: 1, unitPrice: price }],
      });

    expect(res.status).toBe(201);
    expect(res.body.exchangeReference).toMatch(/^EXC-\d{8}-\d{4}$/);
    expect(res.body.status).toBe('Completed');
    expect(res.body.settlementType).toBe('Even');
    expect(res.body.currency).toBe('ETB');
    expect(Number(res.body.netBalance)).toBeCloseTo(0, 2);
  });

  // ── 2. Customer pays (outgoing > incoming) ─────────────────────────────────

  it('2. Customer pays exchange → settlementType=Customer_Pays, opens a receivable', async () => {
    await ensureInventory(book1.id, locationId, 20);
    await ensureInventory(book2.id, locationId, 20);

    const res = await request(getTestApp())
      .post('/api/exchanges')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        locationId,
        customerId,
        incomingItems: [{ bookId: book1.id, quantity: 1, unitPrice: 100 }],
        outgoingItems:  [{ bookId: book2.id, quantity: 1, unitPrice: 200 }],
      });

    expect(res.status).toBe(201);
    expect(res.body.settlementType).toBe('Customer_Pays');
    expect(Number(res.body.netBalance)).toBeCloseTo(100, 2);
    expect(Number(res.body.totalIncomingValue)).toBeCloseTo(100, 2);
    expect(Number(res.body.totalOutgoingValue)).toBeCloseTo(200, 2);

    // Module 2 fix: Quick Exchange now posts the financial effect immediately
    // (it has no separate settle step) -- a receivable for the difference.
    const recRes = await db.query(
      `SELECT * FROM receivables WHERE source_type = 'exchange_difference' AND source_entity_id = $1`,
      [res.body.id],
    );
    expect(recRes.rows.length).toBe(1);
    expect(parseFloat(recRes.rows[0].original_amount as string)).toBeCloseTo(100, 2);
  });

  // ── 2b. Non-Even exchange without a customer is rejected ──────────────────

  it('2b. Customer pays exchange without a customer → 422 CUSTOMER_REQUIRED_FOR_SETTLEMENT', async () => {
    await ensureInventory(book1.id, locationId, 20);
    await ensureInventory(book2.id, locationId, 20);

    const res = await request(getTestApp())
      .post('/api/exchanges')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        locationId,
        incomingItems: [{ bookId: book1.id, quantity: 1, unitPrice: 100 }],
        outgoingItems:  [{ bookId: book2.id, quantity: 1, unitPrice: 200 }],
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('CUSTOMER_REQUIRED_FOR_SETTLEMENT');
  });

  // ── 3. Store refunds (incoming > outgoing) ─────────────────────────────────

  it('3. Store refunds exchange → settlementType=Store_Refunds, credits store credit', async () => {
    await ensureInventory(book1.id, locationId, 20);
    await ensureInventory(book2.id, locationId, 20);
    const balBefore = await db.query(`SELECT balance FROM store_credit_accounts WHERE customer_id = $1`, [customerId]);
    const before = balBefore.rows.length ? parseFloat(balBefore.rows[0].balance as string) : 0;

    const res = await request(getTestApp())
      .post('/api/exchanges')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        locationId,
        customerId,
        incomingItems: [{ bookId: book1.id, quantity: 1, unitPrice: 300 }],
        outgoingItems:  [{ bookId: book2.id, quantity: 1, unitPrice: 100 }],
      });

    expect(res.status).toBe(201);
    expect(res.body.settlementType).toBe('Store_Refunds');
    expect(Number(res.body.netBalance)).toBeCloseTo(-200, 2);

    // Module 2 fix: Store_Refunds credits store credit immediately.
    const balAfter = await db.query(`SELECT balance FROM store_credit_accounts WHERE customer_id = $1`, [customerId]);
    expect(parseFloat(balAfter.rows[0].balance as string)).toBeCloseTo(before + 200, 2);
  });

  // ── 4. Inventory updated correctly ─────────────────────────────────────────

  it('4. Inventory updated: incoming +qty, outgoing -qty', async () => {
    await ensureInventory(book1.id, locationId, 10);
    await ensureInventory(book2.id, locationId, 10);

    const inv1Before = await db.query(`SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`, [book1.id, locationId]);
    const inv2Before = await db.query(`SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`, [book2.id, locationId]);
    const qty1Before = inv1Before.rows[0].quantity as number;
    const qty2Before = inv2Before.rows[0].quantity as number;

    await request(getTestApp())
      .post('/api/exchanges')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        locationId,
        customerId,
        incomingItems: [{ bookId: book1.id, quantity: 2, unitPrice: 100 }],
        outgoingItems:  [{ bookId: book2.id, quantity: 3, unitPrice: 100 }],
      });

    const inv1After = await db.query(`SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`, [book1.id, locationId]);
    const inv2After = await db.query(`SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`, [book2.id, locationId]);

    expect(inv1After.rows[0].quantity).toBe(qty1Before + 2); // incoming: +2
    expect(inv2After.rows[0].quantity).toBe(qty2Before - 3); // outgoing: -3
  });

  // ── 5. Insufficient stock for outgoing → 422 ───────────────────────────────

  it('5. Insufficient stock for outgoing → 422 INSUFFICIENT_STOCK', async () => {
    await db.query(`UPDATE inventory SET quantity = 0 WHERE book_id = $1 AND location_id = $2`, [book2.id, locationId]);

    const res = await request(getTestApp())
      .post('/api/exchanges')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        locationId,
        incomingItems: [{ bookId: book1.id, quantity: 1, unitPrice: 100 }],
        outgoingItems:  [{ bookId: book2.id, quantity: 5, unitPrice: 100 }],
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('INSUFFICIENT_STOCK');

    await ensureInventory(book2.id, locationId, 20);
  });

  // ── 6. No items → 400 ──────────────────────────────────────────────────────

  it('6. No items → 400 VALIDATION_ERROR', async () => {
    const res = await request(getTestApp())
      .post('/api/exchanges')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, incomingItems: [], outgoingItems: [] });

    expect(res.status).toBe(400);
  });

  // ── 6b. Missing location → 400 ─────────────────────────────────────────────

  it('6b. Missing locationId → 400 VALIDATION_ERROR (no silent no-op on inventory)', async () => {
    const res = await request(getTestApp())
      .post('/api/exchanges')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ incomingItems: [{ bookId: book1.id, quantity: 1, unitPrice: 50 }], outgoingItems: [] });

    expect(res.status).toBe(400);
  });

  // ── 7. Cancel exchange ──────────────────────────────────────────────────────

  it('7. Cancel Initiated exchange → status=Cancelled', async () => {
    // Create an exchange and immediately cancel it via direct DB manipulation to test cancel
    const createRes = await request(getTestApp())
      .post('/api/exchanges')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, customerId, incomingItems: [{ bookId: book1.id, quantity: 1, unitPrice: 50 }], outgoingItems: [] });
    expect(createRes.status).toBe(201);
    const excId = createRes.body.id;

    // Reset to Initiated so we can cancel
    await db.query(`UPDATE exchanges SET status = 'Initiated' WHERE id = $1`, [excId]);

    const cancelRes = await request(getTestApp())
      .post(`/api/exchanges/${excId}/cancel`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.status).toBe('Cancelled');
  });

  // ── 8. GET /api/exchanges list ──────────────────────────────────────────────

  it('8. GET /api/exchanges → returns list', async () => {
    const res = await request(getTestApp())
      .get(`/api/exchanges?branchId=${branchId}`)
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items[0].currency).toBe('ETB');
  });
});
