/**
 * lifecycle-bugcondition.exploration.test.ts
 *
 * Bug Condition Exploration Property Tests
 * 
 * CRITICAL: These tests MUST FAIL on unfixed code — failure confirms the bugs exist.
 * DO NOT fix code or tests when they fail.
 * 
 * These tests validate the 5 bug conditions identified in the bugfix spec:
 * - C1: PARTIALLY_PAID orders have no allowed actions / fulfill double-deducts
 * - C2: FULFILLED CREDIT orders absent from listUnpaidOrders
 * - C4: cancel() does not restore inventory
 * - C5: Return disposition undifferentiated
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from '../../../tests/helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches } from '../../../tests/helpers/testDb.js';
import { createTestStaff, createTestBranch } from '../../../tests/helpers/seed.js';
import { db } from '../../../db/index.js';
import { computeOrderAllowedActions } from '../orders.service.js';

// Helpers
const STAFF_PREFIX = 'bug_test_';
const BRANCH_PREFIX = 'Bug Test ';

async function getOrCreateLocation(branchId: number): Promise<number> {
  const r = await db.query(
    `SELECT id FROM locations WHERE branch_id = $1 LIMIT 1`,
    [branchId],
  );
  if (r.rows.length) return r.rows[0].id as number;
  const c = await db.query(
    `INSERT INTO locations (branch_id, name, is_default_fulfillment)
     VALUES ($1, 'Bug Test Loc', true) RETURNING id`,
    [branchId],
  );
  return c.rows[0].id as number;
}

async function getActiveBook(): Promise<{ id: number; price: number }> {
  const r = await db.query(
    `SELECT id, default_price FROM books
     WHERE is_active = true AND default_price IS NOT NULL
     LIMIT 1`,
  );
  if (!r.rows.length) throw new Error('No active books with price found');
  return { id: r.rows[0].id as number, price: parseFloat(r.rows[0].default_price as string) };
}

async function setInventory(bookId: number, locationId: number, qty: number): Promise<void> {
  await db.query(
    `INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version)
     VALUES ($1, $2, $3, 5, 0)
     ON CONFLICT (book_id, location_id)
     DO UPDATE SET quantity = $3, version = inventory.version + 1, updated_at = now()`,
    [bookId, locationId, qty],
  );
  await db.query(
    `DELETE FROM inventory_reservations WHERE book_id = $1 AND location_id = $2`,
    [bookId, locationId],
  ).catch(() => { /* table may not exist */ });
}

async function getInventoryQty(bookId: number, locationId: number): Promise<number> {
  const r = await db.query(
    `SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`,
    [bookId, locationId],
  );
  return r.rows.length ? parseInt(r.rows[0].quantity as string, 10) : 0;
}

async function createCustomer(): Promise<number> {
  const r = await db.query(
    `INSERT INTO customers (full_name, customer_code, is_active)
     VALUES ('Bug Test Customer', 'BUG-TEST-001', true)
     ON CONFLICT (customer_code) DO UPDATE SET full_name = EXCLUDED.full_name
     RETURNING id`,
  );
  return r.rows[0].id as number;
}

async function createDraftOrder(
  token: string,
  branchId: number,
  locationId: number,
  bookId: number,
  quantity: number,
  saleType: 'cash_sale' | 'credit_sale' = 'credit_sale',
  customerId?: number,
): Promise<{ id: string; total: number; orderNumber: string }> {
  const body: Record<string, unknown> = { 
    locationId, 
    channel: 'in_store', 
    items: [{ bookId, quantity }], 
    saleType 
  };
  if (customerId) body.customerId = customerId;
  const res = await request(getTestApp())
    .post('/api/orders')
    .set('Authorization', `Bearer ${token}`)
    .set('X-Branch-Id', String(branchId))
    .send(body);
  if (res.status !== 201) throw new Error(`Order creation failed (${res.status}): ${JSON.stringify(res.body)}`);
  return { id: res.body.id, total: Number(res.body.total), orderNumber: res.body.orderNumber };
}

async function confirmOrder(token: string, branchId: number, orderId: string) {
  return request(getTestApp())
    .post(`/api/orders/${orderId}/confirm`)
    .set('Authorization', `Bearer ${token}`)
    .set('X-Branch-Id', String(branchId))
    .send({});
}

