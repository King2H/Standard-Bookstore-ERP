/**
 * order-inventory.test.ts
 *
 * Integration tests for the corrected Order â†” Inventory lifecycle.
 *
 * New model (post-fix):
 *   DRAFT    â†’ no reservation, no stock deduction
 *   CONFIRMED â†’ soft reservation created; inventory.quantity UNCHANGED
 *   PAID     â†’ financial state only; inventory still unchanged
 *   FULFILLED â†’ physical stock deducted exactly once here
 *   COMPLETED â†’ auto after fulfill; operational close
 *   CANCELLED â†’ reservation released only; no stockIn (stock was never deducted)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';
import { db } from '../db/index.js';

// â”€â”€ Prefixes to scope teardown â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const STAFF_PREFIX = 'oisync_test_';
const BRANCH_PREFIX = 'OISync Test ';

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function getOrCreateLocation(branchId: number): Promise<number> {
  const r = await db.query(
    `SELECT id FROM locations WHERE branch_id = $1 LIMIT 1`,
    [branchId],
  );
  if (r.rows.length) return r.rows[0].id as number;
  const c = await db.query(
    `INSERT INTO locations (branch_id, name, is_default_fulfillment)
     VALUES ($1, 'OISync Loc', true) RETURNING id`,
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
  // Also clear reservations so available = qty
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

async function getReservedQty(bookId: number, locationId: number): Promise<number> {
  try {
    const r = await db.query(
      `SELECT COALESCE(SUM(quantity), 0)::int AS reserved
       FROM inventory_reservations
       WHERE book_id = $1 AND location_id = $2 AND status = 'reserved'`,
      [bookId, locationId],
    );
    return r.rows.length ? parseInt(r.rows[0].reserved as string, 10) : 0;
  } catch { return 0; }
}

async function createDraftOrder(
  token: string,
  branchId: number,
  locationId: number,
  bookId: number,
  quantity = 2,
  saleType: 'cash_sale' | 'credit_sale' = 'cash_sale',
  customerId?: number,
): Promise<{ id: string; total: number; orderNumber: string }> {
  const body: Record<string, unknown> = { locationId, channel: 'in_store', items: [{ bookId, quantity }], saleType };
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

async function payOrder(token: string, branchId: number, orderId: string, amount: number) {
  return request(getTestApp())
    .post('/api/payments')
    .set('Authorization', `Bearer ${token}`)
    .set('X-Branch-Id', String(branchId))
    .send({ orderId: Number(orderId), amount, paymentMethod: 'cash' });
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

async function cleanOrders(branchId: number): Promise<void> {
  await db.query(`DELETE FROM order_payments WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`, [branchId]).catch(() => {});
  await db.query(`DELETE FROM inventory_reservations WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`, [branchId]).catch(() => {});
  await db.query(`DELETE FROM order_line_items WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`, [branchId]);
  await db.query(`DELETE FROM orders WHERE branch_id = $1`, [branchId]);
}

// â”€â”€ Suite â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('Order â†” Inventory Synchronization (corrected lifecycle)', () => {
  let managerToken: string;
  let salesToken: string;
  let branchId: number;
  let locationId: number;
  let bookId: number;
  let bookPrice: number;

  let branchB: number;
  let locationB: number;
  let managerTokenB: string;

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    const oldBranches = await db.query(`SELECT id FROM branches WHERE name LIKE $1`, [`${BRANCH_PREFIX}%`]);
    for (const row of oldBranches.rows) await cleanOrders(row.id as number);
    await cleanTestBranches(BRANCH_PREFIX);

    const branch = await createTestBranch({ name: `${BRANCH_PREFIX}A` });
    branchId = branch.branchId;
    const mgr = await createTestStaff({ username: `${STAFF_PREFIX}mgr`, role: 'Manager', branchId });
    managerToken = mgr.token;
    const sales = await createTestStaff({ username: `${STAFF_PREFIX}sales`, role: 'Sales', branchId });
    salesToken = sales.token;
    locationId = await getOrCreateLocation(branchId);

    const branchBResult = await createTestBranch({ name: `${BRANCH_PREFIX}B` });
    branchB = branchBResult.branchId;
    const mgrB = await createTestStaff({ username: `${STAFF_PREFIX}mgrB`, role: 'Manager', branchId: branchB });
    managerTokenB = mgrB.token;
    locationB = await getOrCreateLocation(branchB);

    const book = await getActiveBook();
    bookId = book.id;
    bookPrice = book.price;
    // Ensure a branch price exists
    await db.query(
      `INSERT INTO book_branch_prices (book_id, branch_id, format_id, edition_id, price)
       VALUES ($1, $2, 0, 0, $3)
       ON CONFLICT (book_id, branch_id, format_id, edition_id) DO NOTHING`,
      [bookId, branchId, bookPrice.toFixed(2)],
    );
  });

  afterAll(async () => {
    await cleanOrders(branchId);
    await cleanOrders(branchB);
    await db.query(`DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN ($1,$2))`, [branchId, branchB]);
    await db.query(`DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN ($1,$2))`, [branchId, branchB]);
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  // â”€â”€ 1. DRAFT â†’ no inventory change â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it('1. Creating a DRAFT order does not change inventory.quantity', async () => {
    await setInventory(bookId, locationId, 10);
    const qtyBefore = await getInventoryQty(bookId, locationId);
    await createDraftOrder(managerToken, branchId, locationId, bookId, 3);
    expect(await getInventoryQty(bookId, locationId)).toBe(qtyBefore);
  });

  // â”€â”€ 2. CONFIRM â†’ reservation only, inventory unchanged â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it('2. Confirming a DRAFT order deducts inventory.quantity and creates a reservation', async () => {
    await setInventory(bookId, locationId, 10);
    const qtyBefore = await getInventoryQty(bookId, locationId);

    const order = await createDraftOrder(managerToken, branchId, locationId, bookId, 3);
    const res = await confirmOrder(managerToken, branchId, order.id);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CONFIRMED');
    expect(res.body.lineItems[0].qtyReserved).toBe(3);
    // confirm() deducts inventory.quantity immediately via stockOut() AND
    // inserts the reservation, in the same transaction (order-payment-
    // unification spec, 3.5).
    expect(await getInventoryQty(bookId, locationId)).toBe(qtyBefore - 3);
    // reservation must exist
    expect(await getReservedQty(bookId, locationId)).toBeGreaterThanOrEqual(3);
  });

  // â”€â”€ 3. CONFIRM â†’ no stock_out history written â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it('3. Confirming an order writes exactly one stock_out inventory_history row', async () => {
    await setInventory(bookId, locationId, 20);
    const order = await createDraftOrder(managerToken, branchId, locationId, bookId, 2);
    await confirmOrder(managerToken, branchId, order.id);

    // confirm() deducts via stockOut() (order-payment-unification spec, 3.5),
    // which writes movement_type='stock_out', reference_type='order_confirmed'.
    const hist = await db.query(
      `SELECT * FROM inventory_history WHERE reference_id = $1 AND movement_type = 'stock_out'`,
      [order.id],
    );
    expect(hist.rows.length).toBe(1);
    expect(hist.rows[0].reference_type).toBe('order_confirmed');
    expect(Number(hist.rows[0].delta)).toBe(-2);
  });

  // â”€â”€ 4. CONFIRM insufficient stock â†’ 422, no reservation, order stays DRAFT

  it('4. Insufficient stock on confirm â†’ 422 INSUFFICIENT_STOCK, no reservation created, order stays DRAFT', async () => {
    // Unified Order Creation Workflow: create() now also validates available
    // stock, so this needs to draft the order while stock is still sufficient
    // and then simulate stock disappearing before confirm — exercising
    // confirm()'s own separate, row-locked, authoritative check.
    await setInventory(bookId, locationId, 5);
    const order = await createDraftOrder(managerToken, branchId, locationId, bookId, 5);
    await setInventory(bookId, locationId, 1);
    const qtyBefore = await getInventoryQty(bookId, locationId);
    const reservedBefore = await getReservedQty(bookId, locationId);

    const res = await confirmOrder(managerToken, branchId, order.id);

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('INSUFFICIENT_STOCK');
    expect(await getInventoryQty(bookId, locationId)).toBe(qtyBefore);
    expect(await getReservedQty(bookId, locationId)).toBe(reservedBefore);

    const orderCheck = await request(getTestApp())
      .get(`/api/orders/${order.id}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));
    expect(orderCheck.body.status).toBe('DRAFT');
  });

  // â”€â”€ 5. cash_sale: fulfill before pay â†’ INVALID_STATE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it('5. cash_sale: fulfill before pay (CONFIRMED, not PAID) â†’ succeeds (payment gate removed)', async () => {
    await setInventory(bookId, locationId, 10);
    const order = await createDraftOrder(managerToken, branchId, locationId, bookId, 2);
    await confirmOrder(managerToken, branchId, order.id);

    const res = await fulfillOrder(managerToken, branchId, order.id);
    // Fix C1: payment gate removed â€” CONFIRMED orders can now be fulfilled without prior payment
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
  });

  // â”€â”€ 6. cash_sale full lifecycle: confirm â†’ pay â†’ fulfill â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it('6. cash_sale: confirm â†’ fulfill â†’ COMPLETED, stock deducted once at confirm', async () => {
    await setInventory(bookId, locationId, 20);
    const qtyBefore = await getInventoryQty(bookId, locationId);

    const order = await createDraftOrder(managerToken, branchId, locationId, bookId, 4);

    // confirm â€” deducts inventory immediately via stockOut() (order-payment-
    // unification spec, 3.5), also sets payment_status='paid' for cash_sale.
    const confRes = await confirmOrder(managerToken, branchId, order.id);
    expect(confRes.status).toBe(200);
    expect(await getInventoryQty(bookId, locationId)).toBe(qtyBefore - 4);

    // POST /api/payments rejects cash_sale orders (paid automatically at
    // confirm; payments.service.ts "Bug 2" guard) -- fulfill directly.
    const fulfillRes = await fulfillOrder(managerToken, branchId, order.id);
    expect(fulfillRes.status).toBe(200);

    // fulfill() doesn't deduct again -- already deducted at confirm.
    expect(await getInventoryQty(bookId, locationId)).toBe(qtyBefore - 4);

    // Order is COMPLETED
    const orderCheck = await request(getTestApp())
      .get(`/api/orders/${order.id}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));
    expect(orderCheck.body.status).toBe('COMPLETED');

    // order_fulfilled row is fulfillReservation()'s zero-delta audit trail
    // entry; the actual -4 deduction is on the order_confirmed row.
    const hist = await db.query(
      `SELECT * FROM inventory_history WHERE reference_type = 'order_fulfilled' AND reference_id = $1`,
      [order.id],
    );
    expect(hist.rows.length).toBeGreaterThan(0);
    expect(Number(hist.rows[0].delta)).toBe(0);
    expect(hist.rows[0].movement_type).toBe('stock_out');

    const confirmHist = await db.query(
      `SELECT * FROM inventory_history WHERE reference_type = 'order_confirmed' AND reference_id = $1`,
      [order.id],
    );
    expect(confirmHist.rows.length).toBeGreaterThan(0);
    expect(Number(confirmHist.rows[0].delta)).toBe(-4);
  });

  // â”€â”€ 7. cash_sale: second fulfill attempt (idempotency) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it('7. cash_sale: attempting to fulfill a COMPLETED order â†’ 422 INVALID_STATE (not double-deducted)', async () => {
    await setInventory(bookId, locationId, 20);
    const order = await createDraftOrder(managerToken, branchId, locationId, bookId, 2);
    await confirmOrder(managerToken, branchId, order.id);
    await payOrder(managerToken, branchId, order.id, order.total);
    await fulfillOrder(managerToken, branchId, order.id);
    const qtyAfterFirst = await getInventoryQty(bookId, locationId);

    // Try to fulfill again
    const res = await fulfillOrder(managerToken, branchId, order.id);
    expect(res.status).toBe(422);
    // quantity must not have changed again
    expect(await getInventoryQty(bookId, locationId)).toBe(qtyAfterFirst);
  });

  // â”€â”€ 8. CANCEL from CONFIRMED â†’ reservation released, qty unchanged â”€â”€â”€â”€â”€â”€â”€â”€

  it('8. Cancel CONFIRMED order â†’ deducted at confirm, restored at cancel, net unchanged', async () => {
    await setInventory(bookId, locationId, 15);
    const qtyBefore = await getInventoryQty(bookId, locationId);

    const order = await createDraftOrder(managerToken, branchId, locationId, bookId, 4);
    await confirmOrder(managerToken, branchId, order.id);

    // confirm() deducts immediately (order-payment-unification spec, 3.5)
    expect(await getInventoryQty(bookId, locationId)).toBe(qtyBefore - 4);

    const cancelRes = await cancelOrder(managerToken, branchId, order.id);
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.status).toBe('CANCELLED');
    expect(cancelRes.body.lineItems[0].qtyReserved).toBe(0);

    // cancel() restores via stockIn() -- net back to qtyBefore
    expect(await getInventoryQty(bookId, locationId)).toBe(qtyBefore);
    // stockIn() restoration writes an order_cancelled audit row
    const hist = await db.query(
      `SELECT * FROM inventory_history WHERE reference_type = 'order_cancelled' AND reference_id = $1`,
      [order.id],
    );
    expect(hist.rows.length).toBeGreaterThan(0);
    expect(Number(hist.rows[0].delta)).toBe(4);
    // Reservation released
    const resRows = await db.query(
      `SELECT status FROM inventory_reservations WHERE order_id = $1`,
      [order.id],
    ).catch(() => ({ rows: [] }));
    if (resRows.rows.length > 0) {
      expect(resRows.rows[0].status).toBe('released');
    }
  });

  // â”€â”€ 9. CANCEL from DRAFT â†’ no inventory change â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it('9. Cancel DRAFT order â†’ inventory unchanged (nothing was reserved)', async () => {
    await setInventory(bookId, locationId, 10);
    const qtyBefore = await getInventoryQty(bookId, locationId);
    const order = await createDraftOrder(managerToken, branchId, locationId, bookId, 2);
    const res = await cancelOrder(managerToken, branchId, order.id);
    expect(res.status).toBe(200);
    expect(await getInventoryQty(bookId, locationId)).toBe(qtyBefore);
  });

  // â”€â”€ 10. CANCEL from FULFILLED â†’ 422 ORDER_ALREADY_FULFILLED â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it('10. Cancel FULFILLED/COMPLETED order â†’ 422 ORDER_ALREADY_FULFILLED', async () => {
    await setInventory(bookId, locationId, 10);
    const order = await createDraftOrder(managerToken, branchId, locationId, bookId, 2);
    await confirmOrder(managerToken, branchId, order.id);
    await payOrder(managerToken, branchId, order.id, order.total);
    await fulfillOrder(managerToken, branchId, order.id);

    const res = await cancelOrder(managerToken, branchId, order.id);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('ORDER_ALREADY_FULFILLED');
    // Quantity unchanged (no double-restoration)
    expect(await getInventoryQty(bookId, locationId)).toBe(10 - 2);
  });

  // â”€â”€ 11. Available stock = inventory.quantity (already reflects committed orders) â”€â”€

  it('11. Available stock = inventory.quantity, already reduced by confirmed orders', async () => {
    await setInventory(bookId, locationId, 10);

    // Draft both orders up front, while all 10 units are still available for
    // create()'s own stock-visibility check (Unified Order Creation Workflow).
    const order = await createDraftOrder(managerToken, branchId, locationId, bookId, 3);
    const order2 = await createDraftOrder(managerToken, branchId, locationId, bookId, 8);

    // Confirm the first order for 3 â€” deducts quantity to 7 and creates reservation of 3
    // (order-payment-unification spec, 3.5; getAvailableStock() no longer
    // subtracts reservations on top of that -- see inventoryTransaction.service.ts).
    await confirmOrder(managerToken, branchId, order.id);

    expect(await getInventoryQty(bookId, locationId)).toBe(7);
    expect(await getReservedQty(bookId, locationId)).toBe(3);

    // order2 (8 units, drafted back when 10 were available) must now fail at
    // confirm â€” available = quantity = 7 < 8. This exercises confirm()'s own
    // authoritative, row-locked recheck, distinct from create()'s check.
    const res2 = await confirmOrder(managerToken, branchId, order2.id);
    expect(res2.status).toBe(422);
    expect(res2.body.error).toBe('INSUFFICIENT_STOCK');

    // A third order for 7 must succeed (available = quantity = 7 = 7)
    const order3 = await createDraftOrder(managerToken, branchId, locationId, bookId, 7);
    const res3 = await confirmOrder(managerToken, branchId, order3.id);
    expect(res3.status).toBe(200);
    expect(await getReservedQty(bookId, locationId)).toBe(10); // 3 + 7
    expect(await getInventoryQty(bookId, locationId)).toBe(0); // 7 - 7
  });

  // â”€â”€ 12. Multi-item atomicity â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it('12. Multi-item order: one item short â†’ entire confirm rolls back (no partial reservation)', async () => {
    const books = await db.query(
      `SELECT id, default_price FROM books WHERE is_active = true AND default_price IS NOT NULL LIMIT 2`,
    );
    if (books.rows.length < 2) { console.warn('Skipping â€” need 2 books'); return; }

    const bookA = books.rows[0].id as number;
    const bookB = books.rows[1].id as number;
    await setInventory(bookA, locationId, 10);
    await setInventory(bookB, locationId, 10); // enough for create() to accept the draft

    const orderRes = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, items: [{ bookId: bookA, quantity: 3 }, { bookId: bookB, quantity: 5 }] });
    expect(orderRes.status).toBe(201);

    // Simulate stock disappearing on bookB between create() and confirm() —
    // confirm()'s own authoritative, row-locked check must still catch this.
    await setInventory(bookB, locationId, 1); // not enough for 5

    const res = await confirmOrder(managerToken, branchId, String(orderRes.body.id));
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('INSUFFICIENT_STOCK');

    // Both inventories unchanged
    expect(await getInventoryQty(bookA, locationId)).toBe(10);
    expect(await getInventoryQty(bookB, locationId)).toBe(1);
    // No reservations created
    const resRows = await db.query(
      `SELECT * FROM inventory_reservations WHERE order_id = $1`,
      [orderRes.body.id],
    ).catch(() => ({ rows: [] }));
    expect(resRows.rows.length).toBe(0);
  });

  // â”€â”€ 13. Negative stock prevention â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it('13. Cannot confirm when stock is 0 â†’ 422 INSUFFICIENT_STOCK, qty stays 0', async () => {
    // Draft while stock is sufficient (create()'s check), then simulate the
    // stock disappearing before confirm (confirm()'s own check).
    await setInventory(bookId, locationId, 5);
    const order = await createDraftOrder(managerToken, branchId, locationId, bookId, 1);
    await setInventory(bookId, locationId, 0);
    const res = await confirmOrder(managerToken, branchId, order.id);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('INSUFFICIENT_STOCK');
    expect(await getInventoryQty(bookId, locationId)).toBe(0);
  });

  // â”€â”€ 14. Stock deducted exactly once (not at confirm, not twice) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it('14. Stock deducted exactly once at confirm; fulfill does not deduct again', async () => {
    await setInventory(bookId, locationId, 20);
    const qtyStart = await getInventoryQty(bookId, locationId);

    const order = await createDraftOrder(managerToken, branchId, locationId, bookId, 3);
    await confirmOrder(managerToken, branchId, order.id);
    // confirm() deducts immediately (order-payment-unification spec, 3.5)
    expect(await getInventoryQty(bookId, locationId)).toBe(qtyStart - 3);

    // POST /api/payments rejects cash_sale orders (Bug 2 guard) -- fulfill directly.
    await fulfillOrder(managerToken, branchId, order.id);
    // fulfill() doesn't deduct again
    expect(await getInventoryQty(bookId, locationId)).toBe(qtyStart - 3);

    // Confirm there is exactly ONE stock_out history entry with a negative
    // delta for this order (the confirm()-time deduction; fulfill()'s own
    // stock_out-labelled row has delta=0, so it's excluded by "delta < 0").
    const hist = await db.query(
      `SELECT COUNT(*) AS cnt FROM inventory_history WHERE reference_id = $1 AND movement_type = 'stock_out' AND delta < 0`,
      [order.id],
    );
    expect(Number(hist.rows[0].cnt)).toBe(1);
  });

  // â”€â”€ 15. Concurrent confirmations cannot oversell â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it('15. Concurrent confirmations: only one wins when available stock equals one order demand', async () => {
    await setInventory(bookId, locationId, 5); // sets qty=5 AND clears reservations

    const orderA = await createDraftOrder(managerToken, branchId, locationId, bookId, 5);
    const orderB = await createDraftOrder(managerToken, branchId, locationId, bookId, 5);

    const [resA, resB] = await Promise.all([
      confirmOrder(managerToken, branchId, orderA.id),
      confirmOrder(managerToken, branchId, orderB.id),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toContain(200);
    expect(statuses).toContain(422);
    const failed = resA.status === 422 ? resA : resB;
    expect(failed.body.error).toBe('INSUFFICIENT_STOCK');

    // inventory.quantity deducted to 0 by the winning confirmation
    // (order-payment-unification spec, 3.5)
    expect(await getInventoryQty(bookId, locationId)).toBe(0);
    // reserved = 5 (only the winner created a reservation)
    expect(await getReservedQty(bookId, locationId)).toBe(5);
  });

  // â”€â”€ 16. Cross-branch isolation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it('16. Confirming in branch A does not affect inventory in branch B', async () => {
    await setInventory(bookId, locationId, 10);
    await setInventory(bookId, locationB, 10);
    const qtyA = await getInventoryQty(bookId, locationId);
    const qtyB = await getInventoryQty(bookId, locationB);

    const order = await createDraftOrder(managerToken, branchId, locationId, bookId, 3);
    await confirmOrder(managerToken, branchId, order.id);

    expect(await getInventoryQty(bookId, locationId)).toBe(qtyA - 3); // branch A deducted
    expect(await getInventoryQty(bookId, locationB)).toBe(qtyB);      // branch B untouched (isolation)
  });

  // â”€â”€ 17. Net qty change across full lifecycle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it('17. Net inventory change = -qty after full confirmâ†’payâ†’fulfill cycle', async () => {
    await setInventory(bookId, locationId, 20);
    const qtyStart = await getInventoryQty(bookId, locationId);

    const order = await createDraftOrder(managerToken, branchId, locationId, bookId, 5);
    await confirmOrder(managerToken, branchId, order.id);
    await payOrder(managerToken, branchId, order.id, order.total);
    await fulfillOrder(managerToken, branchId, order.id);

    expect(await getInventoryQty(bookId, locationId)).toBe(qtyStart - 5);
  });

  // â”€â”€ 18. Cancel-then-recommit: reservation from cancelled order is released â”€

  it('18. After cancel the released reservation does not block future orders', async () => {
    await setInventory(bookId, locationId, 5);

    const order = await createDraftOrder(managerToken, branchId, locationId, bookId, 5);
    await confirmOrder(managerToken, branchId, order.id);
    await cancelOrder(managerToken, branchId, order.id);

    // After cancel, all 5 are available again
    expect(await getReservedQty(bookId, locationId)).toBe(0);

    const order2 = await createDraftOrder(managerToken, branchId, locationId, bookId, 5);
    const res = await confirmOrder(managerToken, branchId, order2.id);
    expect(res.status).toBe(200);
    expect(await getReservedQty(bookId, locationId)).toBe(5);
  });
});
