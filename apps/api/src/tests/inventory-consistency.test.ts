/**
 * Inventory Consistency Scenario Tests
 *
 * Validates the 5 core consistency scenarios from the spec (Requirement RULE 8).
 * These tests verify the centralized InventoryTransactionService enforces
 * a strict single source of truth across POS, Orders, Returns, and Reservations.
 *
 * Scenarios:
 *   1. POS sell deducts correct location stock (2.1, 2.4, 2.14)
 *   2. Reservation blocks POS oversell (1.2, 2.2, 2.3, 2.4)
 *   3. Order cancel before fulfillment restores stock (2.7, 2.5)
 *   4. Order fulfill then cancel is rejected (2.6, 3.2)
 *   5. Return increases stock at correct location (2.10, 2.14)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'invcon_test_';
const BRANCH_PREFIX = 'InvCon Test ';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getActiveBook(): Promise<{ id: number; price: number }> {
  const res = await db.query(
    `SELECT id FROM books WHERE is_active = true LIMIT 1`,
  );
  if (!res.rows.length) throw new Error('No active books found');
  return { id: res.rows[0].id as number, price: 100 };
}

async function setInventory(bookId: number, locationId: number, qty: number): Promise<void> {
  await db.query(
    `INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version)
     VALUES ($1, $2, $3, 5, 0)
     ON CONFLICT (book_id, location_id) DO UPDATE SET quantity = $3, version = 0`,
    [bookId, locationId, qty],
  );
}

async function getInventoryQty(bookId: number, locationId: number): Promise<number> {
  const res = await db.query(
    `SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`,
    [bookId, locationId],
  );
  return res.rows[0] ? Number(res.rows[0].quantity) : 0;
}

async function getLastHistoryRow(bookId: number, locationId: number): Promise<Record<string, unknown> | null> {
  const res = await db.query(
    `SELECT * FROM inventory_history
     WHERE book_id = $1 AND location_id = $2
     ORDER BY id DESC LIMIT 1`,
    [bookId, locationId],
  );
  return res.rows[0] ?? null;
}

async function clearReservations(bookId: number, locationId: number): Promise<void> {
  const check = await db.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'inventory_reservations' LIMIT 1`,
  );
  if (!check.rows.length) return;
  await db.query(
    `DELETE FROM inventory_reservations WHERE book_id = $1 AND location_id = $2`,
    [bookId, locationId],
  );
}

async function ensureBookPrice(bookId: number, branchId: number): Promise<void> {
  await db.query(
    `INSERT INTO book_branch_prices (book_id, branch_id, format_id, edition_id, price)
     VALUES ($1, $2, 0, 0, 100.00)
     ON CONFLICT (book_id, branch_id, format_id, edition_id) DO NOTHING`,
    [bookId, branchId],
  );
}

// ── Suite Setup ───────────────────────────────────────────────────────────────

describe('Inventory Consistency Scenarios', () => {
  let adminToken: string;
  let staffId: number;
  let branchId: number;
  let locationId: number;
  let locationBId: number; // second location for location-isolation test
  let bookId: number;

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);

    const branch = await createTestBranch({ name: 'InvCon Test Branch' });
    branchId = branch.branchId;

    const admin = await createTestStaff({
      username: 'invcon_test_admin',
      role: 'Admin',
      branchId,
    });
    adminToken = admin.token;
    staffId = admin.staffId;

    // Primary location
    const locA = await db.query(
      `INSERT INTO locations (branch_id, name, is_default_fulfillment)
       VALUES ($1, 'InvCon Main Shop', true) RETURNING id`,
      [branchId],
    );
    locationId = locA.rows[0].id as number;

    // Secondary location (same branch)
    const locB = await db.query(
      `INSERT INTO locations (branch_id, name, is_default_fulfillment)
       VALUES ($1, 'InvCon Store Room', false) RETURNING id`,
      [branchId],
    );
    locationBId = locB.rows[0].id as number;

    const book = await getActiveBook();
    bookId = book.id;

    await ensureBookPrice(bookId, branchId);
  });

  afterAll(async () => {
    if (locationId) {
      await db.query(`DELETE FROM inventory_history WHERE location_id IN ($1, $2)`, [locationId, locationBId]);
      await clearReservations(bookId, locationId);
      await clearReservations(bookId, locationBId);
      await db.query(`DELETE FROM inventory WHERE location_id IN ($1, $2)`, [locationId, locationBId]);
    }
    // Scenarios 3/4 create orders via POST /api/orders (confirm/fulfill/cancel),
    // which also insert inventory_reservations. Without cleaning these up first,
    // cleanTestBranches()'s DELETE FROM locations fails with a FK violation on
    // orders_location_id_fkey.
    if (branchId) {
      // Payment Mode Capture: cash_sale confirms now write an order_payments
      // row, which must be cleaned up before orders (FK).
      await db.query(`DELETE FROM order_payments WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`, [branchId]).catch(() => {});
      await db.query(`DELETE FROM inventory_reservations WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`, [branchId]);
      await db.query(`DELETE FROM order_line_items WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`, [branchId]);
      await db.query(`DELETE FROM orders WHERE branch_id = $1`, [branchId]);
    }
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  beforeEach(async () => {
    await clearReservations(bookId, locationId);
    await clearReservations(bookId, locationBId);
    await db.query(`DELETE FROM inventory_history WHERE location_id IN ($1, $2)`, [locationId, locationBId]);
  });

  // ── Scenario 1: POS sell deducts correct location stock ───────────────────

  it('Scenario 1: POS sell reduces stock at correct location only', async () => {
    // Arrange: location A qty=5, location B qty=100
    await setInventory(bookId, locationId, 5);
    await setInventory(bookId, locationBId, 100);

    // Act: POS sale of qty=2 at location A
    const res = await request(getTestApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        branchId,
        locationId,
        items: [{ bookId, quantity: 2 }],
        payments: [{ method: 'cash', amount: 200 }],
      });

    expect(res.status).toBe(201);

    // Assert: location A reduced by 2
    const qtyA = await getInventoryQty(bookId, locationId);
    expect(qtyA).toBe(3);

    // Assert: location B untouched
    const qtyB = await getInventoryQty(bookId, locationBId);
    expect(qtyB).toBe(100);

    // Assert: inventory_history row exists with correct fields
    const hist = await getLastHistoryRow(bookId, locationId);
    expect(hist).not.toBeNull();
    expect(hist!.movement_type).toBe('stock_out');
    expect(hist!.reference_type).toBe('sale');
    expect(hist!.delta).toBe(-2);
    expect(hist!.staff_id).toBeTruthy();
  });

  // ── Scenario 2: Reservation blocks POS oversell ───────────────────────────

  it('Scenario 2: POS is blocked when stock is fully committed to a confirmed order', async () => {
    const check = await db.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'inventory_reservations' LIMIT 1`,
    );
    if (!check.rows.length) {
      console.log('Scenario 2 SKIPPED — inventory_reservations table not present');
      return;
    }

    // Arrange: qty=3
    await setInventory(bookId, locationId, 3);

    // Confirm a real order for all 3 units through the actual API (not a
    // synthetic direct-SQL reservation insert). orders.service.ts confirm()
    // deducts inventory.quantity AND inserts the 'reserved' row in the same
    // transaction (order-payment-unification spec, 3.5) -- there is no live
    // code path where a reservation exists without the matching deduction,
    // so that's the scenario this test needs to exercise to mean anything.
    const orderRes = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, saleType: 'cash_sale', items: [{ bookId, quantity: 3 }] });
    expect(orderRes.status).toBe(201);
    const orderId = orderRes.body.id as string;

    const confirmRes = await request(getTestApp())
      .post(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId))
      .send();
    expect(confirmRes.status).toBe(200);

    // Confirming deducted quantity to 0
    expect(await getInventoryQty(bookId, locationId)).toBe(0);

    // Act: POS tries to sell qty=1 — nothing physically left on hand
    const res = await request(getTestApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        branchId,
        locationId,
        items: [{ bookId, quantity: 1 }],
        payments: [{ method: 'cash', amount: 100 }],
      });

    // Assert: rejected with INSUFFICIENT_STOCK
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('INSUFFICIENT_STOCK');

    // Assert: inventory untouched by the rejected attempt
    const qty = await getInventoryQty(bookId, locationId);
    expect(qty).toBe(0);

    // Cleanup
    await db.query(`DELETE FROM order_payments WHERE order_id = $1`, [orderId]).catch(() => {});
    await db.query(`DELETE FROM inventory_reservations WHERE order_id = $1`, [orderId]).catch(() => {});
    await db.query(`DELETE FROM order_line_items WHERE order_id = $1`, [orderId]);
    await db.query(`DELETE FROM orders WHERE id = $1`, [orderId]);
  });

  // ── Scenario 3: Order cancel before fulfillment restores stock ────────────

  it('Scenario 3: Cancelling a confirmed order restores stock', async () => {
    // Arrange: qty=10
    await setInventory(bookId, locationId, 10);

    // Act: confirm an order (creates stock deduction + reservation)
    const confirmRes = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        branchId,
        locationId,
        channel: 'in_store',
        items: [{ bookId, quantity: 2, unitPrice: 100 }],
      });
    expect(confirmRes.status).toBe(201);
    const orderId = confirmRes.body.id ?? confirmRes.body.order?.id;
    expect(orderId).toBeTruthy();

    // Confirm the order
    const confirmStep = await request(getTestApp())
      .post(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(confirmStep.status).toBe(200);

    // Verify stock was deducted
    const qtyAfterConfirm = await getInventoryQty(bookId, locationId);
    expect(qtyAfterConfirm).toBe(8);

    // Cancel the order
    const cancelRes = await request(getTestApp())
      .post(`/api/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Test cancellation' });
    expect(cancelRes.status).toBe(200);

    // Assert: stock restored to 10
    const qtyAfterCancel = await getInventoryQty(bookId, locationId);
    expect(qtyAfterCancel).toBe(10);

    // Assert: inventory_history row with movement_type=stock_in, reference_type=order_cancelled
    const hist = await getLastHistoryRow(bookId, locationId);
    expect(hist).not.toBeNull();
    expect(hist!.movement_type).toBe('stock_in');
    expect(hist!.reference_type).toBe('order_cancelled');
  });

  // ── Scenario 4: Fulfilled order cannot be cancelled ───────────────────────

  it('Scenario 4: Fulfilled order cancellation is rejected', async () => {
    // Arrange: qty=10
    await setInventory(bookId, locationId, 10);

    // Create + confirm + fulfill an order
    const createRes = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        branchId,
        locationId,
        channel: 'in_store',
        items: [{ bookId, quantity: 2, unitPrice: 100 }],
      });
    expect(createRes.status).toBe(201);
    const orderId = createRes.body.id ?? createRes.body.order?.id;

    await request(getTestApp())
      .post(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    const fulfillRes = await request(getTestApp())
      .post(`/api/orders/${orderId}/fulfill`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(fulfillRes.status).toBe(200);

    const qtyAfterFulfill = await getInventoryQty(bookId, locationId);
    expect(qtyAfterFulfill).toBe(8);

    // Act: attempt to cancel the fulfilled order
    const cancelRes = await request(getTestApp())
      .post(`/api/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Test' });

    // Assert: rejected with ORDER_ALREADY_FULFILLED
    expect(cancelRes.status).toBe(422);
    expect(cancelRes.body.error).toBe('ORDER_ALREADY_FULFILLED');

    // Assert: inventory unchanged
    const qtyAfterAttempt = await getInventoryQty(bookId, locationId);
    expect(qtyAfterAttempt).toBe(8);
  });

  // ── Scenario 5: Return increases stock at correct location ────────────────

  it('Scenario 5: Return increases stock and writes correct history', async () => {
    // Arrange: qty=5
    await setInventory(bookId, locationId, 5);

    // Create a completed POS transaction first
    const txRes = await request(getTestApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        branchId,
        locationId,
        items: [{ bookId, quantity: 1 }],
        payments: [{ method: 'cash', amount: 100 }],
      });
    expect(txRes.status).toBe(201);
    const txId = txRes.body.id ?? txRes.body.transaction?.id;
    expect(txId).toBeTruthy();

    const qtyAfterSale = await getInventoryQty(bookId, locationId);
    expect(qtyAfterSale).toBe(4);

    // Get the transaction line item id for the return
    const liRes = await db.query(
      `SELECT id FROM transaction_line_items WHERE transaction_id = $1 AND book_id = $2 LIMIT 1`,
      [txId, bookId],
    );
    expect(liRes.rows.length).toBeGreaterThan(0);
    const lineItemId = liRes.rows[0].id as number;

    // Act: process a return
    const returnRes = await request(getTestApp())
      .post('/api/returns')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        transactionId: txId,
        reason: 'Customer changed mind',
        refundMethod: 'cash',
        // POST /api/returns reads req.body.lines, not "items" -- confirmed
        // against the real request ReturnsPage.tsx sends (`lines: selectedLines`,
        // same { transactionLineItemId, quantity } shape). Test had the wrong key.
        lines: [{ transactionLineItemId: lineItemId, quantity: 1 }],
      });
    expect(returnRes.status).toBe(201);

    // Assert: stock restored to 5
    const qtyAfterReturn = await getInventoryQty(bookId, locationId);
    expect(qtyAfterReturn).toBe(5);

    // Assert: inventory_history row with correct fields
    const hist = await getLastHistoryRow(bookId, locationId);
    expect(hist).not.toBeNull();
    expect(hist!.movement_type).toBe('stock_in');
    expect(hist!.reference_type).toBe('pos_return');
    expect(Number(hist!.delta)).toBe(1);
    expect(hist!.staff_id).toBeTruthy();
  });
});
