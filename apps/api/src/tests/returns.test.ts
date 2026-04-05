import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'ret_test_';
const BRANCH_PREFIX = 'Returns Test ';

async function getTestBook(): Promise<{ id: number; price: number }> {
  const r = await db.query(`SELECT id, default_price FROM books WHERE is_active = true AND default_price IS NOT NULL LIMIT 1`);
  if (!r.rows.length) throw new Error('No active books with price');
  return { id: r.rows[0].id as number, price: parseFloat(r.rows[0].default_price as string) };
}

async function getOrCreateLocation(branchId: number): Promise<number> {
  const r = await db.query(`SELECT id FROM locations WHERE branch_id = $1 LIMIT 1`, [branchId]);
  if (r.rows.length) return r.rows[0].id as number;
  const c = await db.query(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Returns Test Loc', true) RETURNING id`, [branchId]);
  return c.rows[0].id as number;
}

async function ensureInventory(bookId: number, locationId: number, qty = 50) {
  await db.query(
    `INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version)
     VALUES ($1, $2, $3, 5, 0)
     ON CONFLICT (book_id, location_id) DO UPDATE SET quantity = $3, version = 0`,
    [bookId, locationId, qty],
  );
}

async function createSale(token: string, branchId: number, locationId: number, bookId: number, bookPrice: number, qty = 2) {
  const grand = parseFloat((bookPrice * qty * 1.10).toFixed(2));
  const res = await request(getTestApp())
    .post('/api/pos/transactions')
    .set('Authorization', `Bearer ${token}`)
    .set('X-Branch-Id', String(branchId))
    .send({ branchId, locationId, items: [{ bookId, quantity: qty }], payments: [{ method: 'cash', amount: grand }] });
  if (res.status !== 201) throw new Error(`Sale failed: ${JSON.stringify(res.body)}`);
  return res.body as { id: string; lineItems: Array<{ id: string; bookId: number; quantity: number }> };
}

async function cleanReturns(branchId: number) {
  await db.query(`DELETE FROM refunds WHERE return_id IN (SELECT id FROM returns WHERE branch_id = $1)`, [branchId]);
  await db.query(`DELETE FROM return_line_items WHERE return_id IN (SELECT id FROM returns WHERE branch_id = $1)`, [branchId]);
  await db.query(`DELETE FROM returns WHERE branch_id = $1`, [branchId]);
}

async function cleanTransactions(branchId: number) {
  await db.query(`DELETE FROM transaction_payments WHERE transaction_id IN (SELECT id FROM transactions WHERE branch_id = $1)`, [branchId]);
  await db.query(`DELETE FROM transaction_line_items WHERE transaction_id IN (SELECT id FROM transactions WHERE branch_id = $1)`, [branchId]);
  await db.query(`DELETE FROM transactions WHERE branch_id = $1`, [branchId]);
}

async function cleanCustomers(branchId: number) {
  const custIds = await db.query(`SELECT id FROM customers WHERE branch_id = $1`, [branchId]);
  for (const row of custIds.rows) {
    const cid = row.id as number;
    await db.query(`DELETE FROM loyalty_history WHERE customer_id = $1`, [cid]);
    await db.query(`DELETE FROM store_credit_history WHERE customer_id = $1`, [cid]);
    await db.query(`DELETE FROM loyalty_accounts WHERE customer_id = $1`, [cid]);
    await db.query(`DELETE FROM store_credit_accounts WHERE customer_id = $1`, [cid]);
  }
  await db.query(`DELETE FROM customer_group_membership WHERE customer_id IN (SELECT id FROM customers WHERE branch_id = $1)`, [branchId]);
  await db.query(`DELETE FROM customers WHERE branch_id = $1`, [branchId]);
}

describe('Returns & Refunds', () => {
  let salesToken: string;
  let managerToken: string;
  let branchId: number;
  let locationId: number;
  let bookId: number;
  let bookPrice: number;

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    // Clean customers referencing test branches before deleting branches
    const oldBranches = await db.query(`SELECT id FROM branches WHERE name LIKE 'Returns Test %'`);
    for (const row of oldBranches.rows) {
      await cleanCustomers(row.id as number);
    }
    await cleanTestBranches(BRANCH_PREFIX);

    const branch = await createTestBranch({ name: 'Returns Test Branch' });
    branchId = branch.branchId;

    const sales = await createTestStaff({ username: 'ret_test_sales', role: 'Sales', branchId });
    salesToken = sales.token;
    const mgr = await createTestStaff({ username: 'ret_test_mgr', role: 'Manager', branchId });
    managerToken = mgr.token;

    locationId = await getOrCreateLocation(branchId);
    const book = await getTestBook();
    bookId = book.id;
    bookPrice = book.price;
    await ensureInventory(bookId, locationId, 100);
  });

  afterAll(async () => {
    await cleanReturns(branchId);
    await cleanTransactions(branchId);
    // Delete all inventory_history for all locations in this branch (no CASCADE from locations)
    await db.query(`DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id = $1)`, [branchId]);
    await db.query(`DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id = $1)`, [branchId]);
    await cleanCustomers(branchId);
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  // ── 1. Full return → inventory restored ────────────────────────────────────

  it('1. Full return → inventory restored, refund recorded', async () => {
    await ensureInventory(bookId, locationId, 50);
    const tx = await createSale(salesToken, branchId, locationId, bookId, bookPrice, 2);
    const lineItemId = tx.lineItems[0].id;

    const invBefore = await db.query(`SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locationId]);
    const qtyBefore = invBefore.rows[0].quantity as number;

    const res = await request(getTestApp())
      .post('/api/returns')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ transactionId: parseInt(tx.id), refundMethod: 'cash', reason: 'Customer changed mind', lines: [{ transactionLineItemId: parseInt(lineItemId), quantity: 2 }] });

    expect(res.status).toBe(201);
    expect(res.body.returnNumber).toMatch(/^RET-\d{8}-\d{4}$/);
    expect(res.body.status).toBe('completed');
    expect(res.body.refundMethod).toBe('cash');
    expect(Number(res.body.totalRefundAmount)).toBeGreaterThan(0);

    const invAfter = await db.query(`SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locationId]);
    expect(invAfter.rows[0].quantity).toBe(qtyBefore + 2);
  });

  // ── 2. Partial return ───────────────────────────────────────────────────────

  it('2. Partial return → correct refund amount, inventory partially restored', async () => {
    await ensureInventory(bookId, locationId, 50);
    const tx = await createSale(salesToken, branchId, locationId, bookId, bookPrice, 3);
    const lineItemId = tx.lineItems[0].id;

    const invBefore = await db.query(`SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locationId]);
    const qtyBefore = invBefore.rows[0].quantity as number;

    const res = await request(getTestApp())
      .post('/api/returns')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ transactionId: parseInt(tx.id), refundMethod: 'cash', lines: [{ transactionLineItemId: parseInt(lineItemId), quantity: 1 }] });

    expect(res.status).toBe(201);
    expect(Number(res.body.totalRefundAmount)).toBeCloseTo(bookPrice * 1, 1);

    const invAfter = await db.query(`SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locationId]);
    expect(invAfter.rows[0].quantity).toBe(qtyBefore + 1);
  });

  // ── 3. Over-return → 422 ───────────────────────────────────────────────────

  it('3. Over-return → 422 OVER_RETURN', async () => {
    await ensureInventory(bookId, locationId, 50);
    const tx = await createSale(salesToken, branchId, locationId, bookId, bookPrice, 1);
    const lineItemId = tx.lineItems[0].id;

    const res = await request(getTestApp())
      .post('/api/returns')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ transactionId: parseInt(tx.id), refundMethod: 'cash', lines: [{ transactionLineItemId: parseInt(lineItemId), quantity: 5 }] });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('OVER_RETURN');
  });

  // ── 4. Store credit refund ──────────────────────────────────────────────────

  it('4. Store credit refund → customer balance increased', async () => {
    await ensureInventory(bookId, locationId, 50);

    // Create a customer with store credit account
    const custRes = await db.query(
      `INSERT INTO customers (branch_id, customer_code, full_name, is_active, created_at)
       VALUES ($1, $2, 'Returns Test Customer', true, now()) RETURNING id`,
      [branchId, `CUS-RET-${Date.now()}`],
    );
    const customerId = custRes.rows[0].id as number;
    await db.query(`INSERT INTO store_credit_accounts (customer_id, balance) VALUES ($1, 0)`, [customerId]);
    await db.query(`INSERT INTO loyalty_accounts (customer_id, points_balance, lifetime_points, updated_at) VALUES ($1, 0, 0, now())`, [customerId]);

    const grand = parseFloat((bookPrice * 1.10).toFixed(2));
    const txRes = await request(getTestApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ branchId, locationId, customerId, items: [{ bookId, quantity: 1 }], payments: [{ method: 'cash', amount: grand }] });
    expect(txRes.status).toBe(201);
    const lineItemId = txRes.body.lineItems[0].id;

    const res = await request(getTestApp())
      .post('/api/returns')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ transactionId: parseInt(txRes.body.id), refundMethod: 'store_credit', lines: [{ transactionLineItemId: parseInt(lineItemId), quantity: 1 }] });

    expect(res.status).toBe(201);
    expect(res.body.refundMethod).toBe('store_credit');

    const creditAfter = await db.query(`SELECT balance FROM store_credit_accounts WHERE customer_id = $1`, [customerId]);
    expect(Number(creditAfter.rows[0].balance)).toBeCloseTo(bookPrice, 1);

    // Cleanup — must clean transaction before customer (FK constraint)
    const txId = txRes.body.id;
    await db.query(`DELETE FROM refunds WHERE return_id IN (SELECT id FROM returns WHERE transaction_id = $1)`, [txId]);
    await db.query(`DELETE FROM return_line_items WHERE return_id IN (SELECT id FROM returns WHERE transaction_id = $1)`, [txId]);
    await db.query(`DELETE FROM returns WHERE transaction_id = $1`, [txId]);
    await db.query(`DELETE FROM transaction_payments WHERE transaction_id = $1`, [txId]);
    await db.query(`DELETE FROM transaction_line_items WHERE transaction_id = $1`, [txId]);
    await db.query(`DELETE FROM transactions WHERE id = $1`, [txId]);
    await db.query(`DELETE FROM store_credit_history WHERE customer_id = $1`, [customerId]);
    await db.query(`DELETE FROM loyalty_history WHERE customer_id = $1`, [customerId]);
    await db.query(`DELETE FROM store_credit_accounts WHERE customer_id = $1`, [customerId]);
    await db.query(`DELETE FROM loyalty_accounts WHERE customer_id = $1`, [customerId]);
    await db.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  });

  // ── 5. Approval required for large refund ──────────────────────────────────

  it('5. Large refund without approval → 422 APPROVAL_REQUIRED', async () => {
    await ensureInventory(bookId, locationId, 50);

    // Create a very expensive book
    const expBookRes = await db.query(
      `INSERT INTO books (isbn, title, is_active, default_price)
       VALUES ('RET-TEST-EXP', 'Expensive Returns Test Book', true, 9999.00)
       ON CONFLICT (isbn) DO UPDATE SET default_price = 9999.00, is_active = true RETURNING id`,
    );
    const expBookId = expBookRes.rows[0].id as number;
    await ensureInventory(expBookId, locationId, 10);

    const grand = parseFloat((9999 * 1.10).toFixed(2));
    const txRes = await request(getTestApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ branchId, locationId, items: [{ bookId: expBookId, quantity: 1 }], payments: [{ method: 'cash', amount: grand }] });
    expect(txRes.status).toBe(201);
    const lineItemId = txRes.body.lineItems[0].id;

    const res = await request(getTestApp())
      .post('/api/returns')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ transactionId: parseInt(txRes.body.id), refundMethod: 'cash', lines: [{ transactionLineItemId: parseInt(lineItemId), quantity: 1 }] });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('APPROVAL_REQUIRED');

    await db.query(`DELETE FROM inventory_history WHERE book_id = $1`, [expBookId]);
    await db.query(`DELETE FROM inventory WHERE book_id = $1`, [expBookId]);
    await db.query(`DELETE FROM books WHERE isbn = 'RET-TEST-EXP'`);
  });

  // ── 6. Return on voided transaction → 422 ──────────────────────────────────

  it('6. Return on voided transaction → 422 TRANSACTION_VOIDED', async () => {
    await ensureInventory(bookId, locationId, 50);
    const tx = await createSale(salesToken, branchId, locationId, bookId, bookPrice, 1);
    const lineItemId = tx.lineItems[0].id;

    // Void the transaction
    await request(getTestApp())
      .post(`/api/pos/transactions/${tx.id}/void`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    const res = await request(getTestApp())
      .post('/api/returns')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ transactionId: parseInt(tx.id), refundMethod: 'cash', lines: [{ transactionLineItemId: parseInt(lineItemId), quantity: 1 }] });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('TRANSACTION_VOIDED');
  });

  // ── 7. GET /api/returns list ────────────────────────────────────────────────

  it('7. GET /api/returns → returns list for branch', async () => {
    const res = await request(getTestApp())
      .get(`/api/returns?branchId=${branchId}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThan(0);
  });

  // ── 8. Double-return prevention ─────────────────────────────────────────────

  it('8. Double-return of same quantity → 422 OVER_RETURN', async () => {
    await ensureInventory(bookId, locationId, 50);
    const tx = await createSale(salesToken, branchId, locationId, bookId, bookPrice, 2);
    const lineItemId = tx.lineItems[0].id;

    // First return — 2 units
    const r1 = await request(getTestApp())
      .post('/api/returns')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ transactionId: parseInt(tx.id), refundMethod: 'cash', lines: [{ transactionLineItemId: parseInt(lineItemId), quantity: 2 }] });
    expect(r1.status).toBe(201);

    // Second return — tries to return again
    const r2 = await request(getTestApp())
      .post('/api/returns')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ transactionId: parseInt(tx.id), refundMethod: 'cash', lines: [{ transactionLineItemId: parseInt(lineItemId), quantity: 1 }] });
    expect(r2.status).toBe(422);
    expect(r2.body.error).toBe('OVER_RETURN');
  });
});
