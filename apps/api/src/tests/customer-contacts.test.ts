import { createRequire } from 'node:module';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';
import { decryptPii, piiLookupHash } from '../lib/piiEncryption.js';
import { ownerDb } from './helpers/ownerDb.js';

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

  // A customer from before the migration, with only plain contacts (the demo customers had them; a
  // fresh install no longer keeps those, so one is made here). Rolled back: the plain columns return
  // only for this test.
  it('migrated customers that had only a plain phone show it from the encrypted copy', async () => {
    const migration = createRequire(import.meta.url)('../db/migrations/1700000052_customer_contacts_encrypted_only.cjs') as {
      up: (pgm: { db: { query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }; dropColumns: (table: string, columns: string[]) => void }) => Promise<void>;
    };
    const client = await ownerDb().connect();
    try {
      await client.query('BEGIN');
      await client.query(`ALTER TABLE customers ADD COLUMN phone text, ADD COLUMN email text`);
      const id = (await client.query(
        `INSERT INTO customers (tenant_id, customer_code, full_name, phone, email) VALUES (1, 'CUS-PII-OLD', $1, '555-1001', 'Alice@Example.com') RETURNING id`,
        [NAME],
      )).rows[0].id;
      const dropped: string[] = [];
      await migration.up({ db: client, dropColumns: (table, columns) => dropped.push(`ALTER TABLE ${table} DROP COLUMN ${columns.join(', DROP COLUMN ')}`) });
      for (const statement of dropped) await client.query(statement);

      const row = (await client.query(`SELECT phone_encrypted, email_encrypted, phone_lookup, email_lookup FROM customers WHERE id = $1`, [id])).rows[0];
      expect({ phone: decryptPii(row.phone_encrypted), email: decryptPii(row.email_encrypted) }).toEqual({ phone: '555-1001', email: 'Alice@Example.com' });
      expect({ phone: row.phone_lookup, email: row.email_lookup }).toEqual({ phone: piiLookupHash('555-1001'), email: piiLookupHash('alice@example.com') });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
