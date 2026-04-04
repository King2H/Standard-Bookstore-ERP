import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff } from './helpers/testDb.js';
import { createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'cust_test_';

// ── Cleanup helpers ───────────────────────────────────────────────────────────

async function cleanTestCustomers() {
  await db.query(`DELETE FROM loyalty_history WHERE customer_id IN (SELECT id FROM customers WHERE full_name LIKE 'Test Customer%')`);
  await db.query(`DELETE FROM store_credit_history WHERE customer_id IN (SELECT id FROM customers WHERE full_name LIKE 'Test Customer%')`);
  await db.query(`DELETE FROM customer_group_membership WHERE customer_id IN (SELECT id FROM customers WHERE full_name LIKE 'Test Customer%')`);
  await db.query(`DELETE FROM loyalty_accounts WHERE customer_id IN (SELECT id FROM customers WHERE full_name LIKE 'Test Customer%')`);
  await db.query(`DELETE FROM store_credit_accounts WHERE customer_id IN (SELECT id FROM customers WHERE full_name LIKE 'Test Customer%')`);
  await db.query(`DELETE FROM customers WHERE full_name LIKE 'Test Customer%'`);
}

async function cleanTestGroups() {
  await db.query(`DELETE FROM customer_groups WHERE name LIKE 'Test Group%'`);
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Customer Management', () => {
  let adminToken: string;
  let managerToken: string;
  let salesToken: string;
  let financeToken: string;
  let branchId: number;

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestCustomers();
    await cleanTestGroups();

    branchId = 1;

    const admin = await createTestStaff({ username: 'cust_test_admin', role: 'Admin', branchId });
    adminToken = admin.token;

    const manager = await createTestStaff({ username: 'cust_test_manager', role: 'Manager', branchId });
    managerToken = manager.token;

    const sales = await createTestStaff({ username: 'cust_test_sales', role: 'Sales', branchId });
    salesToken = sales.token;

    const finance = await createTestStaff({ username: 'cust_test_finance', role: 'Finance_Officer', branchId });
    financeToken = finance.token;
  });

  afterAll(async () => {
    await cleanTestCustomers();
    await cleanTestGroups();
    await cleanTestStaff(STAFF_PREFIX);
  });

  // ── 1. Create customer → loyalty + store credit auto-created ────────────────

  describe('POST /api/customers', () => {
    it('creates customer with loyalty and store credit accounts auto-created', async () => {
      const res = await request(getTestApp())
        .post('/api/customers')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({ fullName: 'Test Customer Alpha', phone: '555-9001', email: 'alpha@test.com' });

      expect(res.status).toBe(201);
      expect(res.body.fullName).toBe('Test Customer Alpha');
      expect(res.body.loyaltyBalance).toBe(0);
      expect(res.body.storeCreditBalance).toBe(0);

      // Verify accounts exist in DB
      const cid = res.body.id as number;
      const la = await db.query(`SELECT * FROM loyalty_accounts WHERE customer_id = $1`, [cid]);
      const sca = await db.query(`SELECT * FROM store_credit_accounts WHERE customer_id = $1`, [cid]);
      expect(la.rows.length).toBe(1);
      expect(sca.rows.length).toBe(1);
    });

    // ── 2. customer_code auto-increments ──────────────────────────────────────

    it('customer_code auto-increments in CUS-XXXX format', async () => {
      const res1 = await request(getTestApp())
        .post('/api/customers')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({ fullName: 'Test Customer Beta' });

      const res2 = await request(getTestApp())
        .post('/api/customers')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({ fullName: 'Test Customer Gamma' });

      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);
      expect(res1.body.customerCode).toMatch(/^CUS-\d{4}$/);
      expect(res2.body.customerCode).toMatch(/^CUS-\d{4}$/);

      // Codes should be sequential
      const seq1 = parseInt(res1.body.customerCode.slice(4), 10);
      const seq2 = parseInt(res2.body.customerCode.slice(4), 10);
      expect(seq2).toBe(seq1 + 1);
    });

    // ── 3. Duplicate phone → 409 ──────────────────────────────────────────────

    it('duplicate phone returns 409 DUPLICATE_CONTACT', async () => {
      const res = await request(getTestApp())
        .post('/api/customers')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({ fullName: 'Test Customer DupPhone', phone: '555-9001' });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('DUPLICATE_CONTACT');
      expect(res.body.details?.field).toBe('phone');
    });

    // ── 4. Duplicate email → 409 ──────────────────────────────────────────────

    it('duplicate email returns 409 DUPLICATE_CONTACT', async () => {
      const res = await request(getTestApp())
        .post('/api/customers')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({ fullName: 'Test Customer DupEmail', email: 'alpha@test.com' });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('DUPLICATE_CONTACT');
      expect(res.body.details?.field).toBe('email');
    });

    // ── 14. Sales role can create customer ────────────────────────────────────

    it('Sales role can create a customer', async () => {
      const res = await request(getTestApp())
        .post('/api/customers')
        .set('Authorization', `Bearer ${salesToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({ fullName: 'Test Customer BySales' });

      expect(res.status).toBe(201);
    });

    // ── 15. Sales role cannot deactivate (403) ────────────────────────────────

    it('Sales role cannot deactivate a customer (403)', async () => {
      // First create a customer to deactivate
      const createRes = await request(getTestApp())
        .post('/api/customers')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({ fullName: 'Test Customer ToDeactivate' });

      const cid = createRes.body.id as number;

      const res = await request(getTestApp())
        .post(`/api/customers/${cid}/deactivate`)
        .set('Authorization', `Bearer ${salesToken}`)
        .set('X-Branch-Id', String(branchId));

      expect(res.status).toBe(403);
    });
  });

  // ── Loyalty tests ─────────────────────────────────────────────────────────

  describe('Loyalty', () => {
    let customerId: number;

    beforeAll(async () => {
      const res = await request(getTestApp())
        .post('/api/customers')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({ fullName: 'Test Customer LoyaltyTest' });
      customerId = res.body.id as number;
    });

    // ── 5. Loyalty accrual below threshold → no points ────────────────────────

    it('loyalty accrual below threshold → no points accrued', async () => {
      // Set min transaction amount to a high value via direct service call
      const { accruePoints } = await import('../modules/customer/customer.service.js');

      // Get current min amount from config
      const { getLoyaltyMinTransactionAmount } = await import('../modules/config/config.service.js');
      const minAmount = await getLoyaltyMinTransactionAmount();

      // Accrue with amount below threshold (use 0 if threshold is 0, otherwise use threshold - 1)
      const belowThreshold = minAmount > 0 ? minAmount - 0.01 : -1;
      if (belowThreshold < 0) {
        // Min amount is 0, so any positive amount accrues — skip this test
        console.log('Skipping: min transaction amount is 0, all amounts accrue');
        return;
      }

      await accruePoints(customerId, belowThreshold, null, { staffId: 1, role: 'Admin', branchId });

      const la = await db.query(`SELECT points_balance FROM loyalty_accounts WHERE customer_id = $1`, [customerId]);
      expect(Number(la.rows[0].points_balance)).toBe(0);
    });

    // ── 6. Loyalty accrual above threshold → correct points ───────────────────

    it('loyalty accrual above threshold → correct points (floor(amount * rate))', async () => {
      const { accruePoints } = await import('../modules/customer/customer.service.js');
      const { getLoyaltyAccrualRate, getLoyaltyMinTransactionAmount } = await import('../modules/config/config.service.js');

      const rate = await getLoyaltyAccrualRate();
      const minAmount = await getLoyaltyMinTransactionAmount();
      const amount = Math.max(minAmount + 1, 100);
      const expectedPoints = Math.floor(amount * rate);

      await accruePoints(customerId, amount, 'TXN-001', { staffId: 1, role: 'Admin', branchId });

      const la = await db.query(`SELECT points_balance FROM loyalty_accounts WHERE customer_id = $1`, [customerId]);
      expect(Number(la.rows[0].points_balance)).toBe(expectedPoints);
    });

    // ── 7. Loyalty redeem insufficient balance → 422 ──────────────────────────

    it('loyalty redeem insufficient balance → 422 INSUFFICIENT_LOYALTY_POINTS', async () => {
      const la = await db.query(`SELECT points_balance FROM loyalty_accounts WHERE customer_id = $1`, [customerId]);
      const balance = Number(la.rows[0].points_balance);

      const res = await request(getTestApp())
        .post(`/api/customers/${customerId}/loyalty/redeem`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({ points: balance + 9999 });

      expect(res.status).toBe(422);
      expect(res.body.error).toBe('INSUFFICIENT_LOYALTY_POINTS');
    });

    // ── 8. Loyalty redeem success → balance decreases ─────────────────────────

    it('loyalty redeem success → balance decreases', async () => {
      const laBefore = await db.query(`SELECT points_balance FROM loyalty_accounts WHERE customer_id = $1`, [customerId]);
      const balanceBefore = Number(laBefore.rows[0].points_balance);

      if (balanceBefore < 1) {
        console.log('Skipping: no points to redeem');
        return;
      }

      const redeemAmt = 1;
      const res = await request(getTestApp())
        .post(`/api/customers/${customerId}/loyalty/redeem`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({ points: redeemAmt, transactionRef: 'TXN-REDEEM' });

      expect(res.status).toBe(200);

      const laAfter = await db.query(`SELECT points_balance FROM loyalty_accounts WHERE customer_id = $1`, [customerId]);
      expect(Number(laAfter.rows[0].points_balance)).toBe(balanceBefore - redeemAmt);
    });
  });

  // ── Store Credit tests ────────────────────────────────────────────────────

  describe('Store Credit', () => {
    let customerId: number;

    beforeAll(async () => {
      const res = await request(getTestApp())
        .post('/api/customers')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({ fullName: 'Test Customer CreditTest' });
      customerId = res.body.id as number;
    });

    // ── 10. Store credit credit → balance increases ───────────────────────────

    it('store credit credit → balance increases', async () => {
      const res = await request(getTestApp())
        .post(`/api/customers/${customerId}/store-credit/adjust`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({ amount: 50.00, direction: 'credit', refType: 'manual', refId: 'REF-001' });

      expect(res.status).toBe(200);

      const sca = await db.query(`SELECT balance FROM store_credit_accounts WHERE customer_id = $1`, [customerId]);
      expect(Number(sca.rows[0].balance)).toBe(50.00);
    });

    // ── 9. Store credit debit insufficient → 422 ─────────────────────────────

    it('store credit debit insufficient → 422 INSUFFICIENT_STORE_CREDIT', async () => {
      const res = await request(getTestApp())
        .post(`/api/customers/${customerId}/store-credit/adjust`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({ amount: 9999.00, direction: 'debit' });

      expect(res.status).toBe(422);
      expect(res.body.error).toBe('INSUFFICIENT_STORE_CREDIT');
    });
  });

  // ── Search tests ──────────────────────────────────────────────────────────

  describe('GET /api/customers (search)', () => {
    let searchCustomerId: number;

    beforeAll(async () => {
      const res = await request(getTestApp())
        .post('/api/customers')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({ fullName: 'Test Customer SearchTarget', phone: '555-SRCH', email: 'search@test.com' });
      searchCustomerId = res.body.id as number;
    });

    // ── 11. Search by name ────────────────────────────────────────────────────

    it('search by name returns correct customer', async () => {
      const res = await request(getTestApp())
        .get('/api/customers?q=SearchTarget')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId));

      expect(res.status).toBe(200);
      expect(res.body.items.some((c: { id: number }) => c.id === searchCustomerId)).toBe(true);
    });

    // ── 12. Search by phone ───────────────────────────────────────────────────

    it('search by phone returns correct customer', async () => {
      const res = await request(getTestApp())
        .get('/api/customers?q=555-SRCH')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId));

      expect(res.status).toBe(200);
      expect(res.body.items.some((c: { id: number }) => c.id === searchCustomerId)).toBe(true);
    });
  });

  // ── 13. Deactivate customer ───────────────────────────────────────────────

  describe('POST /api/customers/:id/deactivate', () => {
    it('deactivates customer → is_active=false', async () => {
      const createRes = await request(getTestApp())
        .post('/api/customers')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({ fullName: 'Test Customer DeactivateMe' });

      const cid = createRes.body.id as number;

      const res = await request(getTestApp())
        .post(`/api/customers/${cid}/deactivate`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Branch-Id', String(branchId));

      expect(res.status).toBe(200);

      const check = await db.query(`SELECT is_active FROM customers WHERE id = $1`, [cid]);
      expect(check.rows[0].is_active).toBe(false);
    });
  });
});
