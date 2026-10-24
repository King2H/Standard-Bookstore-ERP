/**
 * shop-currency.test.ts
 *
 * #181 (owner decisions 1a, 2a, 3a, 2026-10-24): every record stores the
 * shop's currency when it is made, not a fixed ETB. The database names no
 * currency of its own: each insert gives it (1a). Records made before are put
 * in their shop's currency by the migration (2a). The currency stays while
 * anything is kept in it, a draft purchase order or a bank account included
 * (3a); the sample purchase orders of a fresh install go where still untouched
 * (owner decision, 2026-10-24). Each test names what happened before.
 */
import { createRequire } from 'node:module';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { ownerDb } from './helpers/ownerDb.js';
import { cleanTestStaff, cleanTestBranches, cleanBankAccounts } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';
import { db } from '../db/index.js';
import { DEFAULT_ADMIN_PASSWORD_HASH } from '../db/seed.js';

process.env.FEATURE_BANK_ACCOUNTS = 'true';

const STAFF_PREFIX = 'shopcur_test_';
const BRANCH_PREFIX = 'Shop Currency ';
const CUSTOMER_CODE = 'SHOPCUR-001';
const TENANT = 'Shop Currency Test Tenant';

// Every table that stores a currency, and how to find this test's rows in it.
const RECORDS: Array<[table: string, where: string]> = [
  ['transactions', 'branch_id IN (BRANCHES)'],
  ['orders', 'branch_id IN (BRANCHES)'],
  ['order_payments', 'order_id IN (SELECT id FROM orders WHERE branch_id IN (BRANCHES))'],
  ['receivables', 'branch_id IN (BRANCHES)'],
  ['financial_transactions', 'branch_id IN (BRANCHES)'],
  ['exchanges', 'branch_id IN (BRANCHES)'],
  ['exchange_settlement_entries', 'exchange_id IN (SELECT id FROM exchanges WHERE branch_id IN (BRANCHES))'],
  ['purchase_orders', 'branch_id IN (BRANCHES)'],
  ['bank_accounts', 'branch_id IN (BRANCHES)'],
];

