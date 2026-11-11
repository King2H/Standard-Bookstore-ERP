// #247 (owner decisions 1a–4a, 2026-11-11; ADR-0010): a shop runs with tax
// off, as every shop does by default and the first client must (bookstores
// are not taxable where it trades), or switched on in Settings by Super_Admin
// or Admin, at one rate, under a name. Prices include tax: turning it on
// never changes a price or a total; each sale, order, return and exchange
// keeps the rate it was made at and the tax inside its amount. A return and
// an exchange give tax back as their own amounts carry it. The sales report
// and the day report show the tax apart. Before, the rate was fixed at 0 and
// could not be set.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import {
  DayPreviewSchema, ExchangeSchema, OrderSchema, PosTransactionSchema, ReturnSchema, SalesReportSchema,
} from '@bms/shared';
import { getTestApp } from './helpers/testApp.js';
import { deleteTestTenants, ownerDb } from './helpers/ownerDb.js';
import { DEFAULT_ADMIN_PASSWORD_HASH } from '../db/seed.js';

const TENANT = 'Tax Test Shop';
const PREFIX = 'taxtest_';
const PASSWORD = 'Admin@1234'; // DEFAULT_ADMIN_PASSWORD_HASH

describe('Tax (#247)', () => {
  const api = () => request(getTestApp());
  let tenant: number;
  let branch: number;
  let location: number;
  let customer: number;
  const token: Record<string, string> = {};
  const books: Record<string, number> = {};
  const as = (who: string) => ({
    get: (path: string) => api().get(`/api/v1${path}`).set('Authorization', `Bearer ${token[who]}`),
    post: (path: string, body: object) => api().post(`/api/v1${path}`).set('Authorization', `Bearer ${token[who]}`).send(body),
    put: (path: string, body: object) => api().put(`/api/v1${path}`).set('Authorization', `Bearer ${token[who]}`).send(body),
  });
  const ok = async (res: request.Response, status = 200) => { expect(res.status, JSON.stringify(res.body)).toBe(status); return res.body; };
  const setting = (who: string, key: string, value: unknown) => as(who).put(`/config/system/${key}`, { value });
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Addis_Ababa' }).format(new Date());

  const sell = async (book: string, quantity = 1) => {
    const price = 115 * quantity;
    return PosTransactionSchema.parse(await ok(await as('admin').post('/pos/transactions', {
      locationId: location, items: [{ bookId: books[book], quantity }], payments: [{ method: 'cash', amount: price }],
    }), 201));
  };

  beforeAll(async () => {
    await deleteTestTenants(`${TENANT}%`);
    const db = ownerDb();
    tenant = (await db.query(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [TENANT])).rows[0].id;
    branch = (await db.query(
      `INSERT INTO branches (tenant_id, name, address, contact_info, operating_hours) VALUES ($1, 'Main Branch', '-', '{}', '{}') RETURNING id`, [tenant],
    )).rows[0].id;
    location = (await db.query(`INSERT INTO locations (tenant_id, branch_id, name, is_default_fulfillment) VALUES ($1, $2, 'Shelf', true) RETURNING id`, [tenant, branch])).rows[0].id;
    // The settings of a new install: the default shop's, which no other test changes the tax of.
    await db.query(`INSERT INTO system_config (tenant_id, key, value, updated_by) SELECT $1, key, value, 1 FROM system_config WHERE tenant_id = 1`, [tenant]);
    for (const [name, role] of [['owner', 'Super_Admin'], ['admin', 'Admin'], ['manager', 'Manager']] as const) {
      const id = (await db.query(
        `INSERT INTO staff (tenant_id, username, password_hash, full_name, is_active, must_change_password) VALUES ($1, $2, $3, $2, true, false) RETURNING id`,
        [tenant, `${PREFIX}${name}`, DEFAULT_ADMIN_PASSWORD_HASH],
      )).rows[0].id;
      await db.query(`INSERT INTO staff_branch_roles (tenant_id, staff_id, branch_id, role) VALUES ($1, $2, $3, $4)`, [tenant, id, branch, role]);
      const login = await api().post('/api/v1/auth/login').send({ username: `${PREFIX}${name}`, password: PASSWORD, branchId: branch });
      expect(login.status).toBe(200);
      token[name] = login.body.accessToken;
    }
    // Two books at 115.00, in stock: 115.00 holds 15.00 of tax at 15%.
    await ok(await as('admin').post('/imports/catalog', { csv: 'ISBN,Title,Price\r\n9780306406157,Taxed One,115.00\r\n9780140449136,Taxed Two,115.00' }));
    await ok(await as('admin').post('/imports/opening-stock', {
      csv: 'ISBN,Location,Quantity,Unit Cost\r\n9780306406157,Shelf,20,50.00\r\n9780140449136,Shelf,20,50.00',
    }));
    for (const row of (await db.query(`SELECT id, title FROM books WHERE tenant_id = $1`, [tenant])).rows) books[row.title] = row.id;
    customer = (await ok(await as('admin').post('/customers', { fullName: 'Tax Test Customer' }), 201)).id;
  });

  afterAll(() => deleteTestTenants(`${TENANT}%`));

  describe('off, as every shop starts', () => {
    it('is off at 15% named VAT, and a sale carries no tax, its total as priced', async () => {
      const settings = (await ok(await as('owner').get('/config/system'))).items;
      const value = (key: string) => settings.find((s: { key: string }) => s.key === key)?.value;
      expect([value('tax_enabled'), value('tax_rate_pct'), value('tax_name')]).toEqual([false, 15, 'VAT']);

      const sale = await sell('Taxed One');
      expect([sale.grandTotal, sale.taxRate, sale.taxTotal]).toEqual([115, 0, 0]);
    });
  });

  describe('switching it', () => {
    it('is for Super_Admin and Admin; a Manager may not, and Admin may change no other shop-wide setting', async () => {
      expect((await setting('manager', 'tax_enabled', true)).status).toBe(403);
      expect((await setting('admin', 'shop_name', 'Not the owner\'s')).status).toBe(403);
      await ok(await setting('admin', 'tax_name', 'VAT'));
      await ok(await setting('owner', 'tax_rate_pct', 15));
    });

    it('takes a rate above 0 and at most 100, to two decimals, and a name of 1 to 20 characters', async () => {
      for (const bad of [0, -5, 100.5, 15.125, '15']) expect((await setting('admin', 'tax_rate_pct', bad)).status, String(bad)).toBe(400);
      for (const bad of ['', 'x'.repeat(21)]) expect((await setting('admin', 'tax_name', bad)).status).toBe(400);
      expect((await setting('admin', 'tax_enabled', 'yes')).status).toBe(400);
    });

    it('gives every signed-in staff member the name to print, with the shop\'s details', async () => {
      await ok(await setting('admin', 'tax_name', 'Turnover Tax'));
      expect((await ok(await as('manager').get('/config/shop'))).taxName).toBe('Turnover Tax');
      await ok(await setting('admin', 'tax_name', 'VAT'));
    });

    it('is recorded in the audit log, who and what', async () => {
      await ok(await setting('admin', 'tax_enabled', true));
      const audit = (await ownerDb().query(
        `SELECT meta FROM audit_logs WHERE tenant_id = $1 AND entity_type = 'system_config' AND entity_id = 'tax_enabled' ORDER BY id DESC LIMIT 1`, [tenant],
      )).rows[0];
      expect(audit.meta).toMatchObject({ key: 'tax_enabled', newValue: true });
    });
  });

  describe('on at 15%: prices include it', () => {
    let saleId: string;
    let lineId: string;

    it('keeps the rate and the tax inside the total on a sale; the total is as priced', async () => {
      const sale = await sell('Taxed One');
      expect([sale.grandTotal, sale.taxRate, sale.taxTotal]).toEqual([115, 0.15, 15]);
      saleId = sale.id;
      lineId = (await ok(await as('admin').get(`/pos/transactions/${sale.id}`))).lineItems[0].id;
    });

    it('does the same on an order', async () => {
      const draft = OrderSchema.parse(await ok(await as('admin').post('/orders', {
        customerId: customer, locationId: location, saleType: 'credit_sale', items: [{ bookId: books['Taxed Two'], quantity: 2 }],
      }), 201));
      expect([draft.total, draft.taxRate, draft.taxAmount]).toEqual([230, 0.15, 30]);
      // Confirmed, it is a sale of the day.
      const order = OrderSchema.parse(await ok(await as('admin').post(`/orders/${draft.id}/confirm`, { dueDate: '2099-12-31' })));
      expect([order.status, order.taxAmount]).toEqual(['CONFIRMED', 30]);
    });

    it('gives the tax back with a return, at the rate of the sale', async () => {
      const ret = ReturnSchema.parse(await ok(await as('admin').post('/returns', {
        transactionId: Number(saleId), reason: 'Bought twice', lines: [{ transactionLineItemId: Number(lineId), quantity: 1 }],
      }), 201));
      expect([ret.totalRefundAmount, ret.taxRate, ret.taxAmount]).toEqual([115, 0.15, 15]);
    });

    it('carries the tax inside an exchange\'s difference, the only part of it that is a sale', async () => {
      const exchange = ExchangeSchema.parse(await ok(await as('admin').post('/exchanges', {
        locationId: location, customerId: customer,
        incomingItems: [{ bookId: books['Taxed One'], quantity: 1, unitPrice: 100, condition: 'resellable' }],
        outgoingItems: [{ bookId: books['Taxed Two'], quantity: 1 }],
        payments: [{ method: 'cash', amount: 15 }],
      }), 201));
      expect([exchange.netBalance, exchange.taxRate, exchange.taxAmount]).toEqual([15, 0.15, 1.96]);
    });
  });

  describe('a new rate, then off', () => {
    it('applies from the next document only: what was recorded keeps its rate and tax', async () => {
      const before = await sell('Taxed One');
      await ok(await setting('admin', 'tax_rate_pct', 10));
      const after = await sell('Taxed One');
      expect([after.taxRate, after.taxTotal]).toEqual([0.1, 10.45]);

      const kept = PosTransactionSchema.parse(await ok(await as('admin').get(`/pos/transactions/${before.id}`)));
      expect([kept.taxRate, kept.taxTotal]).toEqual([0.15, 15]);
      // Its return, after the change, gives back tax at the sale's 15%.
      const ret = ReturnSchema.parse(await ok(await as('admin').post('/returns', {
        transactionId: Number(before.id), reason: 'Changed mind', lines: [{ transactionLineItemId: Number(kept.lineItems![0].id), quantity: 1 }],
      }), 201));
      expect([ret.taxRate, ret.taxAmount]).toEqual([0.15, 15]);
    });

    it('switched off, the next sale carries none, and the earlier ones keep theirs', async () => {
      await ok(await setting('owner', 'tax_enabled', false));
      const sale = await sell('Taxed Two');
      expect([sale.taxRate, sale.taxTotal]).toEqual([0, 0]);
    });
  });

  describe('the reports', () => {
    it('show the tax inside the day\'s sales, net of returns, with exchanges', async () => {
      // Sales: 0 (off) + 15 + 15 + 10.45 + 0 at the counter, 30 on the order; returns -15 -15; the exchange 1.96.
      const day = DayPreviewSchema.parse(await ok(await as('admin').get(`/business-days/preview?day=${today()}`)));
      expect(day.report.sales.tax).toBe(42.41);
    });

    it('give the sales report the tax inside net sales, and net sales before tax', async () => {
      const { summary } = SalesReportSchema.parse(await ok(await as('admin').get(`/reports/sales?dateFrom=${today()}&dateTo=${today()}`)));
      expect(summary.taxIncluded).toBe(42.41);
      expect(summary.netSalesBeforeTax).toBeCloseTo(summary.netSales - 42.41, 2);
    });
  });
});
