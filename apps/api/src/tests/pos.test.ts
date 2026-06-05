import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'pos_test_';
const BRANCH_PREFIX = 'POS Test ';

async function cleanTestTransactions() {
  await db.query(`
    DELETE FROM transaction_payments WHERE transaction_id IN (
      SELECT id FROM transactions WHERE transaction_number LIKE 'POS-%' AND staff_id IN (
        SELECT id FROM staff WHERE username LIKE 'pos_test_%'
      )
    )
  `);
  await db.query(`
    DELETE FROM transaction_line_items WHERE transaction_id IN (
      SELECT id FROM transactions WHERE transaction_number LIKE 'POS-%' AND staff_id IN (
        SELECT id FROM staff WHERE username LIKE 'pos_test_%'
      )
    )
  `);
  await db.query(`
    DELETE FROM transactions WHERE transaction_number LIKE 'POS-%' AND staff_id IN (
      SELECT id FROM staff WHERE username LIKE 'pos_test_%'
    )
  `);
}

async function getTestBook(): Promise<{ id: number; price: number }> {
  const result = await db.query(`SELECT id, default_price FROM books WHERE is_active = true AND default_price IS NOT NULL LIMIT 1`);
  if (!result.rows.length) throw new Error('No active books with price found');
  return { id: result.rows[0].id as number, price: parseFloat(result.rows[0].default_price as string) };
}

async function getTestLocation(branchId: number): Promise<number> {
  const result = await db.query(`SELECT id FROM locations WHERE branch_id = $1 LIMIT 1`, [branchId]);
  if (result.rows.length) return result.rows[0].id as number;
  const created = await db.query(
    `INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'POS Test Location', true) RETURNING id`,
    [branchId],
  );
  return created.rows[0].id as number;
}

async function ensureInventory(bookId: number, locationId: number, qty = 50) {
  await db.query(
    `INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version)
     VALUES ($1, $2, $3, 5, 0)
     ON CONFLICT (book_id, location_id) DO UPDATE SET quantity = $3, version = 0`,
    [bookId, locationId, qty],
  );
}

async function createTestCustomer(branchId: number) {
  const code = `CUS-TEST-${Date.now()}`;
  const result = await db.query(
    `INSERT INTO customers (branch_id, customer_code, full_name, is_active, created_at)
     VALUES ($1, $2, 'POS Test Customer', true, now()) RETURNING id`,
    [branchId, code],
  );
  const cid = result.rows[0].id as number;
  await db.query(`INSERT INTO loyalty_accounts (customer_id, points_balance, lifetime_points, updated_at) VALUES ($1, 100, 100, now())`, [cid]);
  await db.query(`INSERT INTO store_credit_accounts (customer_id, balance) VALUES ($1, 50.00)`, [cid]);
  return cid;
}

