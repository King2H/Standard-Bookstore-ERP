/**
 * Post-MVP Hardening Tests
 * Covers: idempotency, bank transfer validation, PII encryption, installment plans
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';
import { db } from '../db/index.js';
import { encryptPii, decryptPii, piiLookupHash } from '../lib/piiEncryption.js';

const STAFF_PREFIX = 'hard_test_';
const BRANCH_PREFIX = 'Hardening Test ';

async function getTestBook(): Promise<{ id: number; price: number }> {
  const r = await db.query(`SELECT id, default_price FROM books WHERE is_active = true AND default_price IS NOT NULL LIMIT 1`);
  if (!r.rows.length) throw new Error('Need at least 1 active book with price');
  return { id: r.rows[0].id as number, price: parseFloat(r.rows[0].default_price as string) };
}

async function getOrCreateLocation(branchId: number): Promise<number> {
  const r = await db.query(`SELECT id FROM locations WHERE branch_id = $1 LIMIT 1`, [branchId]);
  if (r.rows.length) return r.rows[0].id as number;
  const c = await db.query(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Hard Test Loc', true) RETURNING id`, [branchId]);
  return c.rows[0].id as number;
}

async function ensureInventory(bookId: number, locationId: number, qty = 50) {
  await db.query(`INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version) VALUES ($1,$2,$3,5,0) ON CONFLICT (book_id, location_id) DO UPDATE SET quantity = $3`, [bookId, locationId, qty]);
}

async function createTestBankAccount(branchId: number): Promise<number> {
  const r = await db.query(
    `INSERT INTO bank_accounts (branch_id, account_name, bank_name, account_number, currency, is_active)
     VALUES ($1, 'Test Bank', 'CBE', 'ACC-TEST-001', 'ETB', true) RETURNING id`,
    [branchId],
  );
  return r.rows[0].id as number;
}

async function createTestOrder(token: string, branchId: number, bookId: number): Promise<string> {
  const res = await request(getTestApp())
    .post('/api/orders')
    .set('Authorization', `Bearer ${token}`)
    .set('X-Branch-Id', String(branchId))
    .send({ items: [{ bookId, quantity: 1 }] });
  if (res.status !== 201) throw new Error(`Order creation failed: ${JSON.stringify(res.body)}`);
  return res.body.id;
}

describe('Post-MVP Hardening', () => {
  let adminToken: string;
  let branchId: number;
  let locationId: number;
  let bookId: number;
  let bookPrice: number;
  let bankAccountId: number;

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);

    const branch = await createTestBranch({ name: 'Hardening Test Branch' });
    branchId = branch.branchId;
    const admin = await createTestStaff({ username: 'hard_test_admin', role: 'Admin', branchId });
    adminToken = admin.token;

    locationId = await getOrCreateLocation(branchId);
    const book = await getTestBook();
    bookId = book.id;
    bookPrice = book.price;
    await ensureInventory(bookId, locationId, 50);
    bankAccountId = await createTestBankAccount(branchId);
  });

  afterAll(async () => {
    // Clean up test data
    await db.query(`DELETE FROM bank_reconciliation WHERE bank_account_id = $1`, [bankAccountId]);
    await db.query(`DELETE FROM order_refunds WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`, [branchId]);
    await db.query(`DELETE FROM order_payments WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`, [branchId]);
    await db.query(`DELETE FROM installments WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`, [branchId]);
    await db.query(`DELETE FROM installment_plans WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`, [branchId]);
    await db.query(`DELETE FROM order_line_items WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`, [branchId]);
    await db.query(`DELETE FROM orders WHERE branch_id = $1`, [branchId]);
    await db.query(`DELETE FROM bank_accounts WHERE id = $1`, [bankAccountId]);
    await db.query(`DELETE FROM idempotency_keys WHERE endpoint = '/payments'`);
    await db.query(`DELETE FROM customers WHERE full_name LIKE 'PII Test%'`);
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  // ── PII Encryption ──────────────────────────────────────────────────────────

  describe('PII Encryption', () => {
    it('1. encryptPii / decryptPii round-trip', () => {
      const email = 'test@example.com';
      const encrypted = encryptPii(email);
      expect(encrypted).not.toBe(email);
      expect(encrypted).not.toBeNull();
      expect(decryptPii(encrypted!)).toBe(email);
    });

    it('2. piiLookupHash is deterministic', () => {
      const phone = '+251911234567';
      const h1 = piiLookupHash(phone);
      const h2 = piiLookupHash(phone);
      expect(h1).toBe(h2);
      expect(h1).toHaveLength(64); // SHA256 hex
    });

    it('3. piiLookupHash returns null for null input', () => {
      expect(piiLookupHash(null)).toBeNull();
      expect(piiLookupHash('')).toBeNull();
    });

    it('4. Customer created with encrypted PII columns populated', async () => {
      const res = await request(getTestApp())
        .post('/api/customers')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({ fullName: 'PII Test Customer', phone: '+251900000001', email: 'piitest1@example.com' });

      expect(res.status).toBe(201);
      expect(res.body.phone).toBe('+251900000001');
      expect(res.body.email).toBe('piitest1@example.com');

      // Verify encrypted columns are set in DB
      const dbRow = await db.query(`SELECT phone_encrypted, email_encrypted, phone_lookup, email_lookup FROM customers WHERE id = $1`, [res.body.id]);
      expect(dbRow.rows[0].phone_encrypted).not.toBeNull();
      expect(dbRow.rows[0].email_encrypted).not.toBeNull();
      expect(dbRow.rows[0].phone_lookup).toHaveLength(64);
      expect(dbRow.rows[0].email_lookup).toHaveLength(64);
    });

    it('5. Customer search works via lookup hash', async () => {
      const res = await request(getTestApp())
        .get('/api/customers?q=piitest1@example.com')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId));

      expect(res.status).toBe(200);
      expect(res.body.items.some((c: { email: string }) => c.email === 'piitest1@example.com')).toBe(true);
    });
  });

  // ── Bank Transfer Validation ────────────────────────────────────────────────

  describe('Bank Transfer Validation', () => {
    it('6. Bank payment without bank_account_id → 400', async () => {
      const orderId = await createTestOrder(adminToken, branchId, bookId);
      // Confirm order first
      await request(getTestApp())
        .post(`/api/orders/${orderId}/confirm`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId));

      const res = await request(getTestApp())
        .post('/api/payments')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({ orderId, amount: bookPrice, paymentMethod: 'bank' });

      expect(res.status).toBe(400);
    });

    it('7. Bank payment with valid bank_account_id → 201 + reconciliation entry created', async () => {
      const orderId = await createTestOrder(adminToken, branchId, bookId);

      const res = await request(getTestApp())
        .post('/api/payments')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({ orderId, amount: bookPrice, paymentMethod: 'bank', bankAccountId });

      expect(res.status).toBe(201);
      expect(res.body.bankAccountId).toBe(bankAccountId);

      // Verify reconciliation entry was created
      const reconRes = await db.query(
        `SELECT * FROM bank_reconciliation WHERE bank_account_id = $1 AND payment_ref_id = $2`,
        [bankAccountId, res.body.id],
      );
      expect(reconRes.rows.length).toBe(1);
      expect(reconRes.rows[0].direction).toBe('in');
      expect(reconRes.rows[0].status).toBe('uncleared');
    });

    it('8. Bank payment with bank_account_id from wrong branch → 422', async () => {
      // Create a bank account in a different branch
      const otherBranch = await createTestBranch({ name: 'Hardening Test Other Branch' });
      const otherBaRes = await db.query(
        `INSERT INTO bank_accounts (branch_id, account_name, bank_name, account_number, currency, is_active)
         VALUES ($1, 'Other Bank', 'CBE', 'ACC-OTHER-001', 'ETB', true) RETURNING id`,
        [otherBranch.branchId],
      );
      const otherBaId = otherBaRes.rows[0].id as number;

      const orderId = await createTestOrder(adminToken, branchId, bookId);

      const res = await request(getTestApp())
        .post('/api/payments')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({ orderId, amount: bookPrice, paymentMethod: 'bank', bankAccountId: otherBaId });

      expect(res.status).toBe(422);
      expect(res.body.error).toBe('INVALID_BANK_ACCOUNT');

      // Cleanup
      await db.query(`DELETE FROM bank_accounts WHERE id = $1`, [otherBaId]);
      await db.query(`DELETE FROM branches WHERE id = $1`, [otherBranch.branchId]);
    });
  });

  // ── Idempotency ─────────────────────────────────────────────────────────────

  describe('Idempotency', () => {
    it('9. Duplicate payment with same Idempotency-Key returns stored response', async () => {
      const orderId = await createTestOrder(adminToken, branchId, bookId);
      const idempotencyKey = `test-idem-${Date.now()}`;
      const body = { orderId, amount: bookPrice, paymentMethod: 'cash' };

      const res1 = await request(getTestApp())
        .post('/api/payments')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId))
        .set('Idempotency-Key', idempotencyKey)
        .send(body);

      expect(res1.status).toBe(201);
      expect(res1.headers['x-idempotent-replayed']).toBeUndefined();

      const res2 = await request(getTestApp())
        .post('/api/payments')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId))
        .set('Idempotency-Key', idempotencyKey)
        .send(body);

      expect(res2.status).toBe(200);
      expect(res2.headers['x-idempotent-replayed']).toBe('true');
      expect(res2.body.id).toBe(res1.body.id);
    });

    it('10. Payment without Idempotency-Key works normally', async () => {
      const orderId = await createTestOrder(adminToken, branchId, bookId);

      const res = await request(getTestApp())
        .post('/api/payments')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({ orderId, amount: bookPrice, paymentMethod: 'cash' });

      expect(res.status).toBe(201);
    });
  });

  // ── Installment Plans ───────────────────────────────────────────────────────

  describe('Installment Plans', () => {
    it('11. Create installment plan for an order', async () => {
      const orderId = await createTestOrder(adminToken, branchId, bookId);

      const res = await request(getTestApp())
        .post(`/api/orders/${orderId}/installment-plan`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({ numInstallments: 3 });

      expect(res.status).toBe(201);
      expect(res.body.orderId).toBe(String(orderId));
      expect(res.body.numInstallments).toBe(3);
      expect(res.body.installments).toHaveLength(3);
      expect(res.body.currency).toBe('ETB');
    });

    it('12. Cannot create duplicate plan for same order', async () => {
      const orderId = await createTestOrder(adminToken, branchId, bookId);

      await request(getTestApp())
        .post(`/api/orders/${orderId}/installment-plan`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({ numInstallments: 2 });

      const res2 = await request(getTestApp())
        .post(`/api/orders/${orderId}/installment-plan`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({ numInstallments: 2 });

      expect(res2.status).toBe(422);
      expect(res2.body.error).toBe('PLAN_EXISTS');
    });

    it('13. GET installment plan by order', async () => {
      const orderId = await createTestOrder(adminToken, branchId, bookId);

      await request(getTestApp())
        .post(`/api/orders/${orderId}/installment-plan`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({ numInstallments: 2 });

      const res = await request(getTestApp())
        .get(`/api/orders/${orderId}/installment-plan`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId));

      expect(res.status).toBe(200);
      expect(res.body.installments).toHaveLength(2);
    });

    it('14. Record installment payment → status updates', async () => {
      const orderId = await createTestOrder(adminToken, branchId, bookId);

      const planRes = await request(getTestApp())
        .post(`/api/orders/${orderId}/installment-plan`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({ numInstallments: 2 });

      const installmentId = planRes.body.installments[0].id;
      const installmentAmount = planRes.body.installments[0].amount;

      const payRes = await request(getTestApp())
        .post(`/api/installments/${installmentId}/pay`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({ amount: installmentAmount });

      expect(payRes.status).toBe(200);
      expect(payRes.body.status).toBe('paid');
      expect(payRes.body.paidAmount).toBeCloseTo(installmentAmount, 2);
    });

    it('15. Installment payment exceeding amount → 422', async () => {
      const orderId = await createTestOrder(adminToken, branchId, bookId);

      const planRes = await request(getTestApp())
        .post(`/api/orders/${orderId}/installment-plan`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({ numInstallments: 2 });

      const installmentId = planRes.body.installments[0].id;
      const installmentAmount = planRes.body.installments[0].amount;

      const payRes = await request(getTestApp())
        .post(`/api/installments/${installmentId}/pay`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({ amount: installmentAmount * 10 });

      expect(payRes.status).toBe(422);
      expect(payRes.body.error).toBe('EXCEEDS_INSTALLMENT_AMOUNT');
    });
  });
});
