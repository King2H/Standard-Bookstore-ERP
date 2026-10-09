import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

// #90: customer phone and email were stored in plain text next to their
// encrypted copies. Only the encrypted copy and the lookup hash are kept now;
// phone and email match exactly through the hash.

const STAFF_PREFIX = 'custpii_test_';
const BRANCH_PREFIX = 'Cust PII ';
const NAME = 'Cust PII Person';
const PHONE = '0911777666';
const EMAIL = 'pii.person@example.et';

describe('Customer phone and email at rest', () => {
  let sales: string;
  let customerId: number;
  const api = () => request(getTestApp());
  const as = (r: request.Test) => r.set('Authorization', `Bearer ${sales}`);
  const found = async (q: string) =>
    (await as(api().get(`/api/v1/customers?q=${encodeURIComponent(q)}`))).body.items.map((c: { id: number }) => c.id);

  async function cleanUp() {
    const ids = (await db.query(`SELECT id FROM customers WHERE full_name = $1`, [NAME])).rows.map((r) => r.id);
    if (ids.length) {
      for (const table of ['store_credit_accounts', 'loyalty_accounts']) await db.query(`DELETE FROM ${table} WHERE customer_id = ANY($1)`, [ids]);
      await db.query(`DELETE FROM audit_logs WHERE entity_type = 'customer' AND entity_id = ANY($1::text[])`, [ids.map(String)]);
      await db.query(`DELETE FROM customers WHERE id = ANY($1)`, [ids]);
    }
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    const branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}Branch` })).branchId;
    sales = (await createTestStaff({ username: `${STAFF_PREFIX}sales`, role: 'Sales', branchId })).token;
    const res = await as(api().post('/api/v1/customers')).send({ fullName: NAME, phone: PHONE, email: EMAIL });
    expect(res.status).toBe(201);
    customerId = res.body.id;
  });

  afterAll(cleanUp);

  it('keeps no plain phone or email in the customer row (was: stored next to the encrypted copy)', async () => {
    const row = JSON.stringify((await db.query(`SELECT * FROM customers WHERE id = $1`, [customerId])).rows[0]);
    expect(row).not.toContain(PHONE);
    expect(row).not.toContain(EMAIL);
    const plainColumns = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'customers' AND column_name IN ('phone', 'email')`,
    );
    expect(plainColumns.rows).toEqual([]);
  });

  it('still shows the phone and email, decrypted', async () => {
    const res = await as(api().get(`/api/v1/customers/${customerId}`));
    expect(res.body).toMatchObject({ phone: PHONE, email: EMAIL });
  });

  it('finds the customer by the exact phone or email, in any case, but not by part of the phone', async () => {
    expect(await found(PHONE)).toEqual([customerId]);
    expect(await found(EMAIL.toUpperCase())).toEqual([customerId]);
    expect(await found(PHONE.slice(0, 6))).not.toContain(customerId);
  });

  it('still refuses a phone another customer uses', async () => {
    const res = await as(api().post('/api/v1/customers')).send({ fullName: NAME, phone: PHONE });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('DUPLICATE_CONTACT');
  });

  it('migrated customers that had only a plain phone show it from the encrypted copy (demo customer CUS-0001)', async () => {
    const res = await as(api().get('/api/v1/customers?q=CUS-0001'));
    expect(res.body.items).toEqual([expect.objectContaining({ customerCode: 'CUS-0001', phone: '555-1001', email: 'alice@example.com' })]);
  });
});
