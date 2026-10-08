import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { OrderListResponseSchema, OrderSchema } from '@bms/shared';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

// #20 part 2: order requests are validated by, and responses follow, the
// shared contracts in @bms/shared (order.ts).

const STAFF_PREFIX = 'ordc_test_';
const BRANCH_PREFIX = 'Order Contract Branch';

describe('Orders on the shared contracts', () => {
  let token: string;
  let branchId: number;
  let locationId: number;
  let bookId: number;
  const api = () => request(getTestApp());
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);

  async function cleanUp() {
    const branches = (await db.query(`SELECT id FROM branches WHERE name LIKE $1`, [`${BRANCH_PREFIX}%`])).rows.map((r) => r.id);
    if (branches.length) {
      const ids = `(SELECT id FROM orders WHERE branch_id = ANY($1))`;
      await db.query(`DELETE FROM order_payments WHERE order_id IN ${ids}`, [branches]);
      await db.query(`DELETE FROM inventory_reservations WHERE order_id IN ${ids}`, [branches]);
      await db.query(`DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id = ANY($1))`, [branches]);
      await db.query(`DELETE FROM orders WHERE branch_id = ANY($1)`, [branches]);
      await db.query(`DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id = ANY($1))`, [branches]);
    }
    await db.query(`DELETE FROM idempotency_keys WHERE key LIKE 'ordc-%'`);
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    branchId = (await createTestBranch({ name: `${BRANCH_PREFIX} A` })).branchId;
    locationId = (await db.query(
      `INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, $2, true) RETURNING id`,
      [branchId, `${BRANCH_PREFIX} Loc`],
    )).rows[0].id;
    token = (await createTestStaff({ username: `${STAFF_PREFIX}admin`, role: 'Admin', branchId })).token;
    bookId = (await db.query(`SELECT id FROM books WHERE is_active = true AND default_price IS NOT NULL ORDER BY id LIMIT 1`)).rows[0].id;
    await db.query(`INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version) VALUES ($1, $2, 50, 0, 0)`, [bookId, locationId]);
  });

  afterAll(cleanUp);

  const draft = (extra: Record<string, unknown> = {}) =>
    auth(api().post('/api/v1/orders')).send({ locationId, items: [{ bookId, quantity: 1 }], ...extra });

  it('returns orders and lists in the shape of the shared schemas', async () => {
    const created = await draft();
    expect(created.status).toBe(201);
    expect(OrderSchema.strict().parse(created.body)).toEqual(created.body);
    expect(created.body).toMatchObject({ status: 'DRAFT', channel: 'in_store', saleType: 'cash_sale' });

    const confirmed = await auth(api().post(`/api/v1/orders/${created.body.id}/confirm`)).send({ paymentMethod: 'mobile' });
    expect(OrderSchema.strict().parse(confirmed.body)).toEqual(confirmed.body);
    expect(confirmed.body).toMatchObject({ status: 'CONFIRMED', paymentStatus: 'paid', paymentMethod: 'mobile' });

    const list = await auth(api().get('/api/v1/orders?pageSize=500'));
    expect(OrderListResponseSchema.strict().parse(list.body)).toEqual(list.body);
    expect(list.body.pageSize).toBe(100);
  });

  it('rejects invalid requests with 400 VALIDATION_ERROR', async () => {
    const cases: [string, request.Test][] = [
      ['no items', auth(api().post('/api/v1/orders')).send({ items: [] })],
      ['unknown channel', draft({ channel: 'fax' })],
      ['zero quantity', auth(api().post('/api/v1/orders')).send({ items: [{ bookId, quantity: 0 }] })],
      ['unknown discount mode', auth(api().post('/api/v1/orders')).send({ items: [{ bookId, quantity: 1, discountMode: 'Coupon' }] })],
      ['non-numeric id', auth(api().get('/api/v1/orders/abc'))],
      ['bad date filter', auth(api().get('/api/v1/orders?dateFrom=yesterday'))],
      ['payment amount as text', auth(api().post('/api/v1/orders/1/collect-payment')).send({ amount: '10' })],
    ];
    for (const [name, req] of cases) {
      const res = await req;
      expect({ name, status: res.status, error: res.body.error }).toEqual({ name, status: 400, error: 'VALIDATION_ERROR' });
    }
  });

  it('replays an order creation sent twice with the same Idempotency-Key', async () => {
    const key = `ordc-${Date.now()}`;
    const first = await draft().set('Idempotency-Key', key);
    const second = await draft().set('Idempotency-Key', key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.headers['x-idempotent-replayed']).toBe('true');
    expect(second.body.id).toBe(first.body.id);
  });

  it('still refuses the retired pay endpoint with 410 DEPRECATED', async () => {
    const created = await draft();
    const res = await auth(api().post(`/api/v1/orders/${created.body.id}/pay`));
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('DEPRECATED');
  });
});
