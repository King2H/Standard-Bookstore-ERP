import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';
import * as ordersService from '../modules/orders/orders.service.js';
import type { StaffCtx } from '../modules/orders/orders.service.js';

// #21: POST /orders/:id/collect-payment lowered a credit order's receivable
// without recording a payment (no method, receipt or ledger entry), so the
// money went missing from the books. It answers 410 now; part payments go
// through POST /payments (#71's partial status is checked there). The legacy
// /progress endpoint could never succeed and answers 410 too (#69).

const STAFF_PREFIX = 'collect_test_';
const BRANCH_PREFIX = 'Collect Test Branch';
const CUSTOMER_CODE = 'COLLECT-001';

describe('Collecting payment on a credit order', () => {
  let staff: StaffCtx;
  let token: string;
  let orderId: string;
  let total: number;

  async function cleanUp() {
    const branches = (await db.query(`SELECT id FROM branches WHERE name LIKE $1`, [`${BRANCH_PREFIX}%`])).rows.map((r) => r.id);
    if (branches.length) {
      const ids = `(SELECT id FROM orders WHERE branch_id = ANY($1))`;
      await db.query(`WITH refunds AS (DELETE FROM order_refunds WHERE payment_id IN (SELECT id FROM order_payments WHERE order_id IN ${ids})) DELETE FROM order_payments WHERE order_id IN ${ids}`, [branches]);
      await db.query(`DELETE FROM receivables WHERE source_type = 'order_credit_sale' AND source_entity_id IN ${ids}`, [branches]);
      await db.query(`DELETE FROM inventory_reservations WHERE order_id IN ${ids}`, [branches]);
      await db.query(`DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id = ANY($1))`, [branches]);
      await db.query(`DELETE FROM orders WHERE branch_id = ANY($1)`, [branches]);
      await db.query(`DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id = ANY($1))`, [branches]);
    }
    await db.query(`DELETE FROM customers WHERE customer_code = $1`, [CUSTOMER_CODE]);
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    const branchId = (await createTestBranch({ name: `${BRANCH_PREFIX} A` })).branchId;
    const locationId = (await db.query(
      `INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, $2, true) RETURNING id`,
      [branchId, `${BRANCH_PREFIX} Loc`],
    )).rows[0].id;
    const s = await createTestStaff({ username: `${STAFF_PREFIX}admin`, role: 'Admin', branchId });
    staff = { staffId: s.staffId, role: 'Admin', branchId };
    token = s.token;
    const bookId = (await db.query(`SELECT id FROM books WHERE is_active = true AND default_price IS NOT NULL ORDER BY id LIMIT 1`)).rows[0].id;
    await db.query(`INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version) VALUES ($1, $2, 10, 0, 0)`, [bookId, locationId]);
    const customerId = (await db.query(
      `INSERT INTO customers (full_name, customer_code, is_active) VALUES ('Collect Test Customer', $1, true) RETURNING id`,
      [CUSTOMER_CODE],
    )).rows[0].id;

    const order = await ordersService.create({ customerId, locationId, saleType: 'credit_sale', items: [{ bookId, quantity: 2 }] }, staff);
    await ordersService.confirm(order.id, staff, '2999-12-31');
    await ordersService.fulfill(order.id, staff);
    orderId = order.id;
    total = order.total;
  });

  afterAll(cleanUp);

  const outstanding = async () =>
    Number((await db.query(
      `SELECT outstanding_amount FROM receivables WHERE source_type = 'order_credit_sale' AND source_entity_id = $1`,
      [orderId],
    )).rows[0].outstanding_amount);

  const post = (path: string, body: object = {}) =>
    request(getTestApp())
      .post(`/api/v1/orders/${orderId}/${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  it('refuses collect-payment with 410 and leaves the receivable as it was (was: lowered with no payment recorded)', async () => {
    const res = await post('collect-payment', { amount: 1 });

    expect(res.status).toBe(410);
    expect(res.body.error).toBe('DEPRECATED');
    expect(await outstanding()).toBeCloseTo(total, 2);
  });

  it('refuses the legacy progress endpoint with 410 (was: 422 for every order)', async () => {
    const res = await post('progress');

    expect(res.status).toBe(410);
    expect(res.body.error).toBe('DEPRECATED');
  });

  it('takes a part payment through Payments: recorded, and the order partly paid', async () => {
    const res = await request(getTestApp())
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${token}`)
      .send({ orderId: Number(orderId), amount: 1, paymentMethod: 'cash' });

    expect(res.status).toBe(201);
    expect(await outstanding()).toBeCloseTo(total - 1, 2);
    const order = await request(getTestApp()).get(`/api/v1/orders/${orderId}`).set('Authorization', `Bearer ${token}`);
    expect(order.body.paymentStatus).toBe('partial');
  });
});
