import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches, cleanBankAccounts } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';
import { db } from '../db/index.js';

// Bank Accounts is off by default (FEATURE_BANK_ACCOUNTS); these tests exercise it switched on.
process.env.FEATURE_BANK_ACCOUNTS = 'true';

const STAFF_PREFIX = 'ba_test_';
const BRANCH_PREFIX = 'BA Test ';

describe('Bank Accounts', () => {
  let adminToken: string;
  let managerToken: string;
  let financeToken: string;
  let salesToken: string;
  let branchId: number;
  const api = () => request(getTestApp());
  const url = (path = '') => `/api/v1/branches/${branchId}/bank-accounts${path}`;

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    const old = await db.query(`SELECT id FROM branches WHERE name LIKE $1`, [`${BRANCH_PREFIX}%`]);
    for (const b of old.rows) await cleanBankAccounts(b.id);
    await cleanTestBranches(BRANCH_PREFIX);

    branchId = (await createTestBranch({ name: 'BA Test Branch' })).branchId;
    adminToken = (await createTestStaff({ username: 'ba_test_admin', role: 'Admin', branchId })).token;
    managerToken = (await createTestStaff({ username: 'ba_test_manager', role: 'Manager', branchId })).token;
    financeToken = (await createTestStaff({ username: 'ba_test_finance', role: 'Finance_Officer', branchId })).token;
    salesToken = (await createTestStaff({ username: 'ba_test_sales', role: 'Sales', branchId })).token;
  });

  afterAll(async () => {
    await cleanBankAccounts(branchId);
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  it('Admin creates an account, masked and audited', async () => {
    const res = await api()
      .post(url())
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ accountName: 'Main Operations', bankName: 'CBE', accountNumber: '1000123456789', iban: 'ET29NWBK60161331926819' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ accountName: 'Main Operations', bankName: 'CBE', currency: 'ETB', isActive: true, hasMovements: false });
    expect(res.body.accountNumberMasked).toBe('****6789');
    expect(res.body.ibanMasked).toMatch(/^\*{4}.{4}$/);

    const audit = await db.query(`SELECT 1 FROM audit_logs WHERE entity_type = 'bank_account' AND entity_id = $1 AND action = 'CREATE'`, [
      String(res.body.id),
    ]);
    expect(audit.rows).toHaveLength(1);
  });

  it('Manager creates an account; Sales cannot', async () => {
    const res = await api().post(url()).set('Authorization', `Bearer ${managerToken}`).send({ accountName: 'Petty', bankName: 'Awash', accountNumber: '9876543210' });
    expect(res.status).toBe(201);
    expect(res.body.ibanMasked).toBeNull();

    const denied = await api().post(url()).set('Authorization', `Bearer ${salesToken}`).send({ accountName: 'X', bankName: 'Y', accountNumber: '12345' });
    expect(denied.status).toBe(403);
  });

  it('Finance_Officer reads the accounts', async () => {
    const res = await api().get(url()).set('Authorization', `Bearer ${financeToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the account number encrypted at rest, with a lookup hash', async () => {
    const { rows } = await db.query(`SELECT account_number, account_number_hash FROM bank_accounts WHERE branch_id = $1`, [branchId]);
    for (const r of rows) {
      expect(r.account_number).not.toMatch(/^\d+$/);
      expect(r.account_number_hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('deactivates and reactivates an account, audited', async () => {
    const id = (await api().post(url()).set('Authorization', `Bearer ${adminToken}`).send({ accountName: 'Toggle', bankName: 'CBE', accountNumber: '55501' })).body.id;

    const off = await api().post(url(`/${id}/deactivate`)).set('Authorization', `Bearer ${adminToken}`);
    expect(off.status).toBe(200);
    expect(off.body.isActive).toBe(false);
    const on = await api().post(url(`/${id}/reactivate`)).set('Authorization', `Bearer ${adminToken}`);
    expect(on.body.isActive).toBe(true);

    const { rows } = await db.query(`SELECT action FROM audit_logs WHERE entity_type = 'bank_account' AND entity_id = $1 ORDER BY id`, [String(id)]);
    expect(rows.map((r) => r.action)).toEqual(['CREATE', 'INACTIVATE', 'ACTIVATE']);
  });

  it('imports statement lines (Finance_Officer), refusing an empty statement', async () => {
    const id = (await api().get(url()).set('Authorization', `Bearer ${financeToken}`)).body.items[0].id;
    const res = await api()
      .post(url(`/${id}/statement-lines`))
      .set('Authorization', `Bearer ${financeToken}`)
      .send({ lines: [{ statementDate: '2026-10-01', amount: 150.5, direction: 'in', reference: 'BA-TEST-1' }] });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ imported: 1, matched: 0, duplicates: 0 });

    const empty = await api().post(url(`/${id}/statement-lines`)).set('Authorization', `Bearer ${financeToken}`).send({ lines: [] });
    expect(empty.status).toBe(400);
  });

  // The page matches a statement line to an open movement of its amount and
  // direction; it read only the newest 100 open movements, so an older one
  // that fits was never offered (owner decision 3a).
  it('lists open movements of one amount and direction, however many others are open', async () => {
    const id = (await api().get(url()).set('Authorization', `Bearer ${financeToken}`)).body.items[0].id;
    await db.query(
      `INSERT INTO bank_reconciliation (bank_account_id, amount, direction, status, source_type, source_id, notes, created_at)
       VALUES ($1, 37.50, 'in', 'uncleared', 'order_payment', 'ba-filter-fit', 'The one that fits', now() - interval '2 days'),
              ($1, 37.50, 'out', 'uncleared', 'order_refund', 'ba-filter-out', NULL, now() - interval '2 days'),
              ($1, 37.50, 'in', 'cleared', 'order_payment', 'ba-filter-cleared', NULL, now() - interval '2 days')`,
      [id],
    );
    await db.query(
      `INSERT INTO bank_reconciliation (bank_account_id, amount, direction, status, source_type, source_id, created_at)
       SELECT $1, 10, 'in', 'uncleared', 'order_payment', 'ba-filter-' || n, now() FROM generate_series(1, 105) n`,
      [id],
    );

    const all = await api().get(url(`/${id}/entries?status=uncleared&pageSize=100`)).set('Authorization', `Bearer ${financeToken}`);
    expect(all.body.total).toBe(107);
    expect(all.body.items.some((e: { notes: string | null }) => e.notes === 'The one that fits')).toBe(false);

    const res = await api()
      .get(url(`/${id}/entries?status=uncleared&amount=37.5&direction=in`))
      .set('Authorization', `Bearer ${financeToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items.map((e: { notes: string | null }) => e.notes)).toEqual(['The one that fits']);

    const bad = await api().get(url(`/${id}/entries?amount=1.005`)).set('Authorization', `Bearer ${financeToken}`);
    expect(bad.status).toBe(400);
  });

  it('answers 410 to the retired v1 reconciliation endpoints', async () => {
    const base = `/api/v1/branches/${branchId}/reconciliation`;
    for (const res of [
      await api().get(`${base}?bankAccountId=1`).set('Authorization', `Bearer ${adminToken}`),
      await api().post(`${base}/import?bankAccountId=1`).set('Authorization', `Bearer ${adminToken}`).send({}),
      await api().put(`${base}/1`).set('Authorization', `Bearer ${adminToken}`).send({}),
    ]) {
      expect(res.status).toBe(410);
      expect(res.body.error).toBe('DEPRECATED');
    }
  });
});
