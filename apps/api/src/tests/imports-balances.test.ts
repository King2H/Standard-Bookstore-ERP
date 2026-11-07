// #246 part 3 (owner decisions 2a, and 1a–3a of 2026-11-07): a shop starts
// with the balances it carries: what each customer owes, as one opening
// receivable with a due date, collected like any other; store credit;
// loyalty points; and what it owes each supplier, as one opening-balance
// purchase order (OPB-) paid through the supplier payments. Two files:
// customer balances, and supplier balances (a supplier not yet known is
// created from the row). Balances come in only before the shop's first sale,
// once: a file imported again adds nothing. They are audited, labelled
// "Opening balance", and never counted as a sale or a purchase. Before, a
// shop had no way to bring them in.
//
// Each test runs in its own tenant: the first-sale rule looks at the whole shop.
import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { CUSTOMER_BALANCE_IMPORT_COLUMNS, ImportReportSchema, ImportResultSchema, SUPPLIER_BALANCE_IMPORT_COLUMNS } from '@bms/shared';
import { getTestApp } from './helpers/testApp.js';
import { ownerDb } from './helpers/ownerDb.js';
import { DEFAULT_ADMIN_PASSWORD_HASH } from '../db/seed.js';

const PREFIX = 'balimp_test_';
const TENANT_PREFIX = 'Balance Import Test ';
const PASSWORD = 'Admin@1234'; // DEFAULT_ADMIN_PASSWORD_HASH
const CUSTOMER_BALANCES = 'Code,Phone,Email,Amount Owed,Due Date,Store Credit,Loyalty Points';
const SUPPLIER_BALANCES = 'Supplier,Phone,Email,Amount Owed';

type Shop = { tenant: number; branch: number; admin: string; manager: string; clerk: string };

