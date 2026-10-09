import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';
import * as ordersService from '../modules/orders/orders.service.js';

// #72: staff with assigned locations could still sell, receive and move stock
// at every location of their branch. Owner decision: the restriction applies
// to Sales, Stock_Clerk, Purchasor and Finance_Officer on every sale and stock
// movement; Super_Admin, Admin and Manager are never limited; a transfer is
// limited by its source only.

const STAFF_PREFIX = 'locr_test_';
const BRANCH_PREFIX = 'Loc Restrict ';

describe('Location restrictions on sales and stock', () => {
  let branchId: number;
  let locA: number;
  let locB: number;
  let bookId: number;
  let sales: string;
  let clerk: string;
  let freeSales: string;
  let manager: string;
  let adminStaff: { staffId: number; role: string; branchId: number };
  let poId: number;
  let txId: number;
  const api = () => request(getTestApp());
  const as = (r: request.Test, token: string) => r.set('Authorization', `Bearer ${token}`);
  const version = async (locationId: number) =>
    (await db.query(`SELECT version FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locationId])).rows[0].version as number;

  const expectRefused = (res: request.Response) => {
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'FORBIDDEN', message: 'You do not have access to this location' });
  };

  async function cleanUp() {
    const branches = (await db.query(`SELECT id FROM branches WHERE name LIKE $1`, [`${BRANCH_PREFIX}%`])).rows.map((r) => r.id);
    if (branches.length) {
      const locs = `(SELECT id FROM locations WHERE branch_id = ANY($1))`;
      await db.query(`DELETE FROM inventory_reservations WHERE location_id IN ${locs}`, [branches]);
      await db.query(`DELETE FROM order_payments WHERE order_id IN (SELECT id FROM orders WHERE branch_id = ANY($1))`, [branches]);
      await db.query(`DELETE FROM orders WHERE branch_id = ANY($1)`, [branches]);
      await db.query(`DELETE FROM transactions WHERE branch_id = ANY($1)`, [branches]);
      await db.query(`DELETE FROM purchase_orders WHERE branch_id = ANY($1)`, [branches]);
      await db.query(`DELETE FROM inventory_history WHERE location_id IN ${locs}`, [branches]);
      await db.query(`DELETE FROM inventory WHERE location_id IN ${locs}`, [branches]);
      await db.query(`DELETE FROM staff_locations WHERE location_id IN ${locs}`, [branches]);
      await db.query(`DELETE FROM locations WHERE branch_id = ANY($1)`, [branches]);
    }
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}Branch` })).branchId;
    locA = (await db.query(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Loc Restrict A', true) RETURNING id`, [branchId])).rows[0].id;
    locB = (await db.query(`INSERT INTO locations (branch_id, name) VALUES ($1, 'Loc Restrict B') RETURNING id`, [branchId])).rows[0].id;
    bookId = (await db.query(`SELECT id FROM books WHERE is_active = true AND default_price IS NOT NULL ORDER BY id LIMIT 1`)).rows[0].id;
    for (const loc of [locA, locB]) {
      await db.query(`INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version) VALUES ($1, $2, 20, 0, 0)`, [bookId, loc]);
    }

    const restricted = async (username: string, role: 'Sales' | 'Stock_Clerk' | 'Manager') => {
      const s = await createTestStaff({ username: `${STAFF_PREFIX}${username}`, role, branchId });
      await db.query(`INSERT INTO staff_locations (staff_id, location_id) VALUES ($1, $2)`, [s.staffId, locA]);
      return s.token;
    };
    sales = await restricted('sales', 'Sales');
    clerk = await restricted('clerk', 'Stock_Clerk');
    manager = await restricted('mgr', 'Manager');
    freeSales = (await createTestStaff({ username: `${STAFF_PREFIX}free`, role: 'Sales', branchId })).token;
    const admin = await createTestStaff({ username: `${STAFF_PREFIX}admin`, role: 'Admin', branchId });
    adminStaff = { staffId: admin.staffId, role: 'Admin', branchId };

    const supplierId = (await db.query(`SELECT id FROM suppliers ORDER BY id LIMIT 1`)).rows[0].id;
    poId = (await db.query(
      `INSERT INTO purchase_orders (branch_id, receiving_branch_id, supplier_id, created_by) VALUES ($1, $1, $2, $3) RETURNING id`,
      [branchId, supplierId, admin.staffId],
    )).rows[0].id;
    txId = (await db.query(
      `INSERT INTO transactions (branch_id, location_id, staff_id, subtotal, grand_total, transaction_number)
       VALUES ($1, $2, $3, 10, 10, 'LOCR-TX-1') RETURNING id`,
      [branchId, locB, admin.staffId],
    )).rows[0].id;
  });

  afterAll(cleanUp);

  it('refuses stock in, stock out and adjustments at a location not assigned', async () => {
    expectRefused(await as(api().post('/api/v1/inventory/stock-in'), clerk).send({ bookId, locationId: locB, quantity: 1, version: 0 }));
    expectRefused(await as(api().post('/api/v1/inventory/stock-out'), sales).send({ bookId, locationId: locB, quantity: 1, version: 0 }));
    expectRefused(await as(api().post('/api/v1/inventory/adjust'), clerk).send({ bookId, locationId: locB, delta: -1, reasonCode: 'damage', version: 0 }));
  });

  it('still allows them at an assigned location', async () => {
    const res = await as(api().post('/api/v1/inventory/stock-in'), clerk).send({ bookId, locationId: locA, quantity: 1, version: await version(locA) });
    expect(res.status).toBeLessThan(300);
  });

  it('limits a transfer by its source: from an assigned location to any, not the other way', async () => {
    expectRefused(await as(api().post('/api/v1/inventory/transfer'), clerk).send({
      bookId, fromLocationId: locB, toLocationId: locA, quantity: 1, fromVersion: await version(locB),
    }));
    const res = await as(api().post('/api/v1/inventory/transfer'), clerk).send({
      bookId, fromLocationId: locA, toLocationId: locB, quantity: 1, fromVersion: await version(locA),
    });
    expect(res.status).toBeLessThan(300);
  });

  it('refuses a POS sale, an order and an exchange at a location not assigned', async () => {
    expectRefused(await as(api().post('/api/v1/pos/transactions'), sales).send({
      locationId: locB, items: [{ bookId, quantity: 1 }], payments: [{ method: 'cash', amount: 1 }],
    }));
    expectRefused(await as(api().post('/api/v1/orders'), sales).send({ locationId: locB, items: [{ bookId, quantity: 1 }] }));
    expectRefused(await as(api().post('/api/v1/exchanges'), sales).send({
      locationId: locB, incomingItems: [{ bookId, quantity: 1 }], outgoingItems: [],
    }));
  });

  it('refuses to confirm or fulfil an order that books stock at a location not assigned', async () => {
    const draft = await ordersService.create({ customerId: null, locationId: locB, items: [{ bookId, quantity: 1 }] }, adminStaff);
    expectRefused(await as(api().post(`/api/v1/orders/${draft.id}/confirm`), sales).send({}));

    const confirmed = await ordersService.create({ customerId: null, locationId: locB, items: [{ bookId, quantity: 1 }] }, adminStaff);
    await ordersService.confirm(confirmed.id, adminStaff);
    expectRefused(await as(api().post(`/api/v1/orders/${confirmed.id}/fulfill`), sales));
  });

  it('refuses to receive a purchase order or take a return at a location not assigned', async () => {
    expectRefused(await as(api().post(`/api/v1/purchase-orders/${poId}/receive`), clerk).send({
      locationId: locB, items: [{ bookId, quantityReceived: 1 }],
    }));
    expectRefused(await as(api().post('/api/v1/returns'), sales).send({
      transactionId: txId, refundMethod: 'cash', lines: [{ txLineItemId: 1, quantity: 1 }],
    }));
  });

  it('does not limit staff without assignments, nor Managers', async () => {
    const free = await as(api().post('/api/v1/inventory/stock-out'), freeSales).send({ bookId, locationId: locB, quantity: 1, version: await version(locB) });
    expect(free.status).toBeLessThan(300);
    const mgr = await as(api().post('/api/v1/inventory/stock-in'), manager).send({ bookId, locationId: locB, quantity: 1, version: await version(locB) });
    expect(mgr.status).toBeLessThan(300);
  });
});
