import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

// Branch isolation, part 2 (#12): records named by id, locations in write
// requests, and branch setup under /branches/:branchId.

const STAFF_PREFIX = 'scoperec_test_';
const BRANCH_PREFIX = 'Scope Records Branch';

describe('Branch scope for single records', () => {
  const api = () => request(getTestApp());
  let branchA: number;
  let branchB: number;
  let locA: number;
  let locB: number;
  let adminA: string; // Admin in branch A only
  let adminB: string; // Admin in branch B only
  let globalAdmin: string; // access to all branches, signed in to branch A
  let orderA: number;
  let orderB: number;
  let paymentB: number;
  let posB: number;
  let poB: number; // ordered by B
  let poAtoB: number; // ordered by A, received in B
  let bookId: number;

  const auth = (r: request.Test, token: string) => r.set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
    branchA = (await createTestBranch({ name: `${BRANCH_PREFIX} A` })).branchId;
    branchB = (await createTestBranch({ name: `${BRANCH_PREFIX} B` })).branchId;
    const loc = async (branchId: number, name: string) =>
      (await db.query(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, $2, true) RETURNING id`, [branchId, name])).rows[0].id as number;
    locA = await loc(branchA, `${BRANCH_PREFIX} Loc A`);
    locB = await loc(branchB, `${BRANCH_PREFIX} Loc B`);

    const a = await createTestStaff({ username: `${STAFF_PREFIX}admin_a`, role: 'Admin', branchId: branchA });
    adminA = a.token;
    adminB = (await createTestStaff({ username: `${STAFF_PREFIX}admin_b`, role: 'Admin', branchId: branchB })).token;
    const g = await createTestStaff({ username: `${STAFF_PREFIX}global`, role: 'Admin', branchId: branchA });
    await db.query(`UPDATE staff SET is_all_branches = true WHERE id = $1`, [g.staffId]);
    globalAdmin = g.token;

    const order = async (branchId: number, locationId: number, label: string) =>
      (await db.query(
        `INSERT INTO orders (order_number, branch_id, location_id, created_by, status) VALUES ($1, $2, $3, $4, 'CONFIRMED') RETURNING id`,
        [`SCOPEREC-${label}-${Date.now()}`, branchId, locationId, a.staffId],
      )).rows[0].id as number;
    orderA = await order(branchA, locA, 'A');
    orderB = await order(branchB, locB, 'B');
    paymentB = (await db.query(
      `INSERT INTO order_payments (order_id, amount, payment_method, payment_reference, processed_by, status)
       VALUES ($1, 10, 'cash', $2, $3, 'success') RETURNING id`,
      [orderB, `SCOPEREC-PAY-${Date.now()}`, a.staffId],
    )).rows[0].id as number;
    posB = (await db.query(
      `INSERT INTO transactions (transaction_number, branch_id, location_id, staff_id, subtotal, grand_total)
       VALUES ($1, $2, $3, $4, 0, 0) RETURNING id`,
      [`SCOPEREC-POS-${Date.now()}`, branchB, locB, a.staffId],
    )).rows[0].id as number;
    const supplierId = (await db.query(`SELECT id FROM suppliers ORDER BY id LIMIT 1`)).rows[0].id as number;
    const po = async (branchId: number, receivingBranchId: number | null) =>
      (await db.query(
        `INSERT INTO purchase_orders (branch_id, receiving_branch_id, supplier_id, status, total_amount, created_by)
         VALUES ($1, $2, $3, 'draft', 0, $4) RETURNING id`,
        [branchId, receivingBranchId, supplierId, a.staffId],
      )).rows[0].id as number;
    poB = await po(branchB, null);
    poAtoB = await po(branchA, branchB);
    bookId = (await db.query(`SELECT id FROM books ORDER BY id LIMIT 1`)).rows[0].id as number;
  });

  afterAll(async () => {
    await db.query(`DELETE FROM purchase_orders WHERE id = ANY($1)`, [[poB, poAtoB]]);
    await db.query(`DELETE FROM transactions WHERE id = $1`, [posB]);
    await db.query(`DELETE FROM order_payments WHERE id = $1`, [paymentB]);
    await db.query(`DELETE FROM orders WHERE id = ANY($1)`, [[orderA, orderB]]);
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  describe('records named by id', () => {
    const reads = () => [
      `/api/v1/orders/${orderB}`,
      `/api/v1/orders/${orderB}/payments`,
      `/api/v1/orders/${orderB}/balance`,
      `/api/v1/payments/${paymentB}`,
      `/api/v1/pos/transactions/${posB}`,
      `/api/v1/purchase-orders/${poB}`,
    ];

    it('another branch\'s records answer 404, as if they did not exist', async () => {
      for (const path of reads()) {
        const res = await auth(api().get(path), adminA);
        expect({ path, status: res.status, error: res.body.error }).toEqual({ path, status: 404, error: 'NOT_FOUND' });
      }
    });

    it('the session branch\'s records still answer', async () => {
      const res = await auth(api().get(`/api/v1/orders/${orderA}`), adminA);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(orderA);
    });

    it('refuses actions on another branch\'s records with 404 (was: the action ran)', async () => {
      const cancel = await auth(api().post(`/api/v1/orders/${orderB}/cancel`), adminA).send({ reason: 'scope test' });
      expect(cancel.status).toBe(404);
      const voided = await auth(api().post(`/api/v1/pos/transactions/${posB}/void`), adminA).send({ reason: 'scope test' });
      expect(voided.status).toBe(404);
      const submit = await auth(api().post(`/api/v1/purchase-orders/${poB}/submit`), adminA);
      expect(submit.status).toBe(404);

      const order = await db.query(`SELECT status FROM orders WHERE id = $1`, [orderB]);
      expect(order.rows[0].status).toBe('CONFIRMED');
    });

    it('staff with access to all branches may view them, but must switch branch to act', async () => {
      for (const path of reads()) {
        const res = await auth(api().get(path), globalAdmin);
        expect({ path, status: res.status }).toEqual({ path, status: 200 });
      }
      const cancel = await auth(api().post(`/api/v1/orders/${orderB}/cancel`), globalAdmin).send({ reason: 'scope test' });
      expect(cancel.status).toBe(404);
    });

    it('a purchase order belongs to both its ordering and its receiving branch', async () => {
      expect((await auth(api().get(`/api/v1/purchase-orders/${poAtoB}`), adminA)).status).toBe(200);
      expect((await auth(api().get(`/api/v1/purchase-orders/${poAtoB}`), adminB)).status).toBe(200);
      expect((await auth(api().get(`/api/v1/purchase-orders/${poB}`), adminB)).status).toBe(200);
    });
  });

  describe('locations and branches in write requests', () => {
    it('refuses stock movements in another branch\'s location with 403', async () => {
      const stockIn = await auth(api().post('/api/v1/inventory/stock-in'), adminA)
        .send({ bookId, locationId: locB, quantity: 1, version: 0, referenceType: 'manual' });
      expect(stockIn.status).toBe(403);
      expect(stockIn.body).toMatchObject({ error: 'BRANCH_ACCESS_DENIED', details: { branchId: branchB } });

      const transfer = await auth(api().post('/api/v1/inventory/transfer'), adminA)
        .send({ bookId, fromLocationId: locA, toLocationId: locB, quantity: 1, fromVersion: 0 });
      expect(transfer.status).toBe(403);
    });

    it('refuses a sale or order from another branch\'s location with 403', async () => {
      const sale = await auth(api().post('/api/v1/pos/transactions'), adminA)
        .send({ locationId: locB, items: [{ bookId, quantity: 1 }], payments: [] });
      expect(sale.status).toBe(403);
      const order = await auth(api().post('/api/v1/orders'), adminA)
        .send({ locationId: locB, items: [{ bookId, quantity: 1 }] });
      expect(order.status).toBe(403);
    });

    it('refuses booking a sale or purchase order in another branch', async () => {
      const sale = await auth(api().post('/api/v1/pos/transactions'), adminA)
        .send({ branchId: branchB, locationId: locA, items: [{ bookId, quantity: 1 }], payments: [] });
      expect(sale.status).toBe(403);
      expect(sale.body.error).toBe('BRANCH_ACCESS_DENIED');

      const po = await auth(api().post('/api/v1/purchase-orders'), adminA)
        .send({ branchId: branchB, supplierId: 1, lineItems: [{ bookId, quantity: 1, unitCost: 1 }] });
      expect(po.status).toBe(403);
    });

    it('lets only the branch itself, or staff with all-branch access, change its locations', async () => {
      const name = `${BRANCH_PREFIX} New Loc`;
      const denied = await auth(api().post(`/api/v1/branches/${branchB}/locations`), adminA).send({ name });
      expect(denied.status).toBe(403);
      expect(denied.body.error).toBe('BRANCH_ACCESS_DENIED');

      const allowed = await auth(api().post(`/api/v1/branches/${branchB}/locations`), globalAdmin).send({ name });
      expect(allowed.status).toBe(201);

      // Listing stays open: purchasing picks another branch's receiving location.
      const list = await auth(api().get(`/api/v1/branches/${branchB}/locations`), adminA);
      expect(list.status).toBe(200);
    });
  });
});