describe('Opening balances import (#246)', () => {
  const api = () => request(getTestApp());
  const owner = () => ownerDb();
  let shops = 0;
  const as = (r: request.Test, token: string) => r.set('Authorization', `Bearer ${token}`);
  const post = (path: string, csv: string, token: string, onlyValid = false) =>
    as(api().post(`/api/v1/imports/${path}`), token).send({ csv, fileName: `${path}.csv`, onlyValid });
  const errorsByLine = (body: unknown) => Object.fromEntries(ImportReportSchema.parse(body).errors.map((e) => [e.line, e.messages.join(' | ')]));

  afterAll(async () => {
    const tenants = `SELECT id FROM tenants WHERE name LIKE '${TENANT_PREFIX}%'`;
    const db = owner();
    await db.query(`DELETE FROM refresh_tokens WHERE session_id IN (SELECT id FROM staff_sessions WHERE tenant_id IN (${tenants}))`);
    for (const table of [
      'audit_logs', 'outbox', 'notification_reads', 'notifications', 'financial_transactions', 'supplier_payments', 'purchase_orders',
      'receivables', 'store_credit_history', 'store_credit_accounts', 'loyalty_history', 'loyalty_accounts', 'transaction_payments', 'transaction_line_items',
      'transactions', 'customers', 'document_counters', 'suppliers', 'system_config', 'staff_branch_roles', 'staff_sessions', 'staff', 'locations', 'branches',
    ]) {
      await db.query(`DELETE FROM ${table} WHERE tenant_id IN (${tenants})`);
    }
    await db.query(`DELETE FROM tenants WHERE name LIKE '${TENANT_PREFIX}%'`);
  });

  /** A new shop: one branch, its Admin, Manager and Stock_Clerk, signed in. */
  async function shop(): Promise<Shop> {
    const db = owner();
    const tenant = (await db.query(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [`${TENANT_PREFIX}${++shops}`])).rows[0].id;
    const branch = (await db.query(
      `INSERT INTO branches (tenant_id, name, address, contact_info, operating_hours) VALUES ($1, 'Main Branch', '-', '{}', '{}') RETURNING id`, [tenant],
    )).rows[0].id;
    await db.query(`INSERT INTO locations (tenant_id, branch_id, name) VALUES ($1, $2, 'Shelf')`, [tenant, branch]);
    await db.query(`INSERT INTO system_config (tenant_id, key, value, updated_by) VALUES ($1, 'base_currency', '"ETB"', 1)`, [tenant]);
    const token = async (name: string, role: string) => {
      const id = (await db.query(
        `INSERT INTO staff (tenant_id, username, password_hash, full_name, is_active, must_change_password) VALUES ($1, $2, $3, $2, true, false) RETURNING id`,
        [tenant, `${PREFIX}${tenant}_${name}`, DEFAULT_ADMIN_PASSWORD_HASH],
      )).rows[0].id;
      await db.query(`INSERT INTO staff_branch_roles (tenant_id, staff_id, branch_id, role) VALUES ($1, $2, $3, $4)`, [tenant, id, branch, role]);
      const login = await api().post('/api/v1/auth/login').send({ username: `${PREFIX}${tenant}_${name}`, password: PASSWORD, branchId: branch });
      expect(login.status).toBe(200);
      return login.body.accessToken as string;
    };
    return { tenant, branch, admin: await token('admin', 'Admin'), manager: await token('manager', 'Manager'), clerk: await token('clerk', 'Stock_Clerk') };
  }

  /** Two customers, made by the customer import. */
  async function customers(s: Shop): Promise<{ almaz: string; dawit: string }> {
    const res = await post('customers', 'Code,Name,Phone,Email,Address,City\r\n,Almaz,+251911000111,almaz@example.et,,\r\n,Dawit,+251922000222,,,', s.admin);
    expect(res.status).toBe(200);
    const codes = (await owner().query(`SELECT full_name, customer_code FROM customers WHERE tenant_id = $1`, [s.tenant])).rows;
    return { almaz: codes.find((c) => c.full_name === 'Almaz').customer_code, dawit: codes.find((c) => c.full_name === 'Dawit').customer_code };
  }

  describe('customer balances', () => {
    it('gives its template, and only Admin and Manager import it', async () => {
      const s = await shop();
      const res = await as(api().get('/api/v1/imports/customer-balances/template'), s.manager);
      expect(res.text.replace(/^\uFEFF/, '').split('\r\n')[0]).toBe(CUSTOMER_BALANCE_IMPORT_COLUMNS.join(','));
      expect(CUSTOMER_BALANCE_IMPORT_COLUMNS.join(',')).toBe(CUSTOMER_BALANCES);
      expect((await post('customer-balances/check', `${CUSTOMER_BALANCES}\r\nCUS-1,,,1,2026-12-01,,`, s.clerk)).status).toBe(403);
    });

    it('checks every row: a known customer, amounts, a due date for what is owed, once per customer', async () => {
      const s = await shop();
      const { almaz } = await customers(s);
      const csv = [
        CUSTOMER_BALANCES,
        `${almaz},,,1500.50,2026-12-31,200,350`,
        `,+251999999999,,10,2026-12-31,,`,
        `,+251922000222,,-5,2026-12-31,,`,
        `,+251922000222,,10,,,`,
        `,+251922000222,,10,31/12/2026,,`,
        `,+251922000222,,,,1.234,`,
        `,+251922000222,,,,,many`,
        `,,almaz@example.et,,,5,`,
      ].join('\r\n');
      const res = await post('customer-balances/check', csv, s.manager);
      expect(res.status).toBe(200);
      expect(ImportReportSchema.parse(res.body)).toMatchObject({ kind: 'customer-balances', rows: 8, valid: 1, toCreate: 1 });
      const byLine = errorsByLine(res.body);
      expect(byLine[3]).toMatch(/No customer with phone \+251999999999: import the customers first/);
      expect(byLine[4]).toMatch(/Amount Owed/);
      expect(byLine[5]).toMatch(/Due Date is empty/);
      expect(byLine[6]).toMatch(/Due Date '31\/12\/2026'.*YYYY-MM-DD/);
      expect(byLine[7]).toMatch(/Store Credit/);
      expect(byLine[8]).toMatch(/Loyalty Points/);
      expect(byLine[9]).toMatch(/The same customer as line 2/);
    });

    it('brings in what a customer owes as an opening receivable, their store credit and points, audited', async () => {
      const s = await shop();
      const { almaz, dawit } = await customers(s);
      const csv = [CUSTOMER_BALANCES, `${almaz},,,1500.50,2026-12-31,200,350`, `,+251922000222,,,,75.25,`].join('\r\n');
      const res = await post('customer-balances', csv, s.admin);
      expect(res.status).toBe(200);
      expect(ImportResultSchema.parse(res.body)).toMatchObject({ created: 2, updated: 0, skipped: 0 });

      const db = owner();
      const receivables = (await db.query(
        `SELECT r.source_type, r.source_ref_id, r.original_amount::text AS original, r.outstanding_amount::text AS outstanding, r.due_date::text AS due, r.status, r.currency
         FROM receivables r JOIN customers c ON c.id = r.customer_id WHERE r.tenant_id = $1`, [s.tenant],
      )).rows;
      expect(receivables).toEqual([{
        source_type: 'opening_balance', source_ref_id: almaz, original: '1500.50', outstanding: '1500.50', due: '2026-12-31', status: 'Pending', currency: 'ETB',
      }]);
      const balances = (await db.query(
        `SELECT c.customer_code, sca.balance::text AS credit, la.points_balance::int AS points_balance FROM customers c
         JOIN store_credit_accounts sca ON sca.customer_id = c.id JOIN loyalty_accounts la ON la.customer_id = c.id
         WHERE c.tenant_id = $1 ORDER BY c.customer_code`, [s.tenant],
      )).rows;
      expect(balances).toEqual([
        { customer_code: almaz, credit: '200.00', points_balance: 350 },
        { customer_code: dawit, credit: '75.25', points_balance: 0 },
      ]);
      expect((await db.query(`SELECT ref_type FROM store_credit_history WHERE tenant_id = $1`, [s.tenant])).rows).toEqual([
        { ref_type: 'opening_balance' }, { ref_type: 'opening_balance' },
      ]);
      expect((await db.query(`SELECT reason FROM loyalty_history WHERE tenant_id = $1`, [s.tenant])).rows).toEqual([{ reason: 'OPENING_BALANCE' }]);

      // Labelled and collected like any receivable: listed for payment, money in when paid.
      const list = await as(api().get('/api/v1/receivables'), s.manager);
      expect(list.body.data ?? list.body.items).toEqual([expect.objectContaining({ sourceType: 'opening_balance', sourceRefId: almaz })]);
      const unpaid = await as(api().get('/api/v1/payments/unpaid-orders'), s.manager);
      const item = (unpaid.body.data ?? unpaid.body.items).find((u: { sourceType: string }) => u.sourceType === 'opening_balance');
      expect(item).toMatchObject({ orderNumber: 'Opening balance', customerCode: almaz });
      const paid = await as(api().post(`/api/v1/receivables/${item.id}/collect`), s.manager).send({ amount: 500.5, paymentMethod: 'cash' });
      expect(paid.status).toBe(200);
      expect((await db.query(`SELECT outstanding_amount::text AS o, status FROM receivables WHERE tenant_id = $1`, [s.tenant])).rows[0]).toEqual({ o: '1000.00', status: 'PartiallyPaid' });

      const audit = (await db.query(`SELECT meta FROM audit_logs WHERE tenant_id = $1 AND entity_type = 'data_import'`, [s.tenant])).rows;
      expect(audit).toContainEqual({ meta: expect.objectContaining({ kind: 'customer-balances', created: 2 }) });
    });

    it('adds nothing when the file comes again, and refuses a different balance', async () => {
      const s = await shop();
      const { almaz } = await customers(s);
      const csv = [CUSTOMER_BALANCES, `${almaz},,,1500.50,2026-12-31,200,350`].join('\r\n');
      await post('customer-balances', csv, s.admin);
      expect(ImportReportSchema.parse((await post('customer-balances/check', csv, s.admin)).body)).toMatchObject({ toCreate: 0, unchanged: 1 });
      expect(ImportResultSchema.parse((await post('customer-balances', csv, s.admin)).body)).toMatchObject({ created: 0 });
      expect((await owner().query(`SELECT count(*)::int AS n FROM receivables WHERE tenant_id = $1`, [s.tenant])).rows[0].n).toBe(1);
      const other = [CUSTOMER_BALANCES, `${almaz},,,1600,2026-12-31,200,350`].join('\r\n');
      expect(errorsByLine((await post('customer-balances/check', other, s.admin)).body)[2]).toMatch(/already has an opening balance owed of 1500\.50/);
    });

    it('comes in only before the shop\'s first sale', async () => {
      const s = await shop();
      const { almaz } = await customers(s);
      const db = owner();
      const staffId = (await db.query(`SELECT id FROM staff WHERE tenant_id = $1 LIMIT 1`, [s.tenant])).rows[0].id;
      const location = (await db.query(`SELECT id FROM locations WHERE tenant_id = $1`, [s.tenant])).rows[0].id;
      await db.query(
        `INSERT INTO transactions (tenant_id, branch_id, location_id, staff_id, transaction_number, subtotal, grand_total, amount_paid, status, payment_status, currency)
         VALUES ($1, $2, $3, $4, 'POS-20261107-0001', 10, 10, 10, 'completed', 'paid', 'ETB')`,
        [s.tenant, s.branch, location, staffId],
      );
      const res = await post('customer-balances/check', `${CUSTOMER_BALANCES}\r\n${almaz},,,10,2026-12-31,,`, s.admin);
      expect(ImportReportSchema.parse(res.body)).toMatchObject({ valid: 0, errors: [{ line: 1, messages: [expect.stringMatching(/before the shop's first sale/)] }] });
    });
  });

  // Found by the release gate (#246): a customer export carries each customer's
  // code; imported into another install, every row was refused as an unknown
  // code. A code in the shop's format that is free is kept, and new customers
  // are numbered after it.
  describe('customers from another install', () => {
    it('keeps their codes, and numbers new customers after them', async () => {
      const s = await shop();
      const csv = 'Code,Name,Phone,Email,Address,City\r\nCUS-0042,Moved Customer,,,,\r\nCUS-0042,Twice,,,,\r\nCUSTOMER-7,Odd Code,,,,';
      const check = await post('customers/check', csv, s.admin);
      expect(ImportReportSchema.parse(check.body)).toMatchObject({ valid: 1, toCreate: 1 });
      expect(errorsByLine(check.body)[3]).toMatch(/The same customer as line 2/);
      expect(errorsByLine(check.body)[4]).toMatch(/No customer with code CUSTOMER-7/);
      expect((await post('customers', csv, s.admin, true)).status).toBe(200);
      expect((await post('customers', 'Code,Name,Phone,Email,Address,City\r\n,Brand New,+251900000001,,,', s.admin)).status).toBe(200);
      const codes = (await owner().query(`SELECT full_name, customer_code FROM customers WHERE tenant_id = $1 ORDER BY customer_code`, [s.tenant])).rows;
      expect(codes).toEqual([{ full_name: 'Moved Customer', customer_code: 'CUS-0042' }, { full_name: 'Brand New', customer_code: 'CUS-0043' }]);
      // Imported again, nothing doubles.
      expect(ImportReportSchema.parse((await post('customers/check', 'Code,Name\r\nCUS-0042,Moved Customer', s.admin)).body)).toMatchObject({ unchanged: 1 });
    });
  });

  describe('supplier balances', () => {
    it('checks every row, and lists the suppliers it would add', async () => {
      const s = await shop();
      await owner().query(`INSERT INTO suppliers (tenant_id, name, contact_info) VALUES ($1, 'Mega Books', '{}')`, [s.tenant]);
      const csv = [SUPPLIER_BALANCES, 'Mega Books,,,12000', 'New Press,+251911222333,np@example.et,3000.75', ',,,5', 'Mega Books,,,1', 'Zero,,,0', 'Bad,,,abc'].join('\r\n');
      expect(SUPPLIER_BALANCE_IMPORT_COLUMNS.join(',')).toBe(SUPPLIER_BALANCES);
      const res = await post('supplier-balances/check', csv, s.manager);
      expect(res.status).toBe(200);
      const report = ImportReportSchema.parse(res.body);
      expect(report).toMatchObject({ kind: 'supplier-balances', rows: 6, valid: 2, toCreate: 2 });
      expect(report.newNames.suppliers).toEqual(['New Press']);
      const byLine = errorsByLine(res.body);
      expect(byLine[4]).toMatch(/Supplier is empty/);
      expect(byLine[5]).toMatch(/The same supplier as line 2/);
      expect(byLine[6]).toMatch(/Amount Owed.*more than 0/);
      expect(byLine[7]).toMatch(/Amount Owed/);
    });

    it('brings in what the shop owes as an opening-balance purchase order, paid like any other, out of purchases', async () => {
      const s = await shop();
      await owner().query(`INSERT INTO suppliers (tenant_id, name, contact_info) VALUES ($1, 'Mega Books', '{}')`, [s.tenant]);
      const csv = [SUPPLIER_BALANCES, 'Mega Books,,,12000', 'New Press,+251911222333,np@example.et,3000.75'].join('\r\n');
      const res = await post('supplier-balances', csv, s.admin);
      expect(res.status).toBe(200);
      expect(ImportResultSchema.parse(res.body)).toMatchObject({ created: 2 });

      const db = owner();
      const pos = (await db.query(
        `SELECT s.name, s.contact_info, po.kind, po.status, po.total_amount::text AS total, po.financial_status, po.po_number
         FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.tenant_id = $1 ORDER BY s.name`, [s.tenant],
      )).rows;
      expect(pos).toEqual([
        { name: 'Mega Books', contact_info: {}, kind: 'opening_balance', status: 'received', total: '12000.00', financial_status: 'unpaid', po_number: expect.stringMatching(/^OPB-/) },
        { name: 'New Press', contact_info: { phone: '+251911222333', email: 'np@example.et' }, kind: 'opening_balance', status: 'received', total: '3000.75', financial_status: 'unpaid', po_number: expect.stringMatching(/^OPB-/) },
      ]);

      const mega = (await db.query(`SELECT po.id FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE s.name = 'Mega Books' AND po.tenant_id = $1`, [s.tenant])).rows[0].id;
      const detail = await as(api().get(`/api/v1/purchase-orders/${mega}`), s.manager);
      expect(detail.body).toMatchObject({ kind: 'opening_balance', receivedValue: 12000, outstandingAmount: 12000 });
      const paid = await as(api().post(`/api/v1/purchase-orders/${mega}/payments`), s.admin).send({ amount: 2000, paymentMethod: 'cash' });
      expect(paid.status).toBe(201);
      expect(paid.body).toMatchObject({ financialStatus: 'partial', outstandingAmount: 10000 });
      const overpay = await as(api().post(`/api/v1/purchase-orders/${mega}/payments`), s.admin).send({ amount: 10001, paymentMethod: 'cash' });
      expect(overpay.status).toBe(422);

      // Owed in the supplier balances; never a purchase.
      const balances = await as(api().get('/api/v1/reports/procurement/supplier-balances'), s.manager);
      expect(JSON.stringify(balances.body)).toMatch(/Mega Books/);
      const megaBalance = (balances.body as Array<{ supplier: string; outstandingBalance: number }>).find((r) => r.supplier === 'Mega Books')!;
      expect(megaBalance.outstandingBalance).toBe(10000);
      const purchases = await as(api().get('/api/v1/reports/procurement/purchases-by-supplier'), s.manager);
      expect(JSON.stringify(purchases.body)).not.toMatch(/Mega Books/);

      // Nothing to receive or edit on it.
      expect((await as(api().put(`/api/v1/purchase-orders/${mega}`), s.admin).send({ notes: 'x' })).status).toBe(422);
    });

    it('adds nothing when the file comes again, and refuses a different balance', async () => {
      const s = await shop();
      const csv = [SUPPLIER_BALANCES, 'New Press,+251911222333,,3000.75'].join('\r\n');
      await post('supplier-balances', csv, s.admin);
      expect(ImportReportSchema.parse((await post('supplier-balances/check', csv, s.admin)).body)).toMatchObject({ toCreate: 0, unchanged: 1 });
      expect(ImportResultSchema.parse((await post('supplier-balances', csv, s.admin)).body)).toMatchObject({ created: 0 });
      const other = [SUPPLIER_BALANCES, 'New Press,,,3500'].join('\r\n');
      expect(errorsByLine((await post('supplier-balances/check', other, s.admin)).body)[2]).toMatch(/already has an opening balance owed of 3000\.75/);
    });
  });
});
