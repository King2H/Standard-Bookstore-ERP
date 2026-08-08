import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'pay_test_';
const BRANCH_PREFIX = 'Payments Test ';

async function getTestBook(): Promise<{ id: number; price: number }> {
  const r = await db.query(`SELECT id, default_price FROM books WHERE is_active = true AND default_price IS NOT NULL LIMIT 1`);
  if (!r.rows.length) throw new Error('No active books with price');
  return { id: r.rows[0].id as number, price: parseFloat(r.rows[0].default_price as string) };
}

async function getOrCreateLocation(branchId: number): Promise<number> {
  const r = await db.query(`SELECT id FROM locations WHERE branch_id = $1 LIMIT 1`, [branchId]);
  if (r.rows.length) return r.rows[0].id as number;
  const c = await db.query(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Pay Test Loc', true) RETURNING id`, [branchId]);
  return c.rows[0].id as number;
}

async function createTestCustomer(branchId: number): Promise<number> {
  const code = `PAY-TEST-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const r = await db.query(
    `INSERT INTO customers (branch_id, customer_code, full_name, is_active, created_at)
     VALUES ($1, $2, 'Payments Test Customer', true, now()) RETURNING id`,
    [branchId, code],
  );
  return r.rows[0].id as number;
}

// Manual payment collection via POST /api/payments is only valid for
// credit_sale orders — cash_sale orders are paid automatically at
// confirmation and POST /api/payments rejects them with
// CASH_ORDER_ALREADY_PAID (see payments.service.ts "Bug 2" guard). These
// tests exercise the payment-collection endpoint itself, so they need a
// credit_sale order (which requires a customer) rather than the default
// cash_sale.
async function createTestOrder(token: string, branchId: number, locationId: number, bookId: number, customerId: number): Promise<{ id: string; total: number }> {
  const res = await request(getTestApp())
    .post('/api/orders')
    .set('Authorization', `Bearer ${token}`)
    .set('X-Branch-Id', String(branchId))
    .send({ locationId, channel: 'in_store', saleType: 'credit_sale', customerId, items: [{ bookId, quantity: 2 }] });
  if (res.status !== 201) throw new Error(`Order creation failed: ${JSON.stringify(res.body)}`);
  return { id: res.body.id, total: Number(res.body.total) };
}

async function cleanPayments(branchId: number) {
  await db.query(`DELETE FROM receivables WHERE branch_id = $1`, [branchId]);
  await db.query(`DELETE FROM order_refunds WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`, [branchId]);
  await db.query(`DELETE FROM order_payments WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`, [branchId]);
  await db.query(`DELETE FROM order_line_items WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`, [branchId]);
  await db.query(`DELETE FROM orders WHERE branch_id = $1`, [branchId]);
  await db.query(`DELETE FROM customers WHERE branch_id = $1 AND full_name = 'Payments Test Customer'`, [branchId]);
}

describe('Payments — Order Payment Management', () => {
  let salesToken: string;
  let managerToken: string;
  let branchId: number;
  let locationId: number;
  let bookId: number;
  let customerId: number;

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    const oldBranches = await db.query(`SELECT id FROM branches WHERE name LIKE 'Payments Test %'`);
    for (const row of oldBranches.rows) await cleanPayments(row.id as number);
    await cleanTestBranches(BRANCH_PREFIX);

    const branch = await createTestBranch({ name: 'Payments Test Branch' });
    branchId = branch.branchId;
    const sales = await createTestStaff({ username: 'pay_test_sales', role: 'Sales', branchId });
    salesToken = sales.token;
    const mgr = await createTestStaff({ username: 'pay_test_mgr', role: 'Manager', branchId });
    managerToken = mgr.token;

    locationId = await getOrCreateLocation(branchId);
    const book = await getTestBook();
    bookId = book.id;
    customerId = await createTestCustomer(branchId);
  });

  afterAll(async () => {
    await cleanPayments(branchId);
    await db.query(`DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id = $1)`, [branchId]);
    await db.query(`DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id = $1)`, [branchId]);
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  // ── 1. Full payment → order payment_status = paid ──────────────────────────

  it('1. Full payment → order payment_status = paid', async () => {
    const order = await createTestOrder(salesToken, branchId, locationId, bookId, customerId);

    const res = await request(getTestApp())
      .post('/api/payments')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ orderId: parseInt(order.id), amount: order.total, paymentMethod: 'cash' });

    expect(res.status).toBe(201);
    expect(res.body.paymentReference).toMatch(/^PAY-\d{8}-\d{4}$/);
    expect(res.body.status).toBe('success');
    expect(res.body.currency).toBe('ETB');
    expect(Number(res.body.amount)).toBeCloseTo(order.total, 2);

    // Order payment_status should be 'paid'
    const orderRes = await db.query(`SELECT payment_status FROM orders WHERE id = $1`, [order.id]);
    expect(orderRes.rows[0].payment_status).toBe('paid');
  });

  // ── 2. Partial payment → order payment_status = partial ───────────────────

  it('2. Partial payment → order payment_status = partial', async () => {
    const order = await createTestOrder(salesToken, branchId, locationId, bookId, customerId);
    const partialAmount = parseFloat((order.total / 2).toFixed(2));

    const res = await request(getTestApp())
      .post('/api/payments')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ orderId: parseInt(order.id), amount: partialAmount, paymentMethod: 'cash' });

    expect(res.status).toBe(201);

    const orderRes = await db.query(`SELECT payment_status FROM orders WHERE id = $1`, [order.id]);
    expect(orderRes.rows[0].payment_status).toBe('partial');
  });

  // ── 3. Payment exceeds order total → 422 ──────────────────────────────────

  it('3. Payment exceeds order total → 422 EXCEEDS_ORDER_TOTAL', async () => {
    const order = await createTestOrder(salesToken, branchId, locationId, bookId, customerId);

    const res = await request(getTestApp())
      .post('/api/payments')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ orderId: parseInt(order.id), amount: order.total + 1000, paymentMethod: 'cash' });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('EXCEEDS_ORDER_TOTAL');
  });

  // ── 4. Refund → payment status updated ────────────────────────────────────

  it('4. Full refund → payment status = refunded, order = refunded', async () => {
    const order = await createTestOrder(salesToken, branchId, locationId, bookId, customerId);

    const payRes = await request(getTestApp())
      .post('/api/payments')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ orderId: parseInt(order.id), amount: order.total, paymentMethod: 'cash' });
    expect(payRes.status).toBe(201);
    const paymentId = payRes.body.id;

    const refundRes = await request(getTestApp())
      .post(`/api/payments/${paymentId}/refund`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ refundAmount: order.total, reason: 'Customer returned all items' });

    expect(refundRes.status).toBe(201);
    expect(Number(refundRes.body.refundAmount)).toBeCloseTo(order.total, 2);

    // Payment status should be 'refunded'
    const payCheck = await db.query(`SELECT status FROM order_payments WHERE id = $1`, [paymentId]);
    expect(payCheck.rows[0].status).toBe('refunded');

    // Order payment_status should be 'refunded'
    const orderRes = await db.query(`SELECT payment_status FROM orders WHERE id = $1`, [order.id]);
    expect(orderRes.rows[0].payment_status).toBe('refunded');
  });

  // ── 5. Refund exceeds payment → 422 ───────────────────────────────────────

  it('5. Refund exceeds payment amount → 422 EXCEEDS_PAYMENT_AMOUNT', async () => {
    const order = await createTestOrder(salesToken, branchId, locationId, bookId, customerId);

    const payRes = await request(getTestApp())
      .post('/api/payments')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ orderId: parseInt(order.id), amount: order.total, paymentMethod: 'cash' });
    const paymentId = payRes.body.id;

    const refundRes = await request(getTestApp())
      .post(`/api/payments/${paymentId}/refund`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ refundAmount: order.total + 500, reason: 'Too much' });

    expect(refundRes.status).toBe(422);
    expect(refundRes.body.error).toBe('EXCEEDS_PAYMENT_AMOUNT');
  });

  // ── 6. GET /api/orders/:id/balance ────────────────────────────────────────

  it('6. GET /api/orders/:id/balance → correct outstanding', async () => {
    const order = await createTestOrder(salesToken, branchId, locationId, bookId, customerId);
    const partialAmount = parseFloat((order.total * 0.6).toFixed(2));

    await request(getTestApp())
      .post('/api/payments')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ orderId: parseInt(order.id), amount: partialAmount, paymentMethod: 'mobile' });

    const balRes = await request(getTestApp())
      .get(`/api/orders/${order.id}/balance`)
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(balRes.status).toBe(200);
    expect(Number(balRes.body.orderTotal)).toBeCloseTo(order.total, 2);
    expect(Number(balRes.body.totalPaid)).toBeCloseTo(partialAmount, 2);
    expect(Number(balRes.body.outstanding)).toBeCloseTo(order.total - partialAmount, 2);
    expect(balRes.body.paymentStatus).toBe('partial');
  });

  // ── 7. GET /api/orders/:id/payments ───────────────────────────────────────

  it('7. GET /api/orders/:id/payments → lists payments for order', async () => {
    const order = await createTestOrder(salesToken, branchId, locationId, bookId, customerId);

    await request(getTestApp())
      .post('/api/payments')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ orderId: parseInt(order.id), amount: order.total, paymentMethod: 'mobile' });

    const listRes = await request(getTestApp())
      .get(`/api/orders/${order.id}/payments`)
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(listRes.status).toBe(200);
    expect(listRes.body.items).toHaveLength(1);
    expect(listRes.body.items[0].paymentMethod).toBe('mobile');
    expect(listRes.body.items[0].currency).toBe('ETB');
  });

  // ── 8. Split payment (two methods) ────────────────────────────────────────

  it('8. Split payment (cash + mobile) → order fully paid', async () => {
    const order = await createTestOrder(salesToken, branchId, locationId, bookId, customerId);
    const half = parseFloat((order.total / 2).toFixed(2));
    const remainder = parseFloat((order.total - half).toFixed(2));

    await request(getTestApp())
      .post('/api/payments')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ orderId: parseInt(order.id), amount: half, paymentMethod: 'cash' });

    const res2 = await request(getTestApp())
      .post('/api/payments')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ orderId: parseInt(order.id), amount: remainder, paymentMethod: 'mobile' });

    expect(res2.status).toBe(201);

    const orderRes = await db.query(`SELECT payment_status FROM orders WHERE id = $1`, [order.id]);
    expect(orderRes.rows[0].payment_status).toBe('paid');
  });
});

// ── Single Authoritative Payment Collection Workflow ──────────────────────────
// Sales History and Receivables no longer expose a Collect action -- both
// navigate into the Payments module instead, which is now the only UI entry
// point for creating a payment. To reach exchange-difference receivables (the
// one source type Payments previously had no visibility into at all), GET
// /payments/unpaid-orders and GET /payments were each extended with a third
// UNION branch; the actual collection still goes through the existing,
// unchanged receivables.service.collectPayment() via POST /receivables/:id/
// collect (the same dispatcher Receivables' removed Collect button used to
// call) -- no new business logic, just a new way to reach it.
describe('Payments — Unpaid Orders & Single Authoritative Collection', () => {
  const STAFF_PREFIX2 = 'pay2_test_';
  const BRANCH_PREFIX2 = 'Payments2 Test ';

  let salesToken: string;
  let branchId: number;
  let locationId: number;
  let customerId: number;
  let book1: { id: number; price: number };
  let book2: { id: number; price: number };

  async function ensureInventory(bookId: number, locId: number, qty = 20) {
    await db.query(
      `INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version) VALUES ($1,$2,$3,5,0)
       ON CONFLICT (book_id, location_id) DO UPDATE SET quantity = $3, version = 0`,
      [bookId, locId, qty],
    );
  }

  async function cleanAll(bId: number) {
    await db.query(`DELETE FROM financial_transactions WHERE branch_id = $1`, [bId]);
    await db.query(`DELETE FROM exchange_outgoing_items WHERE exchange_id IN (SELECT id FROM exchanges WHERE branch_id = $1)`, [bId]);
    await db.query(`DELETE FROM exchange_incoming_items WHERE exchange_id IN (SELECT id FROM exchanges WHERE branch_id = $1)`, [bId]);
    await db.query(`DELETE FROM receivables WHERE branch_id = $1`, [bId]);
    await db.query(`DELETE FROM exchanges WHERE branch_id = $1`, [bId]);
    await db.query(`DELETE FROM transaction_payments WHERE transaction_id IN (SELECT id FROM transactions WHERE branch_id = $1)`, [bId]);
    await db.query(`DELETE FROM transactions WHERE branch_id = $1`, [bId]);
    await db.query(`DELETE FROM order_payments WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`, [bId]);
    await db.query(`DELETE FROM order_line_items WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`, [bId]);
    await db.query(`DELETE FROM orders WHERE branch_id = $1`, [bId]);
    await db.query(`DELETE FROM store_credit_history WHERE customer_id IN (SELECT id FROM customers WHERE branch_id = $1 AND full_name = 'Payments2 Test Customer')`, [bId]);
    await db.query(`DELETE FROM store_credit_accounts WHERE customer_id IN (SELECT id FROM customers WHERE branch_id = $1 AND full_name = 'Payments2 Test Customer')`, [bId]);
    await db.query(`DELETE FROM customers WHERE branch_id = $1 AND full_name = 'Payments2 Test Customer'`, [bId]);
  }

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX2);
    const oldBranches = await db.query(`SELECT id FROM branches WHERE name LIKE 'Payments2 Test %'`);
    for (const row of oldBranches.rows) await cleanAll(row.id as number);
    await cleanTestBranches(BRANCH_PREFIX2);

    const branch = await createTestBranch({ name: 'Payments2 Test Branch' });
    branchId = branch.branchId;
    const sales = await createTestStaff({ username: 'pay2_test_sales', role: 'Sales', branchId });
    salesToken = sales.token;

    locationId = await getOrCreateLocation(branchId);
    const books = await db.query(`SELECT id, default_price FROM books WHERE is_active = true AND default_price IS NOT NULL LIMIT 2`);
    if (books.rows.length < 2) throw new Error('Need at least 2 active books with price');
    book1 = { id: books.rows[0].id as number, price: parseFloat(books.rows[0].default_price as string) };
    book2 = { id: books.rows[1].id as number, price: parseFloat(books.rows[1].default_price as string) };
    await ensureInventory(book1.id, locationId, 20);
    await ensureInventory(book2.id, locationId, 20);

    const cust = await db.query(
      `INSERT INTO customers (branch_id, customer_code, full_name, is_active, created_at)
       VALUES ($1, $2, 'Payments2 Test Customer', true, now()) RETURNING id`,
      [branchId, `PAY2-TEST-${Date.now()}`],
    );
    customerId = cust.rows[0].id as number;
  });

  afterAll(async () => {
    await cleanAll(branchId);
    await db.query(`DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id = $1)`, [branchId]);
    await db.query(`DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id = $1)`, [branchId]);
    await cleanTestStaff(STAFF_PREFIX2);
    await cleanTestBranches(BRANCH_PREFIX2);
  });

  it('9. Unpaid Orders includes an order_credit_sale order, sourceType=order', async () => {
    const orderRes = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, channel: 'in_store', saleType: 'credit_sale', customerId, items: [{ bookId: book1.id, quantity: 1 }] });
    expect(orderRes.status).toBe(201);

    // listUnpaidOrders() excludes DRAFT orders (nothing is payable/collectible
    // until confirmed) -- confirm it so it actually shows up, same as a real
    // credit sale would before it's collectible.
    const confirmRes = await request(getTestApp())
      .post(`/api/orders/${orderRes.body.id}/confirm`)
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ dueDate: '2099-12-31' });
    expect(confirmRes.status).toBe(200);

    const res = await request(getTestApp())
      .get(`/api/payments/unpaid-orders?branchId=${branchId}&pageSize=100`)
      .set('Authorization', `Bearer ${salesToken}`);
    expect(res.status).toBe(200);
    const row = res.body.items.find((i: { id: string }) => i.id === orderRes.body.id);
    expect(row).toBeDefined();
    expect(row.sourceType).toBe('order');
  });

  it('10. Unpaid Orders includes a pos_credit_sale transaction, sourceType=pos', async () => {
    const txRes = await request(getTestApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ branchId, locationId, customerId, items: [{ bookId: book1.id, quantity: 1 }], payments: [], allowCredit: true });
    expect(txRes.status).toBe(201);

    const res = await request(getTestApp())
      .get(`/api/payments/unpaid-orders?branchId=${branchId}&pageSize=100`)
      .set('Authorization', `Bearer ${salesToken}`);
    const row = res.body.items.find((i: { id: string }) => i.id === txRes.body.id);
    expect(row).toBeDefined();
    expect(row.sourceType).toBe('pos');
  });

  it('11. Unpaid Orders includes an exchange_difference receivable, sourceType=exchange_difference, id=receivable id', async () => {
    const excRes = await request(getTestApp())
      .post('/api/exchanges')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        locationId, customerId,
        incomingItems: [{ bookId: book1.id, quantity: 1, unitPrice: 50 }],
        outgoingItems: [{ bookId: book2.id, quantity: 1, unitPrice: 150 }],
      });
    expect(excRes.status).toBe(201);
    expect(excRes.body.settlementType).toBe('Customer_Pays');

    const recRes = await db.query(
      `SELECT id, outstanding_amount FROM receivables WHERE source_type = 'exchange_difference' AND source_entity_id = $1`,
      [excRes.body.id],
    );
    expect(recRes.rows.length).toBe(1);
    const receivableId = String(recRes.rows[0].id);

    const res = await request(getTestApp())
      .get(`/api/payments/unpaid-orders?branchId=${branchId}&pageSize=100`)
      .set('Authorization', `Bearer ${salesToken}`);
    const row = res.body.items.find((i: { id: string }) => i.id === receivableId);
    expect(row).toBeDefined();
    expect(row.sourceType).toBe('exchange_difference');
    expect(row.orderNumber).toBe(excRes.body.exchangeReference);
    expect(Number(row.outstanding)).toBeCloseTo(100, 2);
    expect(row.paymentStatus).toBe('unpaid');

    // ── 11b. entityId + sourceType deep-link filter narrows to exactly this row ──
    const filtered = await request(getTestApp())
      .get(`/api/payments/unpaid-orders?branchId=${branchId}&entityId=${receivableId}&sourceType=exchange_difference`)
      .set('Authorization', `Bearer ${salesToken}`);
    expect(filtered.status).toBe(200);
    expect(filtered.body.items).toHaveLength(1);
    expect(filtered.body.items[0].id).toBe(receivableId);

    // ── 11c. Collecting the full outstanding amount via the existing dispatcher
    // (POST /receivables/:id/collect -- what the Payments module's exchange
    // branch calls) settles the receivable and drops it out of Unpaid Orders,
    // and the payment shows up in Payment History tagged sourceType=exchange.
    const collectRes = await request(getTestApp())
      .post(`/api/receivables/${receivableId}/collect`)
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ amount: 100, paymentMethod: 'cash' });
    expect(collectRes.status).toBe(200);
    expect(collectRes.body.status).toBe('Settled');
    expect(Number(collectRes.body.outstandingAmount)).toBeCloseTo(0, 2);

    const afterCollect = await request(getTestApp())
      .get(`/api/payments/unpaid-orders?branchId=${branchId}&pageSize=100`)
      .set('Authorization', `Bearer ${salesToken}`);
    expect(afterCollect.body.items.some((i: { id: string }) => i.id === receivableId)).toBe(false);

    const historyRes = await request(getTestApp())
      .get(`/api/payments?pageSize=100`)
      .set('Authorization', `Bearer ${salesToken}`);
    expect(historyRes.status).toBe(200);
    const historyRow = historyRes.body.items.find((p: { entityNumber?: string }) => p.entityNumber === excRes.body.exchangeReference);
    expect(historyRow).toBeDefined();
    expect(historyRow.sourceType).toBe('exchange');
    expect(Number(historyRow.amount)).toBeCloseTo(100, 2);
  });

  it('12. Partial collection against an exchange_difference receivable → PartiallyPaid, still listed with reduced outstanding', async () => {
    const excRes = await request(getTestApp())
      .post('/api/exchanges')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        locationId, customerId,
        incomingItems: [{ bookId: book1.id, quantity: 1, unitPrice: 20 }],
        outgoingItems: [{ bookId: book2.id, quantity: 1, unitPrice: 120 }],
      });
    expect(excRes.status).toBe(201);

    const recRes = await db.query(
      `SELECT id FROM receivables WHERE source_type = 'exchange_difference' AND source_entity_id = $1`,
      [excRes.body.id],
    );
    const receivableId = String(recRes.rows[0].id);

    const collectRes = await request(getTestApp())
      .post(`/api/receivables/${receivableId}/collect`)
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ amount: 40, paymentMethod: 'cash' });
    expect(collectRes.status).toBe(200);
    expect(collectRes.body.status).toBe('PartiallyPaid');
    expect(Number(collectRes.body.outstandingAmount)).toBeCloseTo(60, 2);

    const res = await request(getTestApp())
      .get(`/api/payments/unpaid-orders?branchId=${branchId}&pageSize=100`)
      .set('Authorization', `Bearer ${salesToken}`);
    const row = res.body.items.find((i: { id: string }) => i.id === receivableId);
    expect(row).toBeDefined();
    expect(row.paymentStatus).toBe('partial');
    expect(Number(row.outstanding)).toBeCloseTo(60, 2);
  });
});
