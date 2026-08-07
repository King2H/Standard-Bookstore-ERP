/**
 * receivables.test.ts
 *
 * Module 3 (stabilization sprint) — coverage for POST /api/receivables/:id/collect,
 * the unified "the customer paid" action added this module. Previously the ONLY
 * way to close a receivable from the Receivables page was POST /:id/settle, a
 * bare status flip that recorded no payment method, no amount, and never
 * touched store_credit_accounts or any reportable ledger -- regardless of
 * which of the three receivable source types it was. /collect routes each
 * source type to its own already-existing, fully-featured payment pipeline
 * (order_credit_sale -> payments.service.createPayment, pos_credit_sale ->
 * pos.service.recordPayment) and adds the one that was missing entirely
 * (exchange_difference -> the new receivables.service.collectPayment). This
 * file had no prior test coverage at all.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'recv_test_';
const BRANCH_PREFIX = 'Receivables Test ';

async function getTestBook(): Promise<{ id: number; price: number }> {
  const r = await db.query(`SELECT id, default_price FROM books WHERE is_active = true AND default_price IS NOT NULL LIMIT 1`);
  if (!r.rows.length) throw new Error('No active books with price');
  return { id: r.rows[0].id as number, price: parseFloat(r.rows[0].default_price as string) };
}

async function getOrCreateLocation(branchId: number): Promise<number> {
  const r = await db.query(`SELECT id FROM locations WHERE branch_id = $1 LIMIT 1`, [branchId]);
  if (r.rows.length) return r.rows[0].id as number;
  const c = await db.query(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Recv Test Loc', true) RETURNING id`, [branchId]);
  return c.rows[0].id as number;
}

async function ensureInventory(bookId: number, locationId: number, qty = 20) {
  await db.query(`INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version) VALUES ($1,$2,$3,5,0) ON CONFLICT (book_id, location_id) DO UPDATE SET quantity = $3, version = 0`, [bookId, locationId, qty]);
}

describe('Receivables — unified payment collection (Module 3)', () => {
  let salesToken: string;
  let managerToken: string;
  let branchId: number;
  let locationId: number;
  let customerId: number;
  let book: { id: number; price: number };
  let book2: { id: number; price: number };

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);

    const branch = await createTestBranch({ name: `${BRANCH_PREFIX}Branch` });
    branchId = branch.branchId;
    const sales = await createTestStaff({ username: `${STAFF_PREFIX}sales`, role: 'Sales', branchId });
    salesToken = sales.token;
    const mgr = await createTestStaff({ username: `${STAFF_PREFIX}mgr`, role: 'Manager', branchId });
    managerToken = mgr.token;

    locationId = await getOrCreateLocation(branchId);
    const books = await db.query(`SELECT id, default_price FROM books WHERE is_active = true AND default_price IS NOT NULL LIMIT 2`);
    book = { id: books.rows[0].id as number, price: parseFloat(books.rows[0].default_price as string) };
    book2 = { id: books.rows[1].id as number, price: parseFloat(books.rows[1].default_price as string) };

    const custRes = await db.query(
      `INSERT INTO customers (full_name, customer_code, is_active) VALUES ('Recv Test Customer', 'RECV-TEST-001', true) RETURNING id`,
    );
    customerId = custRes.rows[0].id as number;
  });

  afterAll(async () => {
    await db.query(`DELETE FROM order_payments WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`, [branchId]).catch(() => {});
    await db.query(`DELETE FROM inventory_reservations WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`, [branchId]).catch(() => {});
    await db.query(`DELETE FROM order_line_items WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`, [branchId]).catch(() => {});
    await db.query(`DELETE FROM transaction_payments WHERE transaction_id IN (SELECT id FROM transactions WHERE branch_id = $1)`, [branchId]).catch(() => {});
    await db.query(`DELETE FROM transaction_line_items WHERE transaction_id IN (SELECT id FROM transactions WHERE branch_id = $1)`, [branchId]).catch(() => {});
    await db.query(`DELETE FROM exchange_items WHERE exchange_id IN (SELECT id FROM exchanges WHERE branch_id = $1)`, [branchId]).catch(() => {});
    await db.query(`DELETE FROM financial_transactions WHERE branch_id = $1`, [branchId]).catch(() => {});
    await db.query(`DELETE FROM receivables WHERE branch_id = $1`, [branchId]).catch(() => {});
    await db.query(`DELETE FROM exchanges WHERE branch_id = $1`, [branchId]).catch(() => {});
    await db.query(`DELETE FROM orders WHERE branch_id = $1`, [branchId]).catch(() => {});
    await db.query(`DELETE FROM transactions WHERE branch_id = $1`, [branchId]).catch(() => {});
    await db.query(`DELETE FROM store_credit_history WHERE customer_id = $1`, [customerId]).catch(() => {});
    await db.query(`DELETE FROM store_credit_accounts WHERE customer_id = $1`, [customerId]).catch(() => {});
    await db.query(`DELETE FROM customers WHERE id = $1`, [customerId]).catch(() => {});
    await db.query(`DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id = $1)`, [branchId]).catch(() => {});
    await db.query(`DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id = $1)`, [branchId]).catch(() => {});
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  async function collect(id: string, body: Record<string, unknown>, token = managerToken) {
    return request(getTestApp())
      .post(`/api/receivables/${id}/collect`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Branch-Id', String(branchId))
      .send(body);
  }

  // ── 1. order_credit_sale routes to payments.service.createPayment ─────────

  it('1. Collecting against an order_credit_sale receivable routes through createPayment (order_payments + receivable both update)', async () => {
    await ensureInventory(book.id, locationId, 20);
    const createRes = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, saleType: 'credit_sale', customerId, items: [{ bookId: book.id, quantity: 2 }] });
    expect(createRes.status).toBe(201);
    const orderId = createRes.body.id;
    const orderTotal = Number(createRes.body.total);

    await request(getTestApp()).post(`/api/orders/${orderId}/confirm`).set('Authorization', `Bearer ${managerToken}`).set('X-Branch-Id', String(branchId));

    const recRes = await db.query(`SELECT id FROM receivables WHERE source_type = 'order_credit_sale' AND source_entity_id = $1`, [orderId]);
    expect(recRes.rows.length).toBe(1);
    const receivableId = recRes.rows[0].id as string;

    const collectRes = await collect(receivableId, { amount: orderTotal, paymentMethod: 'cash' });
    expect(collectRes.status).toBe(200);
    expect(collectRes.body.status).toBe('Settled');
    expect(Number(collectRes.body.outstandingAmount)).toBeCloseTo(0, 2);

    const payRes = await db.query(`SELECT * FROM order_payments WHERE order_id = $1 AND payment_method = 'cash'`, [orderId]);
    expect(payRes.rows.length).toBe(1);
    expect(parseFloat(payRes.rows[0].amount as string)).toBeCloseTo(orderTotal, 2);
  });

  // ── 2. pos_credit_sale routes to pos.service.recordPayment ────────────────

  it('2. Collecting against a pos_credit_sale receivable routes through recordPayment (transaction_payments + receivable both update)', async () => {
    await ensureInventory(book.id, locationId, 20);
    const txRes = await request(getTestApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ branchId, locationId, customerId, items: [{ bookId: book.id, quantity: 1 }], payments: [], allowCredit: true });
    expect(txRes.status).toBe(201);
    expect(txRes.body.paymentStatus).toBe('credit');
    const txId = txRes.body.id;
    const grandTotal = Number(txRes.body.grandTotal);

    const recRes = await db.query(`SELECT id FROM receivables WHERE source_type = 'pos_credit_sale' AND source_entity_id = $1`, [txId]);
    expect(recRes.rows.length).toBe(1);
    const receivableId = recRes.rows[0].id as string;

    const collectRes = await collect(receivableId, { amount: grandTotal, paymentMethod: 'cash' });
    expect(collectRes.status).toBe(200);
    expect(collectRes.body.status).toBe('Settled');

    const payRes = await db.query(`SELECT * FROM transaction_payments WHERE transaction_id = $1 AND method = 'cash'`, [txId]);
    expect(payRes.rows.length).toBe(1);
    expect(parseFloat(payRes.rows[0].amount as string)).toBeCloseTo(grandTotal, 2);
  });

  // ── 3-7: exchange_difference — the previously-missing pipeline ────────────

  async function createCustomerPaysExchange(): Promise<{ receivableId: string; netBalance: number }> {
    await ensureInventory(book.id, locationId, 20);
    await ensureInventory(book2.id, locationId, 20);
    const res = await request(getTestApp())
      .post('/api/exchanges')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        locationId, customerId,
        incomingItems: [{ bookId: book.id, quantity: 1, unitPrice: 50 }],
        outgoingItems: [{ bookId: book2.id, quantity: 1, unitPrice: 150 }],
      });
    expect(res.status).toBe(201);
    expect(res.body.settlementType).toBe('Customer_Pays');
    const recRes = await db.query(`SELECT id FROM receivables WHERE source_type = 'exchange_difference' AND source_entity_id = $1`, [res.body.id]);
    expect(recRes.rows.length).toBe(1);
    return { receivableId: recRes.rows[0].id as string, netBalance: Number(res.body.netBalance) };
  }

  it('3. exchange_difference: cash payment settles it and is recorded in financial_transactions', async () => {
    const { receivableId, netBalance } = await createCustomerPaysExchange();

    const collectRes = await collect(receivableId, { amount: netBalance, paymentMethod: 'cash', notes: 'paid in person' });
    expect(collectRes.status).toBe(200);
    expect(collectRes.body.status).toBe('Settled');
    expect(Number(collectRes.body.outstandingAmount)).toBeCloseTo(0, 2);

    const ftRes = await db.query(
      `SELECT * FROM financial_transactions WHERE exchange_id = (SELECT source_entity_id::bigint FROM receivables WHERE id = $1) AND type = 'payment' AND method = 'cash'`,
      [receivableId],
    );
    expect(ftRes.rows.length).toBeGreaterThan(0);
  });

  it('4. exchange_difference: partial payment → PartiallyPaid, then full payment → Settled', async () => {
    const { receivableId, netBalance } = await createCustomerPaysExchange();
    const half = parseFloat((netBalance / 2).toFixed(2));

    const partialRes = await collect(receivableId, { amount: half, paymentMethod: 'cash' });
    expect(partialRes.status).toBe(200);
    expect(partialRes.body.status).toBe('PartiallyPaid');
    expect(Number(partialRes.body.outstandingAmount)).toBeCloseTo(netBalance - half, 2);

    const remaining = parseFloat((netBalance - half).toFixed(2));
    const fullRes = await collect(receivableId, { amount: remaining, paymentMethod: 'cash' });
    expect(fullRes.status).toBe(200);
    expect(fullRes.body.status).toBe('Settled');
  });

  it('5. exchange_difference: store_credit payment deducts the customer balance', async () => {
    await db.query(`INSERT INTO store_credit_accounts (customer_id, balance) VALUES ($1, 500) ON CONFLICT (customer_id) DO UPDATE SET balance = 500`, [customerId]);
    const { receivableId, netBalance } = await createCustomerPaysExchange();
    const before = await db.query(`SELECT balance FROM store_credit_accounts WHERE customer_id = $1`, [customerId]);
    const balBefore = parseFloat(before.rows[0].balance as string);

    const collectRes = await collect(receivableId, { amount: netBalance, paymentMethod: 'store_credit' });
    expect(collectRes.status).toBe(200);
    expect(collectRes.body.status).toBe('Settled');

    const after = await db.query(`SELECT balance FROM store_credit_accounts WHERE customer_id = $1`, [customerId]);
    expect(parseFloat(after.rows[0].balance as string)).toBeCloseTo(balBefore - netBalance, 2);
  });

  it('6. exchange_difference: insufficient store credit → 422 INSUFFICIENT_STORE_CREDIT, nothing deducted', async () => {
    await db.query(`INSERT INTO store_credit_accounts (customer_id, balance) VALUES ($1, 1) ON CONFLICT (customer_id) DO UPDATE SET balance = 1`, [customerId]);
    const { receivableId, netBalance } = await createCustomerPaysExchange();

    const collectRes = await collect(receivableId, { amount: netBalance, paymentMethod: 'store_credit' });
    expect(collectRes.status).toBe(422);
    expect(collectRes.body.error).toBe('INSUFFICIENT_STORE_CREDIT');

    const after = await db.query(`SELECT balance FROM store_credit_accounts WHERE customer_id = $1`, [customerId]);
    expect(parseFloat(after.rows[0].balance as string)).toBeCloseTo(1, 2);
  });

  it('7. exchange_difference: amount exceeding outstanding → 422 EXCEEDS_OUTSTANDING', async () => {
    const { receivableId, netBalance } = await createCustomerPaysExchange();

    const collectRes = await collect(receivableId, { amount: netBalance + 100, paymentMethod: 'cash' });
    expect(collectRes.status).toBe(422);
    expect(collectRes.body.error).toBe('EXCEEDS_OUTSTANDING');
  });

  // ── 8. Payments report reflects the collection (Module 2 wiring) ──────────

  it('8. exchange_difference collection is reflected in GET /api/reports/payments', async () => {
    const { receivableId, netBalance } = await createCustomerPaysExchange();
    const dateFrom = new Date(Date.now() - 60_000).toISOString().slice(0, 10);

    const before = await request(getTestApp())
      .get(`/api/reports/payments?branchId=${branchId}&dateFrom=${dateFrom}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));
    const collectedBefore = Number(before.body.summary.totalCollected);

    await collect(receivableId, { amount: netBalance, paymentMethod: 'cash' });

    const after = await request(getTestApp())
      .get(`/api/reports/payments?branchId=${branchId}&dateFrom=${dateFrom}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));
    expect(Number(after.body.summary.totalCollected)).toBeCloseTo(collectedBefore + netBalance, 2);
  });

  // ── 9-10. Write-off (/settle) is restricted and records no payment ────────

  it('9. Sales role cannot write off a receivable (403); Manager can', async () => {
    const { receivableId } = await createCustomerPaysExchange();

    const salesRes = await request(getTestApp())
      .post(`/api/receivables/${receivableId}/settle`)
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ notes: 'trying to write off' });
    expect(salesRes.status).toBe(403);

    const mgrRes = await request(getTestApp())
      .post(`/api/receivables/${receivableId}/settle`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ notes: 'bad debt write-off' });
    expect(mgrRes.status).toBe(200);
    expect(mgrRes.body.status).toBe('Settled');
  });

  it('10. Write-off records no financial_transactions row (unlike /collect)', async () => {
    const { receivableId } = await createCustomerPaysExchange();

    await request(getTestApp())
      .post(`/api/receivables/${receivableId}/settle`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ notes: 'write-off, no payment' });

    const ftRes = await db.query(
      `SELECT * FROM financial_transactions WHERE exchange_id = (SELECT source_entity_id::bigint FROM receivables WHERE id = $1)`,
      [receivableId],
    );
    expect(ftRes.rows.length).toBe(0);
  });

  // ── 11. Already-settled receivable rejects further collection ─────────────

  it('11. Collecting against an already-settled receivable → 422 RECEIVABLE_ALREADY_SETTLED', async () => {
    const { receivableId, netBalance } = await createCustomerPaysExchange();
    await collect(receivableId, { amount: netBalance, paymentMethod: 'cash' });

    const secondRes = await collect(receivableId, { amount: 1, paymentMethod: 'cash' });
    expect(secondRes.status).toBe(422);
    expect(secondRes.body.error).toBe('RECEIVABLE_ALREADY_SETTLED');
  });
});