async function fulfillOrder(token: string, branchId: number, orderId: string) {
  return request(getTestApp())
    .post(`/api/orders/${orderId}/fulfill`)
    .set('Authorization', `Bearer ${token}`)
    .set('X-Branch-Id', String(branchId))
    .send({});
}

async function cancelOrder(token: string, branchId: number, orderId: string, reason = 'Test cancellation') {
  return request(getTestApp())
    .post(`/api/orders/${orderId}/cancel`)
    .set('Authorization', `Bearer ${token}`)
    .set('X-Branch-Id', String(branchId))
    .send({ reason });
}

async function createPayment(token: string, branchId: number, orderId: string, amount: number) {
  return request(getTestApp())
    .post('/api/payments')
    .set('Authorization', `Bearer ${token}`)
    .set('X-Branch-Id', String(branchId))
    .send({ orderId: Number(orderId), amount, paymentMethod: 'cash' });
}

async function listUnpaidOrders(token: string, branchId: number) {
  return request(getTestApp())
    .get('/api/payments/unpaid-orders')
    .set('Authorization', `Bearer ${token}`)
    .set('X-Branch-Id', String(branchId));
}

async function createReturn(
  token: string,
  branchId: number,
  orderId: string,
  transactionLineItemId: number,
  quantity: number,
  disposition?: 'SELLABLE' | 'DAMAGED',
) {
  const body: Record<string, unknown> = {
    orderId: Number(orderId),
    refundMethod: 'cash',
    lines: [{ transactionLineItemId, quantity }],
  };
  if (disposition) body.disposition = disposition;
  
  return request(getTestApp())
    .post('/api/returns')
    .set('Authorization', `Bearer ${token}`)
    .set('X-Branch-Id', String(branchId))
    .send(body);
}

async function cleanOrders(branchId: number): Promise<void> {
  await db.query(`DELETE FROM order_refunds WHERE payment_id IN (SELECT id FROM order_payments WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1))`, [branchId]).catch(() => {});
  await db.query(`DELETE FROM order_payments WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`, [branchId]).catch(() => {});
  await db.query(`DELETE FROM inventory_reservations WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`, [branchId]).catch(() => {});
  await db.query(`DELETE FROM receivables WHERE branch_id = $1`, [branchId]).catch(() => {});
  await db.query(`DELETE FROM order_line_items WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`, [branchId]);
  await db.query(`DELETE FROM orders WHERE branch_id = $1`, [branchId]);
  // Clean POS returns and transactions
  await db.query(`DELETE FROM return_line_items WHERE return_id IN (SELECT id FROM returns WHERE transaction_id IN (SELECT id FROM transactions WHERE branch_id = $1))`, [branchId]).catch(() => {});
  await db.query(`DELETE FROM returns WHERE transaction_id IN (SELECT id FROM transactions WHERE branch_id = $1)`, [branchId]).catch(() => {});
  await db.query(`DELETE FROM transaction_payments WHERE transaction_id IN (SELECT id FROM transactions WHERE branch_id = $1)`, [branchId]).catch(() => {});
  await db.query(`DELETE FROM transaction_line_items WHERE transaction_id IN (SELECT id FROM transactions WHERE branch_id = $1)`, [branchId]).catch(() => {});
  await db.query(`DELETE FROM transactions WHERE branch_id = $1`, [branchId]).catch(() => {});
}

