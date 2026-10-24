import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { ownerDb } from './helpers/ownerDb.js';
import { DEFAULT_ADMIN_PASSWORD_HASH } from '../db/seed.js';

// The owner's correction (2026-10-23): the purchase order form's book search
// shows, under each book, the stock of every location of the branch (a shop
// and a store) and what is already on order there, so the buyer does not
// order what is on the shelf or on its way (was: one "avail" figure, and only
// once a receiving location was chosen).
//
// One tenant of its own, so the stock and the orders are exactly the ones made here.

const PREFIX = 'pobooks_test_';
const TENANT = 'PO Book Stock Test';
const PASSWORD = 'Admin@1234'; // DEFAULT_ADMIN_PASSWORD_HASH

describe('Books to order: stock by location, on hand and on order', () => {
  const api = () => request(getTestApp());
  const owner = () => ownerDb();
  let tenant: number;
  let main: number;
  let other: number;
  let shop: number;
  let store: number;
  let otherShelf: number;
  let supplier: number;
  let dune: number;
  let messiah: number;
  const tokens: Record<string, string> = {};

  async function cleanUp() {
    const tenants = `SELECT id FROM tenants WHERE name = '${TENANT}'`;
    const db = owner();
    await db.query(`DELETE FROM refresh_tokens WHERE session_id IN (SELECT id FROM staff_sessions WHERE tenant_id IN (${tenants}))`);
    for (const table of [
      'audit_logs', 'outbox', 'notification_reads', 'notifications', 'inventory_history', 'inventory', 'po_receipt_items', 'po_receipts', 'po_line_items',
      'purchase_orders', 'books', 'suppliers', 'system_config', 'staff_branch_roles', 'staff_sessions', 'staff', 'locations', 'branches',
    ]) {
      await db.query(`DELETE FROM ${table} WHERE tenant_id IN (${tenants})`);
    }
    await db.query(`DELETE FROM tenants WHERE name = '${TENANT}'`);
  }

  const as = (r: request.Test, who: string) => r.set('Authorization', `Bearer ${tokens[who]}`);

  async function staff(name: string, role: string, branch: number, allBranches = false) {
    const db = owner();
    const id = (await db.query(
      `INSERT INTO staff (tenant_id, username, password_hash, full_name, is_active, must_change_password, is_all_branches)
       VALUES ($1, $2, $3, $2, true, false, $4) RETURNING id`,
      [tenant, `${PREFIX}${name}`, DEFAULT_ADMIN_PASSWORD_HASH, allBranches],
    )).rows[0].id;
    await db.query(`INSERT INTO staff_branch_roles (tenant_id, staff_id, branch_id, role) VALUES ($1, $2, $3, $4)`, [tenant, id, branch, role]);
    const login = await api().post('/api/v1/auth/login').send({ username: `${PREFIX}${name}`, password: PASSWORD, branchId: main });
    expect(login.status).toBe(200);
    tokens[name] = login.body.accessToken;
  }

  /** An order of `quantity` Dune at 5.00 for `location` of `branch`, taken as far as `upTo`. */
  async function order(branch: number, location: number, quantity: number, upTo: 'draft' | 'submitted' | 'ordered' | 'cancelled', unitCost = 5) {
    const created = await as(api().post('/api/v1/purchase-orders'), 'admin').send({
      supplierId: supplier, receivingBranchId: branch, receivingLocationId: location, lineItems: [{ bookId: dune, quantity, unitCost }],
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    if (upTo === 'draft') return created.body;
    expect((await as(api().post(`/api/v1/purchase-orders/${id}/submit`), 'admin')).status).toBe(200);
    if (upTo === 'cancelled') expect((await as(api().post(`/api/v1/purchase-orders/${id}/cancel`), 'admin')).status).toBe(200);
    if (upTo === 'ordered') expect((await as(api().post(`/api/v1/purchase-orders/${id}/order`), 'admin')).status).toBe(200);
    return (await as(api().get(`/api/v1/purchase-orders/${id}`), 'admin')).body;
  }

  beforeAll(async () => {
    await cleanUp();
    const db = owner();
    const one = async (sql: string, params: unknown[]) => (await db.query(sql, params)).rows[0].id as number;
    tenant = await one(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [TENANT]);
    const branch = (name: string) => one(
      `INSERT INTO branches (tenant_id, name, address, contact_info, operating_hours) VALUES ($1, $2, '-', '{}', '{}') RETURNING id`, [tenant, name],
    );
    main = await branch('Main Branch');
    other = await branch('Other Branch');
    const location = (b: number, name: string) => one(`INSERT INTO locations (tenant_id, branch_id, name) VALUES ($1, $2, $3) RETURNING id`, [tenant, b, name]);
    shop = await location(main, 'Shop');
    store = await location(main, 'Store');
    otherShelf = await location(other, 'Other Shelf');
    supplier = await one(`INSERT INTO suppliers (tenant_id, name, contact_info) VALUES ($1, 'Supplier', '{}') RETURNING id`, [tenant]);
    dune = await one(`INSERT INTO books (tenant_id, isbn, title) VALUES ($1, '9780441013593', 'Dune') RETURNING id`, [tenant]);
    messiah = await one(`INSERT INTO books (tenant_id, isbn, title) VALUES ($1, '9780441172696', 'Dune Messiah') RETURNING id`, [tenant]);
    await db.query(
      `INSERT INTO system_config (tenant_id, key, value, updated_by) VALUES ($1, 'po_approval_threshold', '1000', 1), ($1, 'base_currency', '"ETB"', 1)`,
      [tenant],
    );
    await db.query(
      `INSERT INTO inventory (tenant_id, book_id, location_id, quantity, average_cost) VALUES ($1, $2, $3, 50, 5), ($1, $2, $4, 4, 5), ($1, $2, $5, 7, 5)`,
      [tenant, dune, shop, store, otherShelf],
    );
    await staff('admin', 'Admin', main);
    await staff('buyer', 'Purchasor', main);
    await staff('sales', 'Sales', main);
    await staff('head', 'Admin', other, true);

    await order(main, store, 10, 'submitted'); // approved on submit: 10 on order at the store
    const partial = await order(main, shop, 20, 'ordered');
    const received = await as(api().post(`/api/v1/purchase-orders/${partial.id}/receive`), 'admin')
      .send({ items: [{ poLineItemId: Number(partial.lineItems[0].id), quantityReceived: 5 }] });
    expect(received.status).toBe(200); // 5 arrived at the shop, 15 still on order
    await order(main, shop, 30, 'draft'); // a draft is not on order
    await order(main, shop, 50, 'submitted', 25); // 1,250.00: waits for approval, not on order
    await order(main, store, 6, 'cancelled');
    await order(other, otherShelf, 3, 'submitted'); // the other branch's
  });

  afterAll(cleanUp);

  const books = (who: string, query: string) => as(api().get(`/api/v1/purchase-orders/books?${query}`), who);

  it('lists each location of the branch with its copies on hand and on order (approved, ordered, part-received; not drafts, pending or cancelled)', async () => {
    const res = await books('admin', 'q=Dune');
    expect(res.status).toBe(200);
    expect(res.body.branchId).toBe(main);
    expect(res.body.items).toEqual([
      {
        id: dune, title: 'Dune', isbn: '9780441013593',
        stock: [
          { locationId: shop, locationName: 'Shop', onHand: 55, onOrder: 15 },
          { locationId: store, locationName: 'Store', onHand: 4, onOrder: 10 },
        ],
      },
      { id: messiah, title: 'Dune Messiah', isbn: '9780441172696', stock: [] },
    ]);
  });

  it('is for the roles that buy: a Purchasor too, not Sales', async () => {
    expect((await books('buyer', 'q=Dune')).body.items[0].stock).toHaveLength(2);
    const refused = await books('sales', 'q=Dune');
    expect(refused.status).toBe(403);
  });

  it('shows another branch only to staff with access to all branches', async () => {
    const refused = await books('admin', `q=Dune&branchId=${other}`);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('BRANCH_ACCESS_DENIED');

    const res = await books('head', `q=Dune&branchId=${other}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ branchId: other });
    expect(res.body.items[0].stock).toEqual([{ locationId: otherShelf, locationName: 'Other Shelf', onHand: 7, onOrder: 3 }]);
  });

  it('asks for at least two letters', async () => {
    const res = await books('admin', 'q=D');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });
});