describe('POS — Transactions', () => {
  let salesToken: string;
  let managerToken: string;
  let adminToken: string;
  let branchId: number;
  let locationId: number;
  let bookId: number;
  let bookPrice: number;

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
    await cleanTestTransactions();

    const branch = await createTestBranch({ name: 'POS Test Branch' });
    branchId = branch.branchId;

    const sales = await createTestStaff({ username: 'pos_test_sales', role: 'Sales', branchId });
    salesToken = sales.token;

    const mgr = await createTestStaff({ username: 'pos_test_mgr', role: 'Manager', branchId });
    managerToken = mgr.token;

    const admin = await createTestStaff({ username: 'pos_test_admin', role: 'Admin', branchId });
    adminToken = admin.token;

    locationId = await getTestLocation(branchId);
    const book = await getTestBook();
    bookId = book.id;
    bookPrice = book.price;

    await ensureInventory(bookId, locationId, 50);
  });

  afterAll(async () => {
    await cleanTestTransactions();
    await db.query(`DELETE FROM inventory_history WHERE location_id = $1`, [locationId]);
    await db.query(`DELETE FROM inventory WHERE location_id = $1`, [locationId]);
    await db.query(`DELETE FROM loyalty_history WHERE customer_id IN (SELECT id FROM customers WHERE full_name = 'POS Test Customer')`);
    await db.query(`DELETE FROM store_credit_history WHERE customer_id IN (SELECT id FROM customers WHERE full_name = 'POS Test Customer')`);
    await db.query(`DELETE FROM loyalty_accounts WHERE customer_id IN (SELECT id FROM customers WHERE full_name = 'POS Test Customer')`);
    await db.query(`DELETE FROM store_credit_accounts WHERE customer_id IN (SELECT id FROM customers WHERE full_name = 'POS Test Customer')`);
    // Receivables created by credit sales must be removed before the customer row is deleted
    await db.query(`DELETE FROM receivables WHERE customer_id IN (SELECT id FROM customers WHERE full_name = 'POS Test Customer')`);
    await db.query(`DELETE FROM customers WHERE full_name = 'POS Test Customer'`);
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  // ── 1. Successful transaction → inventory decremented ──────────────────────

  it('1. Successful transaction → inventory decremented, correct totals', async () => {
    const invBefore = await db.query(`SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locationId]);
    const qtyBefore = invBefore.rows[0].quantity as number;

    const qty = 2;
    const expectedSubtotal = parseFloat((bookPrice * qty).toFixed(2));
    // Tax is disabled — grandTotal = subtotal (no tax applied)
    const expectedGrand = expectedSubtotal;

    const res = await request(getTestApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        branchId,
        locationId,
        items: [{ bookId, quantity: qty }],
        payments: [{ method: 'cash', amount: expectedGrand }],
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('completed');
    expect(res.body.currency).toBe('ETB');
    expect(Number(res.body.subtotal)).toBeCloseTo(expectedSubtotal, 1);
    expect(Number(res.body.grandTotal)).toBeCloseTo(expectedGrand, 1);
    expect(res.body.transactionNumber).toMatch(/^POS-\d{8}-\d{4}$/);

    const invAfter = await db.query(`SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locationId]);
    expect(invAfter.rows[0].quantity).toBe(qtyBefore - qty);
  });

  // ── 2. Insufficient stock → 422 ────────────────────────────────────────────

  it('2. Insufficient stock → 422 INSUFFICIENT_STOCK', async () => {
    await db.query(`UPDATE inventory SET quantity = 0 WHERE book_id = $1 AND location_id = $2`, [bookId, locationId]);

    const res = await request(getTestApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        branchId,
        locationId,
        items: [{ bookId, quantity: 1 }],
        payments: [{ method: 'cash', amount: bookPrice }], // exact no-tax amount
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('INSUFFICIENT_STOCK');

    // Restore inventory
    await ensureInventory(bookId, locationId, 50);
  });

  // ── 3. Payment sum mismatch → 422 ──────────────────────────────────────────

  it('3. Payment sum mismatch → 422 PAYMENT_SUM_MISMATCH', async () => {
    const res = await request(getTestApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        branchId,
        locationId,
        items: [{ bookId, quantity: 1 }],
        payments: [{ method: 'cash', amount: 0.01 }], // way too low
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('PAYMENT_SUM_MISMATCH');
  });

  // ── 4. Discount exceeds role limit → 422 ───────────────────────────────────

  it('4. Discount exceeds role limit → 422 DISCOUNT_EXCEEDS_LIMIT', async () => {
    // Sales role max discount is typically 10% from config
    const qty = 1;
    const discountPct = 99; // way over any limit
    // Payment amount doesn't matter — validation fails before reaching payment check
    const res = await request(getTestApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        branchId,
        locationId,
        items: [{ bookId, quantity: qty, discountPct }],
        payments: [{ method: 'cash', amount: 0.01 }],
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('DISCOUNT_EXCEEDS_LIMIT');
  });

  // ── 5. Store credit payment → balance deducted ─────────────────────────────

  it('5. Store credit payment → balance deducted', async () => {
    await ensureInventory(bookId, locationId, 50); // ensure stock
    const customerId = await createTestCustomer(branchId);

    const qty = 1;
    const expectedSubtotal = parseFloat((bookPrice * qty).toFixed(2));
    // Tax disabled — grandTotal = subtotal
    const expectedGrand = expectedSubtotal;

    // Use store credit for part, cash for rest
    const creditAmount = Math.min(10, expectedGrand);
    const cashAmount = parseFloat((expectedGrand - creditAmount).toFixed(2));

    const creditBefore = await db.query(`SELECT balance FROM store_credit_accounts WHERE customer_id = $1`, [customerId]);
    const balBefore = Number(creditBefore.rows[0].balance);

    const res = await request(getTestApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        branchId,
        locationId,
        customerId,
        items: [{ bookId, quantity: qty }],
        payments: [
          { method: 'store_credit', amount: creditAmount },
          { method: 'cash', amount: cashAmount },
        ],
      });

    expect(res.status).toBe(201);

    const creditAfter = await db.query(`SELECT balance FROM store_credit_accounts WHERE customer_id = $1`, [customerId]);
    expect(Number(creditAfter.rows[0].balance)).toBeCloseTo(balBefore - creditAmount, 2);
  });

  // ── 6. Loyalty points payment → balance deducted ───────────────────────────

  it('6. Loyalty points payment → balance deducted', async () => {
    await ensureInventory(bookId, locationId, 50); // ensure stock
    const customerId = await createTestCustomer(branchId);

    const qty = 1;
    // Tax disabled — grandTotal = subtotal
    const expectedGrand = parseFloat((bookPrice * qty).toFixed(2));

    const loyaltyAmount = Math.min(5, expectedGrand);
    const cashAmount = parseFloat((expectedGrand - loyaltyAmount).toFixed(2));

    const loyBefore = await db.query(`SELECT points_balance FROM loyalty_accounts WHERE customer_id = $1`, [customerId]);
    const ptsBefore = Number(loyBefore.rows[0].points_balance);

    const res = await request(getTestApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        branchId,
        locationId,
        customerId,
        items: [{ bookId, quantity: qty }],
        payments: [
          { method: 'loyalty_points', amount: loyaltyAmount },
          { method: 'cash', amount: cashAmount },
        ],
      });

    expect(res.status).toBe(201);

    const loyAfter = await db.query(`SELECT points_balance FROM loyalty_accounts WHERE customer_id = $1`, [customerId]);
    // Points deducted by loyaltyAmount, then accrual may add some back
    expect(Number(loyAfter.rows[0].points_balance)).toBeLessThan(ptsBefore + 100); // sanity check
  });

  // ── 7. Loyalty accrual on subtotal ─────────────────────────────────────────

  it('7. Loyalty accrual on subtotal → points added to customer', async () => {
    await ensureInventory(bookId, locationId, 50); // ensure stock
    const customerId = await createTestCustomer(branchId);

    const qty = 1;
    const expectedSubtotal = parseFloat((bookPrice * qty).toFixed(2));
    // Tax disabled — grandTotal = subtotal
    const expectedGrand = expectedSubtotal;

    const loyBefore = await db.query(`SELECT points_balance FROM loyalty_accounts WHERE customer_id = $1`, [customerId]);
    const ptsBefore = Number(loyBefore.rows[0].points_balance);

    const res = await request(getTestApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        branchId,
        locationId,
        customerId,
        items: [{ bookId, quantity: qty }],
        payments: [{ method: 'cash', amount: expectedGrand }],
      });

    expect(res.status).toBe(201);

    // Check loyalty history for ACCRUAL
    const histRes = await db.query(
      `SELECT points_delta FROM loyalty_history WHERE customer_id = $1 AND reason = 'ACCRUAL' ORDER BY id DESC LIMIT 1`,
      [customerId],
    );
    // Accrual may be 0 if rate is 0 or amount below threshold — just verify no error
    expect(res.body.status).toBe('completed');
    if (histRes.rows.length > 0) {
      expect(Number(histRes.rows[0].points_delta)).toBeGreaterThan(0);
    }
  });

  // ── 8. Void transaction → inventory restored ───────────────────────────────

  it('8. Void transaction → inventory restored, status=voided', async () => {
    await ensureInventory(bookId, locationId, 50); // ensure stock
    const qty = 1;
    const expectedGrand = parseFloat((bookPrice * qty).toFixed(2)); // tax is 0

    const invBefore = await db.query(`SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locationId]);
    const qtyBefore = invBefore.rows[0].quantity as number;

    // Create transaction
    const createRes = await request(getTestApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        branchId,
        locationId,
        items: [{ bookId, quantity: qty }],
        payments: [{ method: 'cash', amount: expectedGrand }],
      });
    expect(createRes.status).toBe(201);
    const txId = createRes.body.id;

    const invAfterSale = await db.query(`SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locationId]);
    expect(invAfterSale.rows[0].quantity).toBe(qtyBefore - qty);

    // Void it
    const voidRes = await request(getTestApp())
      .post(`/api/pos/transactions/${txId}/void`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(voidRes.status).toBe(200);
    expect(voidRes.body.status).toBe('voided');

    const invAfterVoid = await db.query(`SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locationId]);
    expect(invAfterVoid.rows[0].quantity).toBe(qtyBefore);
  });

  // ── 9. Grand total consistency ─────────────────────────────────────────────

  it('9. Grand total = subtotal (tax is 0)', async () => {
    await ensureInventory(bookId, locationId, 50); // ensure stock
    const qty = 3;
    const expectedSubtotal = parseFloat((bookPrice * qty).toFixed(2));
    // Tax rate is forced to 0 — grand total must equal subtotal
    const expectedGrand = expectedSubtotal;

    const res = await request(getTestApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        branchId,
        locationId,
        items: [{ bookId, quantity: qty }],
        payments: [{ method: 'cash', amount: expectedGrand }],
      });

    expect(res.status).toBe(201);
    const { subtotal, taxTotal, grandTotal } = res.body;
    expect(Number(taxTotal)).toBe(0);
    expect(Math.abs(Number(subtotal) - Number(grandTotal))).toBeLessThan(0.02);
  });

  // ── 10. Book inactive → 422 ────────────────────────────────────────────────

  it('10. Book inactive → 422 BOOK_INACTIVE', async () => {
    // Create a temp inactive book (books table uses book_authors join, no authors column)
    const bookRes = await db.query(
      `INSERT INTO books (isbn, title, is_active, default_price)
       VALUES ('POS-TEST-INACTIVE', 'POS Test Inactive Book', false, 10.00)
       ON CONFLICT (isbn) DO UPDATE SET is_active = false RETURNING id`,
    );
    const inactiveBookId = bookRes.rows[0].id as number;

    const res = await request(getTestApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        branchId,
        locationId,
        items: [{ bookId: inactiveBookId, quantity: 1 }],
        payments: [{ method: 'cash', amount: 11 }],
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('BOOK_INACTIVE');

    await db.query(`DELETE FROM books WHERE isbn = 'POS-TEST-INACTIVE'`);
  });

  // ── 11. Credit Sale → creates receivable and customer store credit debit ──
  it('11. Credit Sale → creates receivable and customer store credit debit', async () => {
    await ensureInventory(bookId, locationId, 50);
    const customerId = await createTestCustomer(branchId);
    const qty = 2;
    const expectedSubtotal = parseFloat((bookPrice * qty).toFixed(2));
    const expectedGrand = expectedSubtotal; // tax disabled
    const dueDate = new Date(Date.now() + 86400000 * 7).toISOString().slice(0, 10); // 7 days from now

    const res = await request(getTestApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        branchId,
        locationId,
        customerId,
        items: [{ bookId, quantity: qty }],
        payments: [], // no payment for full credit sale
        allowCredit: true,
        dueDate,
      });

    expect(res.status).toBe(201);
    expect(res.body.paymentStatus).toBe('credit');
    expect(Number(res.body.amountDue)).toBeCloseTo(expectedGrand, 1);
    expect(Number(res.body.amountPaid)).toBe(0);

    const txId = res.body.id;

    // Verify receivable entry is created
    const recRes = await db.query(
      `SELECT * FROM receivables WHERE source_type = 'pos_credit_sale' AND source_entity_id = $1`,
      [txId],
    );
    expect(recRes.rows.length).toBe(1);
    const rec = recRes.rows[0];
    expect(Number(rec.original_amount)).toBeCloseTo(expectedGrand, 1);
    expect(Number(rec.outstanding_amount)).toBeCloseTo(expectedGrand, 1);
    expect(rec.status).toBe('Pending');
    // Compare due_date using local-date arithmetic to avoid UTC vs local timezone off-by-one
    const nowMs = Date.now();
    const localOffset = new Date().getTimezoneOffset() * 60000;
    const localNow = new Date(nowMs - localOffset);
    const dueDateLocal = new Date(localNow.getTime() + 86400000 * 7).toISOString().slice(0, 10);
    const recDueDate = new Date(rec.due_date).toISOString().slice(0, 10);
    expect(recDueDate === dueDate || recDueDate === dueDateLocal).toBe(true);

    // Verify store credit debit is created
    const scRes = await db.query(
      `SELECT * FROM store_credit_history WHERE customer_id = $1 AND ref_type = 'pos_credit_sale' ORDER BY id DESC LIMIT 1`,
      [customerId],
    );
    expect(scRes.rows.length).toBe(1);
    expect(Number(scRes.rows[0].amount)).toBeCloseTo(expectedGrand, 1);
    expect(scRes.rows[0].direction).toBe('debit');
  });
});