// Suite
describe('Bug Condition Exploration: Order–Payment–Inventory Lifecycle', () => {
  let managerToken: string;
  let branchId: number;
  let locationId: number;
  let bookId: number;
  let bookPrice: number;
  let customerId: number;

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    const oldBranches = await db.query(`SELECT id FROM branches WHERE name LIKE $1`, [`${BRANCH_PREFIX}%`]);
    for (const row of oldBranches.rows) {
      const bid = row.id as number;
      await cleanOrders(bid);
      await db.query(`DELETE FROM transaction_line_items WHERE transaction_id IN (SELECT id FROM transactions WHERE branch_id = $1)`, [bid]).catch(() => {});
      await db.query(`DELETE FROM transaction_payments WHERE transaction_id IN (SELECT id FROM transactions WHERE branch_id = $1)`, [bid]).catch(() => {});
      await db.query(`DELETE FROM transactions WHERE branch_id = $1`, [bid]).catch(() => {});
      await db.query(`DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id = $1)`, [bid]).catch(() => {});
      await db.query(`DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id = $1)`, [bid]).catch(() => {});
      await db.query(`DELETE FROM inventory_reservations WHERE location_id IN (SELECT id FROM locations WHERE branch_id = $1)`, [bid]).catch(() => {});
    }
    await cleanTestBranches(BRANCH_PREFIX);

    const branch = await createTestBranch({ name: `${BRANCH_PREFIX}Branch` });
    branchId = branch.branchId;
    const mgr = await createTestStaff({ username: `${STAFF_PREFIX}mgr`, role: 'Manager', branchId });
    managerToken = mgr.token;
    locationId = await getOrCreateLocation(branchId);

    const book = await getActiveBook();
    bookId = book.id;
    bookPrice = book.price;
    await db.query(
      `INSERT INTO book_branch_prices (book_id, branch_id, format_id, edition_id, price)
       VALUES ($1, $2, 0, 0, $3)
       ON CONFLICT (book_id, branch_id, format_id, edition_id) DO NOTHING`,
      [bookId, branchId, bookPrice.toFixed(2)],
    );

    customerId = await createCustomer();
  });

  afterAll(async () => {
    await cleanOrders(branchId);
    // Clean POS transaction rows that reference this branch's locations
    await db.query(
      `DELETE FROM transaction_line_items WHERE transaction_id IN (SELECT id FROM transactions WHERE branch_id = $1)`,
      [branchId],
    ).catch(() => {});
    await db.query(
      `DELETE FROM transaction_payments WHERE transaction_id IN (SELECT id FROM transactions WHERE branch_id = $1)`,
      [branchId],
    ).catch(() => {});
    await db.query(`DELETE FROM transactions WHERE branch_id = $1`, [branchId]).catch(() => {});
    await db.query(`DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id = $1)`, [branchId]).catch(() => {});
    await db.query(`DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id = $1)`, [branchId]).catch(() => {});
    await db.query(`DELETE FROM inventory_reservations WHERE location_id IN (SELECT id FROM locations WHERE branch_id = $1)`, [branchId]).catch(() => {});
    await db.query(`DELETE FROM receivables WHERE branch_id = $1`, [branchId]).catch(() => {});
    await db.query(`DELETE FROM customers WHERE id = $1`, [customerId]).catch(() => {});
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Task 1.1 — Bug Condition C1: PARTIALLY_PAID orders have no allowed actions
  // ────────────────────────────────────────────────────────────────────────────
  it('1.1 Bug Condition C1 — PARTIALLY_PAID orders have no allowed actions', async () => {
    await setInventory(bookId, locationId, 50);

    // Create CREDIT order
    const order = await createDraftOrder(managerToken, branchId, locationId, bookId, 5, 'credit_sale', customerId);
    
    // Confirm it
    await confirmOrder(managerToken, branchId, order.id);
    
    // Record partial payment
    await createPayment(managerToken, branchId, order.id, order.total / 2);
    
    // Check order payment_status
    const orderRes = await request(getTestApp())
      .get(`/api/orders/${order.id}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));
    
    expect(orderRes.body.paymentStatus).toBe('partial');
    
    // Call computeOrderAllowedActions('PARTIALLY_PAID', ...)
    // EXPECTED: Returns empty array [] on unfixed code (falls through to default)
    // AFTER FIX: Should return ['cancel', 'fulfill']
    const actions = computeOrderAllowedActions('PARTIALLY_PAID', ['CREATE_SALE', 'PROCESS_PAYMENT'], 'partial', 'credit_sale');
    
    // BUG: This assertion will FAIL on unfixed code
    expect(actions).toContain('fulfill');
    expect(actions).toContain('cancel');
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Task 1.2 — Bug Condition C1: fulfill() double-deducts stock
  // ────────────────────────────────────────────────────────────────────────────
  it('1.2 Bug Condition C1 — fulfill() double-deducts stock', async () => {
    await setInventory(bookId, locationId, 20);
    const qtyBefore = await getInventoryQty(bookId, locationId);

    // Create CREDIT order for 5 units
    const order = await createDraftOrder(managerToken, branchId, locationId, bookId, 5, 'credit_sale', customerId);
    
    // Confirm (SHOULD deduct stock by 5)
    await confirmOrder(managerToken, branchId, order.id);
    const qtyAfterConfirm = await getInventoryQty(bookId, locationId);
    
    // In the unfixed code, confirm() calls invTxSvc.stockOut() but it's done through reservation
    // Let's check the actual behavior
    console.log(`Before: ${qtyBefore}, After Confirm: ${qtyAfterConfirm}`);
    
    // Fulfill the order
    await fulfillOrder(managerToken, branchId, order.id);
    const qtyAfterFulfill = await getInventoryQty(bookId, locationId);
    
    console.log(`After Fulfill: ${qtyAfterFulfill}`);
    
    // Current model (order-payment-unification spec, 3.5): confirm() deducts
    // inventory.quantity immediately via stockOut() AND inserts a 'reserved'
    // row, in the same transaction. fulfill() calls fulfillReservation(),
    // which writes a delta=0 audit row and transitions the reservation to
    // 'deducted' -- it does NOT deduct again. So:
    //   qtyAfterFulfill === qtyAfterConfirm (no double-deduction at fulfill — correct)
    //   qtyBefore - qtyAfterFulfill === the order quantity (5), deducted once, at confirm
    expect(qtyAfterFulfill).toBe(qtyAfterConfirm);
    expect(qtyBefore - qtyAfterFulfill).toBe(5);
    
    // Verify fulfillReservation() wrote an audit row with delta=0
    const fulfillHist = await db.query(
      `SELECT delta FROM inventory_history WHERE reference_id = $1 AND reference_type = 'order_fulfilled'`,
      [order.id],
    );
    expect(fulfillHist.rows.length).toBeGreaterThan(0);
    expect(Number(fulfillHist.rows[0].delta)).toBe(0);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Task 1.3 — Bug Condition C2: FULFILLED CREDIT order absent from listUnpaidOrders()
  // ────────────────────────────────────────────────────────────────────────────
  it('1.3 Bug Condition C2 — FULFILLED CREDIT order absent from listUnpaidOrders()', async () => {
    await setInventory(bookId, locationId, 50);

    // Create CREDIT order
    const order = await createDraftOrder(managerToken, branchId, locationId, bookId, 3, 'credit_sale', customerId);
    
    // Confirm → Fulfill (order now COMPLETED with payment_status = 'unpaid')
    await confirmOrder(managerToken, branchId, order.id);
    await fulfillOrder(managerToken, branchId, order.id);
    
    // Check order status and payment_status
    const orderRes = await request(getTestApp())
      .get(`/api/orders/${order.id}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));
    
    expect(orderRes.body.status).toBe('COMPLETED');
    expect(orderRes.body.paymentStatus).toBe('unpaid');
    
    // Call listUnpaidOrders() — SHOULD include this order
    const unpaidRes = await listUnpaidOrders(managerToken, branchId);
    
    const orderNumbers = unpaidRes.body.items.map((item: Record<string, unknown>) => item.orderNumber);
    
    // BUG: This assertion will FAIL on unfixed code (COMPLETED orders excluded from query)
    // EXPECTED AFTER FIX: Order DOES appear in pending payments list
    expect(orderNumbers).toContain(order.orderNumber);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Task 1.4 — Bug Condition C4: cancel() does not restore inventory
  // ────────────────────────────────────────────────────────────────────────────
  it('1.4 Bug Condition C4 — cancel() does not restore inventory', async () => {
    await setInventory(bookId, locationId, 30);
    const qtyBefore = await getInventoryQty(bookId, locationId);

    // Create and confirm order (stock deducted)
    const order = await createDraftOrder(managerToken, branchId, locationId, bookId, 4, 'credit_sale', customerId);
    await confirmOrder(managerToken, branchId, order.id);
    
    const qtyAfterConfirm = await getInventoryQty(bookId, locationId);
    
    // Cancel the order
    await cancelOrder(managerToken, branchId, order.id);
    
    const qtyAfterCancel = await getInventoryQty(bookId, locationId);
    
    console.log(`Before: ${qtyBefore}, After Confirm: ${qtyAfterConfirm}, After Cancel: ${qtyAfterCancel}`);
    
    // Current model (order-payment-unification spec, 3.5; cancel()'s own
    // "Fix 9.4" comment): confirm() deducts inventory.quantity immediately,
    // so cancel() on a CONFIRMED/PARTIALLY_PAID/PAID order restores it via
    // stockIn() -- hasDeductedStock is unconditionally true for those
    // statuses ("stockOut ran at confirm() time for all of them"). Net
    // effect is still qtyAfterCancel === qtyBefore, but via deduct-then-
    // restore rather than "never touched".
    expect(qtyAfterCancel).toBe(qtyBefore);

    // The stockIn() restoration writes an audit row with reference_type
    // 'order_cancelled' -- there should be exactly one.
    const hist = await db.query(
      `SELECT * FROM inventory_history WHERE reference_type = 'order_cancelled' AND reference_id = $1`,
      [order.id],
    );
    expect(hist.rows.length).toBe(1);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Task 1.5 — Bug Condition C5: Return disposition undifferentiated
  //
  // BUG: ReturnLineInput has no `disposition` field.
  //      createReturn() ALWAYS calls invTxSvc.stockIn() unconditionally,
  //      so DAMAGED returns incorrectly restore sellable stock.
  //
  // To prove this at runtime we:
  //   1. Create a POS cash sale (deducts stock)
  //   2. Submit a return with disposition='DAMAGED' in the request body
  //   3. On UNFIXED code: invTxSvc.stockIn() is called → inventory.quantity increases
  //      The test asserts quantity did NOT increase → FAILS (confirms bug)
  //   4. After fix: disposition='DAMAGED' updates damaged_quantity only → test PASSES
  // ────────────────────────────────────────────────────────────────────────────
  it('1.5 Bug Condition C5 — Return disposition undifferentiated', async () => {
    const INITIAL_QTY = 50;
    await setInventory(bookId, locationId, INITIAL_QTY);

    // Step 1: Create a POS cash sale for 2 units
    const saleQty = 2;
    const saleTotal = parseFloat((bookPrice * saleQty).toFixed(2));
    const saleRes = await request(getTestApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        branchId,
        locationId,
        items: [{ bookId, quantity: saleQty }],
        payments: [{ method: 'cash', amount: saleTotal }],
      });
    expect(saleRes.status).toBe(201);
    const txId: number = saleRes.body.id as number;
    const lineItemId: number = (saleRes.body.lineItems as Array<{ id: number }>)[0].id;

    const qtyAfterSale = await getInventoryQty(bookId, locationId);
    // Sale should have deducted stock
    expect(qtyAfterSale).toBe(INITIAL_QTY - saleQty);

    // Step 2: Submit a return with disposition='DAMAGED'
    // On UNFIXED code: ReturnLineInput has no disposition field, so it is silently ignored
    // and invTxSvc.stockIn() is called unconditionally → sellable stock is restored
    const returnRes = await request(getTestApp())
      .post('/api/returns')
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        transactionId: txId,
        refundMethod: 'cash',
        lines: [{ transactionLineItemId: lineItemId, quantity: 1, disposition: 'DAMAGED' }],
      });
    // Return should succeed (200/201) on both fixed and unfixed code
    expect(returnRes.status).toBe(201);

    const qtyAfterReturn = await getInventoryQty(bookId, locationId);

    // BUG ASSERTION: On unfixed code, stockIn() is called unconditionally.
    // → inventory.quantity increases back (from 48 → 49), so qtyAfterReturn > qtyAfterSale.
    // This assertion FAILS on unfixed code (confirms the bug exists).
    //
    // AFTER FIX: disposition='DAMAGED' routes to damaged_quantity update, NOT stockIn().
    // → inventory.quantity remains unchanged at qtyAfterSale (48).
    expect(qtyAfterReturn).toBe(qtyAfterSale); // FAILS on unfixed code
  });
});