describe("Records carry the shop's currency", () => {
  let branchId: number;
  let locationId: number;
  let customerId: number;
  let supplierId: number;
  let bookA: number;
  let bookB: number;
  let priceB: number;
  let manager: string;
  const api = () => request(getTestApp());
  const as = (r: request.Test, token = manager) => r.set('Authorization', `Bearer ${token}`).set('X-Branch-Id', String(branchId));
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  const branches = `SELECT id FROM branches WHERE name LIKE '${BRANCH_PREFIX}%'`;
  const setShopCurrency = (currency: string) =>
    ownerDb().query(`UPDATE system_config SET value = $1::jsonb WHERE tenant_id = 1 AND key = 'base_currency'`, [JSON.stringify(currency)]);

  async function cleanUp() {
    const orders = `SELECT id FROM orders WHERE branch_id IN (${branches})`;
    const customer = `SELECT id FROM customers WHERE customer_code = '${CUSTOMER_CODE}'`;
    for (const b of (await db.query(branches)).rows) await cleanBankAccounts(b.id);
    for (const statement of [
      `DELETE FROM order_refunds WHERE payment_id IN (SELECT id FROM order_payments WHERE order_id IN (${orders}))`,
      `DELETE FROM order_payments WHERE order_id IN (${orders})`,
      `DELETE FROM financial_transactions WHERE branch_id IN (${branches})`,
      `DELETE FROM receivables WHERE branch_id IN (${branches})`,
      `DELETE FROM inventory_reservations WHERE order_id IN (${orders})`,
      `DELETE FROM order_line_items WHERE order_id IN (${orders})`,
      `DELETE FROM orders WHERE id IN (${orders})`,
      `DELETE FROM transaction_payments WHERE transaction_id IN (SELECT id FROM transactions WHERE branch_id IN (${branches}))`,
      `DELETE FROM transaction_line_items WHERE transaction_id IN (SELECT id FROM transactions WHERE branch_id IN (${branches}))`,
      `DELETE FROM transactions WHERE branch_id IN (${branches})`,
      `DELETE FROM exchange_settlement_entries WHERE exchange_id IN (SELECT id FROM exchanges WHERE branch_id IN (${branches}))`,
      `DELETE FROM exchange_incoming_items WHERE exchange_id IN (SELECT id FROM exchanges WHERE branch_id IN (${branches}))`,
      `DELETE FROM exchange_outgoing_items WHERE exchange_id IN (SELECT id FROM exchanges WHERE branch_id IN (${branches}))`,
      `DELETE FROM exchanges WHERE branch_id IN (${branches})`,
      `DELETE FROM po_line_items WHERE po_id IN (SELECT id FROM purchase_orders WHERE branch_id IN (${branches}))`,
      `DELETE FROM purchase_orders WHERE branch_id IN (${branches})`,
      `DELETE FROM suppliers WHERE name = '${BRANCH_PREFIX}Supplier'`,
      `DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM store_credit_history WHERE customer_id IN (${customer})`,
      `DELETE FROM store_credit_accounts WHERE customer_id IN (${customer})`,
      `DELETE FROM loyalty_history WHERE customer_id IN (${customer})`,
      `DELETE FROM loyalty_accounts WHERE customer_id IN (${customer})`,
    ]) {
      await db.query(statement);
    }
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
    await db.query(`DELETE FROM customers WHERE customer_code = $1`, [CUSTOMER_CODE]);
  }

  async function cleanUpTenant() {
    const owner = ownerDb();
    const tenants = `SELECT id FROM tenants WHERE name = '${TENANT}'`;
    await owner.query(`DELETE FROM refresh_tokens WHERE session_id IN (SELECT id FROM staff_sessions WHERE tenant_id IN (${tenants}))`);
    for (const table of [
      'audit_logs', 'outbox', 'po_line_items', 'purchase_orders', 'bank_accounts', 'suppliers', 'books', 'system_config',
      'staff_branch_roles', 'staff_sessions', 'staff', 'branches',
    ]) {
      await owner.query(`DELETE FROM ${table} WHERE tenant_id IN (${tenants})`);
    }
    await owner.query(`DELETE FROM tenants WHERE name = '${TENANT}'`);
  }

  beforeAll(async () => {
    await cleanUp();
    await cleanUpTenant();
    branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    manager = (await createTestStaff({ username: `${STAFF_PREFIX}mgr`, role: 'Manager', branchId })).token;
    locationId = (await one(
      `INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Shop Currency Loc', true) RETURNING id`,
      [branchId],
    )).id;
    const books = (await db.query(`SELECT id, default_price FROM books WHERE is_active = true AND default_price > 10 ORDER BY id LIMIT 2`)).rows;
    bookA = books[0].id;
    bookB = books[1].id;
    priceB = Number(books[1].default_price);
    for (const bookId of [bookA, bookB]) {
      await db.query(`INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version) VALUES ($1, $2, 500, 5, 0)`, [bookId, locationId]);
    }
    customerId = (await one(
      `INSERT INTO customers (full_name, customer_code, is_active) VALUES ('Shop Currency Customer', $1, true) RETURNING id`,
      [CUSTOMER_CODE],
    )).id;
    supplierId = (await one(`INSERT INTO suppliers (name, contact_info) VALUES ($1, '{}') RETURNING id`, [`${BRANCH_PREFIX}Supplier`])).id;
    // Set as an install would before any money is recorded.
    await setShopCurrency('USD');
  });

  afterAll(async () => {
    await setShopCurrency('ETB');
    await cleanUp();
    await cleanUpTenant();
  });

  describe('every record is made in it (1a)', () => {
    it('stores the shop\'s currency on sales, orders, payments, receivables, exchanges, purchase orders and bank accounts (was: ETB)', async () => {
      const sale = await as(api().post('/api/v1/pos/transactions')).send({
        locationId, items: [{ bookId: bookB, quantity: 1 }], payments: [{ method: 'cash', amount: priceB }],
      });
      expect(sale.status).toBe(201);
      const credit = await as(api().post('/api/v1/pos/transactions')).send({
        locationId, items: [{ bookId: bookB, quantity: 1 }], payments: [], customerId, allowCredit: true,
      });
      expect(credit.status).toBe(201);
      const posDebt = String((await one(`SELECT id FROM receivables WHERE source_type = 'pos_credit_sale' AND source_entity_id = $1`, [credit.body.id])).id);
      expect((await as(api().post(`/api/v1/receivables/${posDebt}/collect`)).send({ amount: 1, paymentMethod: 'cash' })).status).toBe(200);

      const order = await as(api().post('/api/v1/orders')).send({ locationId, saleType: 'cash_sale', items: [{ bookId: bookB, quantity: 1 }] });
      expect(order.status).toBe(201);
      expect((await as(api().post(`/api/v1/orders/${order.body.id}/confirm`)).send({ paymentMethod: 'cash' })).status).toBe(200);
      const creditOrder = await as(api().post('/api/v1/orders')).send({ locationId, saleType: 'credit_sale', customerId, items: [{ bookId: bookB, quantity: 1 }] });
      expect((await as(api().post(`/api/v1/orders/${creditOrder.body.id}/confirm`)).send({ dueDate: '2099-12-31' })).status).toBe(200);
      expect((await as(api().post('/api/v1/payments')).send({ orderId: Number(creditOrder.body.id), amount: 1, paymentMethod: 'cash' })).status).toBe(201);

      const exchange = (body: object) => as(api().post('/api/v1/exchanges')).send({
        locationId, customerId,
        incomingItems: [{ bookId: bookA, quantity: 1, unitPrice: 1 }],
        outgoingItems: [{ bookId: bookB, quantity: 1 }],
        ...body,
      });
      expect((await exchange({ payments: [{ method: 'cash', amount: priceB - 1 }] })).status).toBe(201);
      const onCredit = await exchange({ allowCredit: true });
      expect(onCredit.status).toBe(201);
      const exchangeDebt = String((await one(`SELECT id FROM receivables WHERE source_type = 'exchange_difference' AND source_entity_id = $1`, [onCredit.body.id])).id);
      expect((await as(api().post(`/api/v1/receivables/${exchangeDebt}/collect`)).send({ amount: 1, paymentMethod: 'cash' })).status).toBe(200);

      const po = await as(api().post('/api/v1/purchase-orders')).send({
        supplierId, receivingBranchId: branchId, receivingLocationId: locationId, lineItems: [{ bookId: bookA, quantity: 2, unitCost: 5 }],
      });
      expect(po.status).toBe(201);
      expect(po.body.currency).toBe('USD');
      const account = await as(api().post(`/api/v1/branches/${branchId}/bank-accounts`)).send({
        accountName: 'Shop Currency', bankName: 'CBE', accountNumber: '8200001',
      });
      expect(account.status).toBe(201);
      expect(account.body.currency).toBe('USD');

      for (const [table, where] of RECORDS) {
        const { rows } = await db.query(`SELECT DISTINCT currency FROM ${table} WHERE ${where.replaceAll('BRANCHES', branches)}`);
        expect({ table, currencies: rows.map((r) => r.currency) }).toEqual({ table, currencies: ['USD'] });
      }
    });

    it("lists a POS collection in the shop's currency in the payment history (was: ETB)", async () => {
      const history = await as(api().get('/api/v1/payments?pageSize=100'));
      expect(history.status).toBe(200);
      const pos = history.body.items.filter((p: { sourceType: string }) => p.sourceType === 'pos');
      expect(pos.length).toBeGreaterThan(0);
      expect(new Set(pos.map((p: { currency: string }) => p.currency))).toEqual(new Set(['USD']));
    });

    it("refuses a purchase order or bank account in another currency, and takes the shop's (was: ETB only)", async () => {
      const po = (currency: string) => as(api().post('/api/v1/purchase-orders')).send({
        supplierId, receivingBranchId: branchId, receivingLocationId: locationId, currency, lineItems: [{ bookId: bookA, quantity: 1, unitCost: 5 }],
      });
      const etb = await po('ETB');
      expect(etb.status).toBe(400);
      expect(etb.body.error).toBe('VALIDATION_ERROR');
      expect((await po('USD')).status).toBe(201);

      const account = (currency: string, accountNumber: string) => as(api().post(`/api/v1/branches/${branchId}/bank-accounts`)).send({
        accountName: 'Shop Currency', bankName: 'CBE', accountNumber, currency,
      });
      const refused = await account('ETB', '8200002');
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe('VALIDATION_ERROR');
      expect((await account('USD', '8200003')).status).toBe(201);
    });

    it('has no currency of its own in the database, so a record that names none is refused (was: ETB)', async () => {
      const defaults = (await db.query(
        `SELECT table_name FROM information_schema.columns
         WHERE table_schema = 'public' AND column_name = 'currency' AND column_default IS NOT NULL ORDER BY 1`,
      )).rows;
      expect(defaults).toEqual([]);
      await expect(db.query(
        `INSERT INTO orders (order_number, branch_id, created_by) VALUES ('${STAFF_PREFIX}none', $1, 1)`, [branchId],
      )).rejects.toThrow(/currency/);
      await expect(db.query(
        `INSERT INTO orders (order_number, branch_id, created_by, currency) VALUES ('${STAFF_PREFIX}bad', $1, 1, 'Birr')`, [branchId],
      )).rejects.toThrow(/currency/);
    });
  });

  describe('it stays while anything is kept in it (3a)', () => {
    let tenant: number;
    let token: string;
    let tenantBranch: number;
    let staff: number;
    const setCurrency = (value: string) => api().put('/api/v1/config/system/base_currency').set('Authorization', `Bearer ${token}`).send({ value });

    beforeAll(async () => {
      const owner = ownerDb();
      tenant = (await owner.query(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [TENANT])).rows[0].id;
      tenantBranch = (await owner.query(
        `INSERT INTO branches (tenant_id, name, address, contact_info, operating_hours) VALUES ($1, 'Main Branch', '-', '{}', '{}') RETURNING id`,
        [tenant],
      )).rows[0].id;
      staff = (await owner.query(
        `INSERT INTO staff (tenant_id, username, password_hash, full_name, is_active, must_change_password)
         VALUES ($1, $2, $3, 'Shop Currency', true, false) RETURNING id`,
        [tenant, `${STAFF_PREFIX}tenant_sa`, DEFAULT_ADMIN_PASSWORD_HASH],
      )).rows[0].id;
      await owner.query(`INSERT INTO staff_branch_roles (tenant_id, staff_id, branch_id, role) VALUES ($1, $2, $3, 'Super_Admin')`, [tenant, staff, tenantBranch]);
      await owner.query(`INSERT INTO system_config (tenant_id, key, value, updated_by) VALUES ($1, 'base_currency', '"ETB"', $2)`, [tenant, staff]);
      const login = await api().post('/api/v1/auth/login').send({ username: `${STAFF_PREFIX}tenant_sa`, password: 'Admin@1234', branchId: tenantBranch });
      expect(login.status).toBe(200);
      token = login.body.accessToken;
    });

    it('is refused while a draft purchase order is kept in it, naming what holds it (was: changed, the draft relabelled)', async () => {
      const owner = ownerDb();
      const supplier = (await owner.query(`INSERT INTO suppliers (tenant_id, name, contact_info) VALUES ($1, 'Quote Supplier', '{}') RETURNING id`, [tenant])).rows[0].id;
      const draft = (await owner.query(
        `INSERT INTO purchase_orders (tenant_id, branch_id, supplier_id, created_by, currency) VALUES ($1, $2, $3, $4, 'ETB') RETURNING id`,
        [tenant, tenantBranch, supplier, staff],
      )).rows[0].id;
      const refused = await setCurrency('USD');
      expect(refused.status).toBe(422);
      expect(refused.body.error).toBe('CURRENCY_IN_USE');
      expect(refused.body.message).toContain('purchase orders');
      await owner.query(`DELETE FROM purchase_orders WHERE id = $1`, [draft]);
      expect((await setCurrency('USD')).status).toBe(200);
      expect((await setCurrency('ETB')).status).toBe(200);
    });

    it('is refused while a bank account is kept in it, even with no money through it (was: changed, the account relabelled)', async () => {
      const owner = ownerDb();
      await owner.query(
        `INSERT INTO bank_accounts (tenant_id, branch_id, account_name, bank_name, account_number, account_number_hash, currency)
         VALUES ($1, $2, 'Quiet', 'CBE', 'enc', 'shopcur-hash', 'ETB')`,
        [tenant, tenantBranch],
      );
      const refused = await setCurrency('USD');
      expect(refused.status).toBe(422);
      expect(refused.body.error).toBe('CURRENCY_IN_USE');
      expect(refused.body.message).toContain('bank accounts');
    });
  });

  describe('the migration (2a, and the sample orders)', () => {
    it("puts every record in its shop's currency and removes the untouched sample purchase orders, audited", async () => {
      const migration = createRequire(import.meta.url)('../db/migrations/1700000077_records_in_shop_currency.cjs') as {
        up: (pgm: { sql: (s: string) => void }) => void;
      };
      const client = await ownerDb().connect();
      try {
        await client.query('BEGIN');
        const t = (await client.query(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [`${TENANT} migrated`])).rows[0].id;
        const b = (await client.query(
          `INSERT INTO branches (tenant_id, name, address, contact_info, operating_hours) VALUES ($1, 'Main', '-', '{}', '{}') RETURNING id`, [t],
        )).rows[0].id;
        const s = (await client.query(
          `INSERT INTO staff (tenant_id, username, password_hash, full_name) VALUES ($1, $2, 'x', 'Migrated') RETURNING id`, [t, `${STAFF_PREFIX}migrated`],
        )).rows[0].id;
        await client.query(`INSERT INTO system_config (tenant_id, key, value, updated_by) VALUES ($1, 'base_currency', '"USD"', $2)`, [t, s]);        const sup = (await client.query(`INSERT INTO suppliers (tenant_id, name, contact_info) VALUES ($1, 'S', '{}') RETURNING id`, [t])).rows[0].id;
        const book = (await client.query(`INSERT INTO books (tenant_id, isbn, title) VALUES ($1, '9780000000002', 'B') RETURNING id`, [t])).rows[0].id;
        const po = async (notes: string, status = 'draft') => {
          const id = (await client.query(
            `INSERT INTO purchase_orders (tenant_id, branch_id, supplier_id, created_by, status, total_amount, currency, notes)
             VALUES ($1, $2, $3, $4, $5, 250, 'ETB', $6) RETURNING id`,
            [t, b, sup, s, status, notes],
          )).rows[0].id as string;
          await client.query(`INSERT INTO po_line_items (tenant_id, po_id, book_id, quantity, unit_cost) VALUES ($1, $2, $3, 10, 25)`, [t, id, book]);
          return String(id);
        };
        const untouched = await po('Sample PO 1 (seed)');
        const edited = await po('Sample PO 2 (seed)');
        await client.query(
          `INSERT INTO audit_logs (tenant_id, staff_id, staff_role, action, entity_type, entity_id, meta) VALUES ($1, $2, 'Admin', 'UPDATE', 'purchase_order', $3, '{}')`,
          [t, s, edited],
        );
        const submitted = await po('Sample PO 1 (seed)', 'pending_approval');
        const real = await po('Our own order');
        const order = (await client.query(
          `INSERT INTO orders (tenant_id, order_number, branch_id, created_by, currency) VALUES ($1, 'ORD-MIG-1', $2, $3, 'ETB') RETURNING id`, [t, b, s],
        )).rows[0].id;

        const statements: string[] = [];
        migration.up({ sql: (q) => statements.push(q) });
        for (const q of statements) await client.query(q);

        const ids = (await client.query(`SELECT id::text FROM purchase_orders WHERE tenant_id = $1 ORDER BY id`, [t])).rows.map((r) => r.id);
        expect(ids).toEqual([edited, submitted, real]);
        expect((await client.query(`SELECT 1 FROM po_line_items WHERE po_id = $1`, [untouched])).rows).toEqual([]);
        const currencies = (await client.query(
          `SELECT currency FROM purchase_orders WHERE tenant_id = $1 UNION ALL SELECT currency FROM orders WHERE id = $2`, [t, order],
        )).rows.map((r) => r.currency);
        expect(new Set(currencies)).toEqual(new Set(['USD']));
        const audit = (await client.query(
          `SELECT action, entity_type, entity_id, staff_id, meta FROM audit_logs WHERE tenant_id = $1 AND staff_role = 'system' ORDER BY id`, [t],
        )).rows;
        expect(audit).toEqual([
          { action: 'DELETE', entity_type: 'purchase_order', entity_id: untouched, staff_id: null, meta: expect.objectContaining({ notes: 'Sample PO 1 (seed)' }) },
          {
            action: 'UPDATE', entity_type: 'system_config', entity_id: 'base_currency', staff_id: null,
            meta: expect.objectContaining({ currency: 'USD', records: expect.objectContaining({ orders: 1, purchase_orders: 3 }) }),
          },
        ]);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
  });
});
