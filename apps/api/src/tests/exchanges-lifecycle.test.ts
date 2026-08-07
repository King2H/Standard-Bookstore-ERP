/**
 * exchanges-lifecycle.test.ts
 *
 * Module 2 (stabilization sprint) — coverage for the draft -> confirmed ->
 * settled/cancelled exchange lifecycle (initiate -> review -> approve ->
 * settle), which had ZERO test coverage before this sprint. That gap is why
 * a real bug went unnoticed: getById()/fetchItems() only ever queried the
 * legacy exchange_incoming_items/exchange_outgoing_items tables, so every
 * exchange created via this lifecycle came back with empty incomingItems/
 * outgoingItems in every API response (the items were correctly stored in
 * the unified exchange_items table and correctly drove inventory at
 * settlement -- they just never round-tripped back to any caller).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'exc_lc_test_';
const BRANCH_PREFIX = 'Exchange LC Test ';

async function getTestBooks(): Promise<Array<{ id: number; price: number }>> {
  const r = await db.query(`SELECT id, default_price FROM books WHERE is_active = true AND default_price IS NOT NULL LIMIT 2`);
  if (r.rows.length < 2) throw new Error('Need at least 2 active books with price');
  return r.rows.map(row => ({ id: row.id as number, price: parseFloat(row.default_price as string) }));
}

async function getOrCreateLocation(branchId: number): Promise<number> {
  const r = await db.query(`SELECT id FROM locations WHERE branch_id = $1 LIMIT 1`, [branchId]);
  if (r.rows.length) return r.rows[0].id as number;
  const c = await db.query(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Exc LC Test Loc', true) RETURNING id`, [branchId]);
  return c.rows[0].id as number;
}

async function ensureInventory(bookId: number, locationId: number, qty = 20) {
  await db.query(`INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version) VALUES ($1,$2,$3,5,0) ON CONFLICT (book_id, location_id) DO UPDATE SET quantity = $3, version = 0`, [bookId, locationId, qty]);
}

async function getInventoryQty(bookId: number, locationId: number): Promise<number> {
  const r = await db.query(`SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locationId]);
  return r.rows.length ? parseInt(r.rows[0].quantity as string, 10) : 0;
}

async function cleanExchanges(branchId: number) {
  await db.query(`DELETE FROM exchange_settlement_entries WHERE exchange_id IN (SELECT id FROM exchanges WHERE branch_id = $1)`, [branchId]);
  await db.query(`DELETE FROM financial_transactions WHERE exchange_id IN (SELECT id FROM exchanges WHERE branch_id = $1)`, [branchId]);
  await db.query(`DELETE FROM exchange_items WHERE exchange_id IN (SELECT id FROM exchanges WHERE branch_id = $1)`, [branchId]);
  await db.query(`DELETE FROM receivables WHERE source_type = 'exchange_difference' AND source_entity_id IN (SELECT id FROM exchanges WHERE branch_id = $1)`, [branchId]);
  await db.query(`DELETE FROM exchanges WHERE branch_id = $1`, [branchId]);
}

describe('Exchanges — draft -> confirmed -> settled/cancelled lifecycle', () => {
  let managerToken: string;
  let branchId: number;
  let locationId: number;
  let customerId: number;
  let book1: { id: number; price: number };
  let book2: { id: number; price: number };

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    const oldBranches = await db.query(`SELECT id FROM branches WHERE name LIKE $1`, [`${BRANCH_PREFIX}%`]);
    for (const row of oldBranches.rows) await cleanExchanges(row.id as number);
    await cleanTestBranches(BRANCH_PREFIX);

    const branch = await createTestBranch({ name: `${BRANCH_PREFIX}Branch` });
    branchId = branch.branchId;
    const mgr = await createTestStaff({ username: `${STAFF_PREFIX}mgr`, role: 'Manager', branchId });
    managerToken = mgr.token;

    locationId = await getOrCreateLocation(branchId);
    const books = await getTestBooks();
    book1 = books[0];
    book2 = books[1];

    const custRes = await db.query(
      `INSERT INTO customers (full_name, customer_code, is_active) VALUES ('Exc LC Test Customer', 'EXC-LC-001', true) RETURNING id`,
    );
    customerId = custRes.rows[0].id as number;
  });

  afterAll(async () => {
    await cleanExchanges(branchId);
    await db.query(`DELETE FROM store_credit_history WHERE customer_id = $1`, [customerId]).catch(() => {});
    await db.query(`DELETE FROM store_credit_accounts WHERE customer_id = $1`, [customerId]).catch(() => {});
    await db.query(`DELETE FROM customers WHERE id = $1`, [customerId]).catch(() => {});
    await db.query(`DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id = $1)`, [branchId]);
    await db.query(`DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id = $1)`, [branchId]);
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  async function initiate(items: Array<{ bookId: number; quantity: number; unitPrice: number; type: 'returned' | 'new'; condition?: string }>, extra: Record<string, unknown> = {}) {
    return request(getTestApp())
      .post('/api/exchanges/initiate')
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, customerId, items, ...extra });
  }
  async function review(id: string) {
    return request(getTestApp()).post(`/api/exchanges/${id}/review`).set('Authorization', `Bearer ${managerToken}`).set('X-Branch-Id', String(branchId));
  }
  async function approve(id: string) {
    return request(getTestApp()).post(`/api/exchanges/${id}/approve`).set('Authorization', `Bearer ${managerToken}`).set('X-Branch-Id', String(branchId));
  }
  async function settle(id: string, entries: unknown[], dueDate?: string) {
    return request(getTestApp())
      .post(`/api/exchanges/${id}/settle`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ entries, idempotencyKey: `settle-${id}-${Date.now()}-${Math.random().toString(36).slice(2)}`, dueDate });
  }
  async function cancel(id: string) {
    return request(getTestApp()).post(`/api/exchanges/${id}/cancel`).set('Authorization', `Bearer ${managerToken}`).set('X-Branch-Id', String(branchId));
  }

  // ── 1. Full happy path — items survive every stage (the fetchItems bug) ────

  it('1. initiate -> review -> approve -> settle (Even): items are present at every stage, inventory moves atomically', async () => {
    await ensureInventory(book1.id, locationId, 10);
    await ensureInventory(book2.id, locationId, 10);
    const qty1Before = await getInventoryQty(book1.id, locationId);
    const qty2Before = await getInventoryQty(book2.id, locationId);

    const initRes = await initiate([
      { bookId: book1.id, quantity: 1, unitPrice: 100, type: 'returned' },
      { bookId: book2.id, quantity: 1, unitPrice: 100, type: 'new' },
    ]);
    expect(initRes.status).toBe(201);
    expect(initRes.body.lifecycleStatus).toBe('INITIATED');
    // Regression guard for the fetchItems() bug: items must round-trip back.
    expect(initRes.body.incomingItems).toHaveLength(1);
    expect(initRes.body.outgoingItems).toHaveLength(1);
    expect(initRes.body.incomingItems[0].bookId).toBe(book1.id);
    expect(initRes.body.outgoingItems[0].bookId).toBe(book2.id);
    const id = initRes.body.id as string;

    // Inventory must NOT move yet — only settle() touches inventory.
    expect(await getInventoryQty(book1.id, locationId)).toBe(qty1Before);
    expect(await getInventoryQty(book2.id, locationId)).toBe(qty2Before);

    const reviewRes = await review(id);
    expect(reviewRes.status).toBe(200);
    expect(reviewRes.body.lifecycleStatus).toBe('REVIEWED');
    expect(reviewRes.body.incomingItems).toHaveLength(1);
    expect(reviewRes.body.outgoingItems).toHaveLength(1);

    const approveRes = await approve(id);
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.lifecycleStatus).toBe('APPROVED');
    expect(approveRes.body.incomingItems).toHaveLength(1);
    expect(approveRes.body.outgoingItems).toHaveLength(1);
    // Inventory still untouched at approve time.
    expect(await getInventoryQty(book1.id, locationId)).toBe(qty1Before);
    expect(await getInventoryQty(book2.id, locationId)).toBe(qty2Before);

    const settleRes = await settle(id, [{ entryType: 'item_value_adjustment', amount: 0 }]);
    expect(settleRes.status).toBe(200);
    expect(settleRes.body.lifecycleStatus).toBe('COMPLETED');
    expect(settleRes.body.status).toBe('Completed');
    expect(settleRes.body.incomingItems).toHaveLength(1);
    expect(settleRes.body.outgoingItems).toHaveLength(1);

    // Inventory moves atomically at settle: incoming (+1), outgoing (-1).
    expect(await getInventoryQty(book1.id, locationId)).toBe(qty1Before + 1);
    expect(await getInventoryQty(book2.id, locationId)).toBe(qty2Before - 1);

    // Both movements went through invTxSvc (inventoryTransaction.service.ts),
    // not a raw UPDATE — verify the audit trail it writes.
    const histIn = await db.query(
      `SELECT * FROM inventory_history WHERE reference_type = 'exchange_in' AND reference_id = $1`,
      [id],
    );
    expect(histIn.rows.length).toBeGreaterThan(0);
    expect(Number(histIn.rows[0].delta)).toBe(1);
    const histOut = await db.query(
      `SELECT * FROM inventory_history WHERE reference_type = 'exchange_out' AND reference_id = $1`,
      [id],
    );
    expect(histOut.rows.length).toBeGreaterThan(0);
    expect(Number(histOut.rows[0].delta)).toBe(-1);

    // GET /api/exchanges/:id independently confirms items persist post-settlement.
    const getRes = await request(getTestApp()).get(`/api/exchanges/${id}`).set('Authorization', `Bearer ${managerToken}`).set('X-Branch-Id', String(branchId));
    expect(getRes.body.incomingItems).toHaveLength(1);
    expect(getRes.body.outgoingItems).toHaveLength(1);
  });

  // ── 2. Customer_Pays settlement creates a receivable ───────────────────────

  it('2. Customer_Pays settlement creates a receivable for the difference', async () => {
    await ensureInventory(book2.id, locationId, 10);

    const initRes = await initiate([
      { bookId: book1.id, quantity: 1, unitPrice: 50, type: 'returned' },
      { bookId: book2.id, quantity: 1, unitPrice: 150, type: 'new' },
    ]);
    const id = initRes.body.id as string;
    expect(initRes.body.settlementType).toBe('Customer_Pays');
    expect(Number(initRes.body.netBalance)).toBeCloseTo(100, 2);

    await review(id);
    await approve(id);
    const settleRes = await settle(id, [{ entryType: 'cash_payment', amount: 100, method: 'cash' }]);
    expect(settleRes.status).toBe(200);

    const recRes = await db.query(
      `SELECT * FROM receivables WHERE source_type = 'exchange_difference' AND source_entity_id = $1`,
      [id],
    );
    expect(recRes.rows.length).toBe(1);
    expect(parseFloat(recRes.rows[0].original_amount as string)).toBeCloseTo(100, 2);
  });

  // ── 3. Store_Refunds settlement credits customer store credit ─────────────

  it('3. Store_Refunds settlement credits the customer store credit balance', async () => {
    await ensureInventory(book1.id, locationId, 10);

    const balBefore = await db.query(`SELECT balance FROM store_credit_accounts WHERE customer_id = $1`, [customerId]);
    const before = balBefore.rows.length ? parseFloat(balBefore.rows[0].balance as string) : 0;

    const initRes = await initiate([
      { bookId: book1.id, quantity: 1, unitPrice: 150, type: 'returned' },
      { bookId: book2.id, quantity: 1, unitPrice: 50, type: 'new' },
    ]);
    const id = initRes.body.id as string;
    expect(initRes.body.settlementType).toBe('Store_Refunds');

    await review(id);
    await approve(id);
    const settleRes = await settle(id, [{ entryType: 'cash_refund', amount: 100, method: 'cash' }]);
    expect(settleRes.status).toBe(200);

    const balAfter = await db.query(`SELECT balance FROM store_credit_accounts WHERE customer_id = $1`, [customerId]);
    expect(parseFloat(balAfter.rows[0].balance as string)).toBeCloseTo(before + 100, 2);
  });

  // ── 4. Validate available stock before confirmation (approve) ─────────────

  it('4. Insufficient stock at approve time → 422 INSUFFICIENT_STOCK, exchange stays REVIEWED', async () => {
    await ensureInventory(book2.id, locationId, 2);

    const initRes = await initiate([
      { bookId: book2.id, quantity: 5, unitPrice: 50, type: 'new' },
    ]);
    const id = initRes.body.id as string;
    await review(id);

    const approveRes = await approve(id);
    expect(approveRes.status).toBe(422);
    expect(approveRes.body.error).toBe('INSUFFICIENT_STOCK');

    const getRes = await request(getTestApp()).get(`/api/exchanges/${id}`).set('Authorization', `Bearer ${managerToken}`).set('X-Branch-Id', String(branchId));
    expect(getRes.body.lifecycleStatus).toBe('REVIEWED'); // did not advance to APPROVED

    await ensureInventory(book2.id, locationId, 20);
  });

  // ── 5. Invalid lifecycle transitions are rejected ──────────────────────────

  it('5. Cannot approve before review; cannot settle before approve', async () => {
    await ensureInventory(book1.id, locationId, 10);
    const initRes = await initiate([{ bookId: book1.id, quantity: 1, unitPrice: 50, type: 'returned' }]);
    const id = initRes.body.id as string;

    const approveTooSoon = await approve(id);
    expect(approveTooSoon.status).toBe(422);
    expect(approveTooSoon.body.error).toBe('INVALID_LIFECYCLE_TRANSITION');

    const settleTooSoon = await settle(id, [{ entryType: 'item_value_adjustment', amount: -50 }]);
    expect(settleTooSoon.status).toBe(422);
    expect(settleTooSoon.body.error).toBe('INVALID_LIFECYCLE_TRANSITION');
  });

  // ── 6. Cancel is allowed pre-settlement, rejected post-settlement ─────────

  it('6. Cancel works at INITIATED/REVIEWED/APPROVED; rejected once SETTLED', async () => {
    await ensureInventory(book1.id, locationId, 10);

    // Cancel at INITIATED
    const init1 = await initiate([{ bookId: book1.id, quantity: 1, unitPrice: 50, type: 'returned' }]);
    const cancel1 = await cancel(init1.body.id);
    expect(cancel1.status).toBe(200);
    expect(cancel1.body.lifecycleStatus).toBe('CANCELLED');

    // Cancel at APPROVED
    const init2 = await initiate([{ bookId: book1.id, quantity: 1, unitPrice: 50, type: 'returned' }]);
    await review(init2.body.id);
    await approve(init2.body.id);
    const cancel2 = await cancel(init2.body.id);
    expect(cancel2.status).toBe(200);
    expect(cancel2.body.lifecycleStatus).toBe('CANCELLED');

    // Cannot cancel once settled — settleExchange() sets both status='Completed'
    // and lifecycle_status='COMPLETED'; cancelExchange() checks status first.
    const init3 = await initiate([{ bookId: book1.id, quantity: 1, unitPrice: 50, type: 'returned' }]);
    await review(init3.body.id);
    await approve(init3.body.id);
    await settle(init3.body.id, [{ entryType: 'item_value_adjustment', amount: -50 }]);
    const cancel3 = await cancel(init3.body.id);
    expect(cancel3.status).toBe(422);
    expect(cancel3.body.error).toBe('ALREADY_COMPLETED');
  });

  // ── 7. Settlement cash entries are reflected in the Payments report ───────

  it('7. Customer_Pays settlement cash payment is reflected in GET /api/reports/payments', async () => {
    await ensureInventory(book2.id, locationId, 10);

    const dateFrom = new Date(Date.now() - 60_000).toISOString().slice(0, 10);
    const before = await request(getTestApp())
      .get(`/api/reports/payments?branchId=${branchId}&dateFrom=${dateFrom}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));
    const collectedBefore = Number(before.body.summary.totalCollected);

    const initRes = await initiate([
      { bookId: book1.id, quantity: 1, unitPrice: 20, type: 'returned' },
      { bookId: book2.id, quantity: 1, unitPrice: 95, type: 'new' },
    ]);
    const id = initRes.body.id as string;
    await review(id);
    await approve(id);
    await settle(id, [{ entryType: 'cash_payment', amount: 75, method: 'cash' }]);

    const after = await request(getTestApp())
      .get(`/api/reports/payments?branchId=${branchId}&dateFrom=${dateFrom}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));
    expect(Number(after.body.summary.totalCollected)).toBeCloseTo(collectedBefore + 75, 2);

    const cashMethod = after.body.byMethod.find((m: { method: string }) => m.method === 'cash');
    expect(cashMethod).toBeTruthy();
  });
});
