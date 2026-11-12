// #266 (owner decision a, 2026-11-12): every list a picker chooses from is
// searched by the API, across all its pages, so no record is out of reach
// past the first page. Branches, a branch's bank accounts and purchase orders
// take `q` like customers, suppliers and books do. Before, they took none:
// a picker loaded their first 100 and the rest could not be chosen.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { deleteTestTenants, ownerDb } from './helpers/ownerDb.js';
import { DEFAULT_ADMIN_PASSWORD_HASH } from '../db/seed.js';

process.env.FEATURE_BANK_ACCOUNTS = 'true';

const TENANT = 'List Search Test Shop';

describe('Searching the lists pickers choose from (#266)', () => {
  const api = () => request(getTestApp());
  let token: string;
  let branch: number;
  const get = (path: string) => api().get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);
  const post = async (path: string, body: object) => {
    const res = await api().post(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
  };
  const names = (body: { items: Array<Record<string, unknown>> }, key: string) => body.items.map((i) => i[key]);

  beforeAll(async () => {
    await deleteTestTenants(`${TENANT}%`);
    const db = ownerDb();
    const tenant = (await db.query(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [TENANT])).rows[0].id;
    await db.query(`INSERT INTO system_config (tenant_id, key, value, updated_by) SELECT $1, key, value, 1 FROM system_config WHERE tenant_id = 1`, [tenant]);
    const branches = ['Main Branch', 'Piassa Branch', 'Bole Branch', 'Merkato Shop'];
    const ids: number[] = [];
    for (const name of branches) {
      ids.push((await db.query(
        `INSERT INTO branches (tenant_id, name, address, contact_info, operating_hours) VALUES ($1, $2, '-', '{}', '{}') RETURNING id`, [tenant, name],
      )).rows[0].id);
    }
    branch = ids[0];
    await db.query(`INSERT INTO locations (tenant_id, branch_id, name, is_default_fulfillment) VALUES ($1, $2, 'Shelf', true)`, [tenant, branch]);
    const staff = (await db.query(
      `INSERT INTO staff (tenant_id, username, password_hash, full_name, is_active, must_change_password, is_all_branches)
       VALUES ($1, 'listsearch_admin', $2, 'List Search Admin', true, false, true) RETURNING id`, [tenant, DEFAULT_ADMIN_PASSWORD_HASH],
    )).rows[0].id;
    for (const b of ids) await db.query(`INSERT INTO staff_branch_roles (tenant_id, staff_id, branch_id, role) VALUES ($1, $2, $3, 'Admin')`, [tenant, staff, b]);
    const login = await api().post('/api/v1/auth/login').send({ username: 'listsearch_admin', password: 'Admin@1234', branchId: branch });
    expect(login.status).toBe(200);
    token = login.body.accessToken;
  });

  afterAll(() => deleteTestTenants(`${TENANT}%`));

  it('finds branches by part of their name, any case, with the total of matches', async () => {
    const res = await get('/branches?q=BRANCH&pageSize=2');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(names(res.body, 'name')).toEqual(['Bole Branch', 'Main Branch']);
    const next = await get('/branches?q=branch&pageSize=2&page=2');
    expect(names(next.body, 'name')).toEqual(['Piassa Branch']);
    expect(names((await get('/branches?q=merk')).body, 'name')).toEqual(['Merkato Shop']);
  });

  it("finds a branch's bank accounts by account name or bank", async () => {
    await post(`/branches/${branch}/bank-accounts`, { accountName: 'Main Collections', bankName: 'Awash Bank', accountNumber: '1000200030' });
    await post(`/branches/${branch}/bank-accounts`, { accountName: 'Petty Cash Float', bankName: 'Dashen Bank', accountNumber: '1000200031' });
    await post(`/branches/${branch}/bank-accounts`, { accountName: 'Supplier Payments', bankName: 'Awash Bank', accountNumber: '1000200032' });
    const awash = await get(`/branches/${branch}/bank-accounts?q=awash`);
    expect(awash.status).toBe(200);
    expect(awash.body.total).toBe(2);
    expect(names(awash.body, 'accountName')).toEqual(['Main Collections', 'Supplier Payments']);
    expect(names((await get(`/branches/${branch}/bank-accounts?q=petty`)).body, 'accountName')).toEqual(['Petty Cash Float']);
  });

  it('finds purchase orders by number or supplier', async () => {
    const imported = await api().post('/api/v1/imports/catalog').set('Authorization', `Bearer ${token}`)
      .send({ csv: 'ISBN,Title,Price\r\n9780306406157,Searched Book,100.00' });
    expect(imported.status).toBe(200);
    const book = (await get('/books?search=9780306406157')).body;
    const bookId = (book.data ?? book.items)[0].id;
    const supplier = async (name: string) => (await post('/suppliers', { name, contactInfo: {}, supplierType: 'external' })).id;
    const kuraz = await supplier('Kuraz Publishers');
    const mega = await supplier('Mega Distributors');
    const order = (supplierId: number) => post('/purchase-orders', {
      supplierId, branchId: branch, currency: 'ETB', lineItems: [{ bookId, quantity: 1, unitCost: 50 }],
    });
    const first = await order(kuraz);
    await order(mega);
    await order(kuraz);

    const bySupplier = await get('/purchase-orders?q=kuraz');
    expect(bySupplier.status).toBe(200);
    expect(bySupplier.body.total).toBe(2);
    const byNumber = await get(`/purchase-orders?q=${encodeURIComponent(first.poNumber.toLowerCase())}`);
    expect(names(byNumber.body, 'poNumber')).toEqual([first.poNumber]);
  });

  it('takes a search of at most 100 characters', async () => {
    expect((await get(`/branches?q=${'x'.repeat(101)}`)).status).toBe(400);
  });
});
