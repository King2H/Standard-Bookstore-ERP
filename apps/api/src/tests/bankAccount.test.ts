import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches, cleanBankAccounts } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'ba_test_';
const BRANCH_PREFIX = 'BA Test ';

describe('Bank Accounts', () => {
  let adminToken: string;
  let managerToken: string;
  let financeToken: string;
  let salesToken: string;
  let branchId: number;

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);

    const branch = await createTestBranch({ name: 'BA Test Branch' });
    branchId = branch.branchId;

    const admin = await createTestStaff({ username: 'ba_test_admin', role: 'Admin', branchId });
    adminToken = admin.token;

    const mgr = await createTestStaff({ username: 'ba_test_manager', role: 'Manager', branchId });
    managerToken = mgr.token;

    const fin = await createTestStaff({ username: 'ba_test_finance', role: 'Finance_Officer', branchId });
    financeToken = fin.token;

    const sales = await createTestStaff({ username: 'ba_test_sales', role: 'Sales', branchId });
    salesToken = sales.token;
  });

  afterAll(async () => {
    await cleanBankAccounts(branchId);
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  // ── Create ──────────────────────────────────────────────────────────────

  it('Admin can create a bank account', async () => {
    const app = getTestApp();
    const res = await request(app)
      .post(`/api/branches/${branchId}/bank-accounts`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        accountName: 'Main Operations',
        bankName: 'First National Bank',
        accountNumber: '1234567890',
        iban: 'GB29NWBK60161331926819',
        currency: 'USD',
      });

    expect(res.status).toBe(201);
    expect(res.body.accountName).toBe('Main Operations');
    expect(res.body.bankName).toBe('First National Bank');
    expect(res.body.currency).toBe('USD');
    expect(res.body.isActive).toBe(true);

    // Account number must be masked — never plaintext
    expect(res.body.accountNumberMasked).toMatch(/^\*{4}\d{4}$/);
    expect(res.body.accountNumberMasked).not.toContain('1234567890');

    // IBAN must be masked
    expect(res.body.ibanMasked).toMatch(/^\*{4}.+$/);

    // Verify audit log
    const audit = await db.query(
      `SELECT * FROM audit_logs WHERE entity_type = 'bank_account' AND entity_id = $1`,
      [String(res.body.id)],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    expect(audit.rows[0].action).toBe('CREATE');
  });

  it('Manager can create a bank account', async () => {
    const app = getTestApp();
    const res = await request(app)
      .post(`/api/branches/${branchId}/bank-accounts`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        accountName: 'Petty Cash',
        bankName: 'City Bank',
        accountNumber: '9876543210',
        currency: 'USD',
      });

    expect(res.status).toBe(201);
    expect(res.body.ibanMasked).toBeNull();
  });

  it('Sales role cannot create a bank account (403)', async () => {
    const app = getTestApp();
    const res = await request(app)
      .post(`/api/branches/${branchId}/bank-accounts`)
      .set('Authorization', `Bearer ${salesToken}`)
      .send({
        accountName: 'Unauthorized',
        bankName: 'Some Bank',
        accountNumber: '111',
        currency: 'USD',
      });

    expect(res.status).toBe(403);
  });

  it('Finance_Officer can read bank accounts', async () => {
    const app = getTestApp();
    const res = await request(app)
      .get(`/api/branches/${branchId}/bank-accounts`)
      .set('Authorization', `Bearer ${financeToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThan(0);

    // All account numbers must be masked
    for (const acct of res.body.items) {
      expect(acct.accountNumberMasked).toMatch(/^\*{4}/);
    }
  });

  it('Account number is encrypted at rest', async () => {
    // Verify the raw DB value is NOT the plaintext account number
    const raw = await db.query(
      `SELECT account_number FROM bank_accounts WHERE branch_id = $1 LIMIT 1`,
      [branchId],
    );
    expect(raw.rows.length).toBeGreaterThan(0);
    expect(raw.rows[0].account_number).not.toBe('1234567890');
    expect(raw.rows[0].account_number).not.toBe('9876543210');
    // Should be base64-encoded ciphertext
    expect(raw.rows[0].account_number.length).toBeGreaterThan(20);
  });

  // ── Deactivate ──────────────────────────────────────────────────────────

  it('Admin can deactivate a bank account', async () => {
    const app = getTestApp();

    // Create one to deactivate
    const createRes = await request(app)
      .post(`/api/branches/${branchId}/bank-accounts`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ accountName: 'To Deactivate', bankName: 'Test Bank', accountNumber: '555', currency: 'EUR' });

    const id = createRes.body.id;

    const deactivateRes = await request(app)
      .post(`/api/branches/${branchId}/bank-accounts/${id}/deactivate`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(deactivateRes.status).toBe(200);

    // Verify in DB
    const dbResult = await db.query(`SELECT is_active FROM bank_accounts WHERE id = $1`, [id]);
    expect(dbResult.rows[0].is_active).toBe(false);

    // Verify audit log
    const audit = await db.query(
      `SELECT * FROM audit_logs WHERE entity_type = 'bank_account' AND entity_id = $1 AND action = 'DEACTIVATE'`,
      [String(id)],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
  });

  // ── Reconciliation ──────────────────────────────────────────────────────

  it('Admin can import reconciliation rows', async () => {
    const app = getTestApp();

    // Get an account id
    const listRes = await request(app)
      .get(`/api/branches/${branchId}/bank-accounts`)
      .set('Authorization', `Bearer ${adminToken}`);
    const accountId = listRes.body.items[0].id;

    const importRes = await request(app)
      .post(`/api/branches/${branchId}/reconciliation/import?bankAccountId=${accountId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        rows: [
          { amount: 500.00, direction: 'in',  statementDate: '2026-04-01', notes: 'Customer payment' },
          { amount: 120.50, direction: 'out', statementDate: '2026-04-02', notes: 'Supplier refund' },
        ],
      });

    expect(importRes.status).toBe(201);
    expect(importRes.body.imported).toBe(2);

    // Verify entries in DB
    const entries = await db.query(
      `SELECT * FROM bank_reconciliation WHERE bank_account_id = $1`,
      [accountId],
    );
    expect(entries.rows.length).toBeGreaterThanOrEqual(2);
  });

  it('Finance_Officer can clear a reconciliation entry', async () => {
    const app = getTestApp();

    // Get an uncleared entry
    const listRes = await request(app)
      .get(`/api/branches/${branchId}/bank-accounts`)
      .set('Authorization', `Bearer ${adminToken}`);
    const accountId = listRes.body.items[0].id;

    const reconRes = await request(app)
      .get(`/api/branches/${branchId}/reconciliation?bankAccountId=${accountId}&status=unmatched`)
      .set('Authorization', `Bearer ${financeToken}`);

    expect(reconRes.status).toBe(200);
    if (reconRes.body.items.length === 0) return; // no entries to clear

    const entryId = reconRes.body.items[0].id;

    const clearRes = await request(app)
      .put(`/api/branches/${branchId}/reconciliation/${entryId}`)
      .set('Authorization', `Bearer ${financeToken}`)
      .send({ paymentRefId: null });

    expect(clearRes.status).toBe(200);
    expect(clearRes.body.status).toBe('cleared');
  });

  it('Clearing an already-cleared entry returns 409', async () => {
    const app = getTestApp();

    // Get a cleared entry
    const listRes = await request(app)
      .get(`/api/branches/${branchId}/bank-accounts`)
      .set('Authorization', `Bearer ${adminToken}`);
    const accountId = listRes.body.items[0].id;

    const reconRes = await request(app)
      .get(`/api/branches/${branchId}/reconciliation?bankAccountId=${accountId}&status=cleared`)
      .set('Authorization', `Bearer ${adminToken}`);

    if (reconRes.body.items.length === 0) return; // skip if no cleared entries yet

    const entryId = reconRes.body.items[0].id;

    const clearRes = await request(app)
      .put(`/api/branches/${branchId}/reconciliation/${entryId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ paymentRefId: null });

    expect(clearRes.status).toBe(409);
    expect(clearRes.body.error).toBe('ALREADY_CLEARED');
  });

  it('Import with empty rows returns 400', async () => {
    const app = getTestApp();
    const listRes = await request(app)
      .get(`/api/branches/${branchId}/bank-accounts`)
      .set('Authorization', `Bearer ${adminToken}`);
    const accountId = listRes.body.items[0].id;

    const res = await request(app)
      .post(`/api/branches/${branchId}/reconciliation/import?bankAccountId=${accountId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rows: [] });

    expect(res.status).toBe(400);
  });
});
