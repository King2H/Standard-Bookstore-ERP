/**
 * Module 9 — admin-only delete for Draft/Cancelled orders, with dependency
 * checks (orders.service.ts deleteOrder()).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'del_test_';
const BRANCH_PREFIX = 'Delete Test ';

describe('Order delete (Module 9)', () => {
  let adminToken: string;
  let managerToken: string;
  let branchId: number;
  let locationId: number;
  let bookId: number;
  let customerId: number;

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
    await db.query(`DELETE FROM customers WHERE customer_code LIKE 'DELCUS%'`);

    const branch = await createTestBranch({ name: 'Delete Test Branch' });
    branchId = branch.branchId;

    const admin = await createTestStaff({ username: 'del_test_admin', role: 'Admin', branchId });
    adminToken = admin.token;
    const mgr = await createTestStaff({ username: 'del_test_mgr', role: 'Manager', branchId });
    managerToken = mgr.token;

    const locRes = await db.query(
      `INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Delete Test Loc', true) RETURNING id`,
      [branchId],
    );
    locationId = locRes.rows[0].id as number;

    const bookRes = await db.query(`SELECT id FROM books WHERE is_active = true LIMIT 1`);
    bookId = bookRes.rows[0].id as number;
    await db.query(
      `INSERT INTO inventory (book_id, location_id, quantity) VALUES ($1, $2, 50)
       ON CONFLICT (book_id, location_id) DO UPDATE SET quantity = 50`,
      [bookId, locationId],
    );

    const custRes = await db.query(
      `INSERT INTO customers (branch_id, customer_code, full_name, phone, is_active, created_at)
       VALUES ($1, 'DELCUS-001', 'Delete Test Customer', '555-7777', true, now())
       ON CONFLICT (customer_code) DO UPDATE SET branch_id = EXCLUDED.branch_id
       RETURNING id`,
      [branchId],
    );
    customerId = custRes.rows[0].id as number;
  });

  afterAll(async () => {
    // Payment Mode Capture: cash_sale confirms now write an order_payments
    // row, so it must be cleaned up before orders (FK) same as the other
    // order test suites' cleanOrders() helpers already do.
    await db.query(`DELETE FROM order_payments WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`, [branchId]);
    await db.query(`DELETE FROM order_line_items WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`, [branchId]);
    await db.query(`DELETE FROM receivables WHERE branch_id = $1`, [branchId]);
    await db.query(`DELETE FROM orders WHERE branch_id = $1`, [branchId]);
    await db.query(`DELETE FROM customers WHERE customer_code LIKE 'DELCUS%'`);
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  async function createOrder(saleType: 'cash_sale' | 'credit_sale', withCustomer = false) {
    const res = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        locationId, saleType,
        customerId: withCustomer ? customerId : undefined,
        items: [{ bookId, quantity: 1 }],
      });
    expect(res.status).toBe(201);
    return res.body as { id: string; orderNumber: string };
  }

  // ── 1. Admin deletes a never-confirmed DRAFT order ─────────────────────────

  it('1. Admin can delete a DRAFT order with no dependencies', async () => {
    const order = await createOrder('cash_sale');

    const res = await request(getTestApp())
      .delete(`/api/orders/${order.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(res.status).toBe(200);

    const check = await db.query(`SELECT 1 FROM orders WHERE id = $1`, [order.id]);
    expect(check.rows.length).toBe(0);
  });

  // ── 2. Admin deletes a CANCELLED order that was never confirmed ────────────

  it('2. Admin can delete a CANCELLED order that was never confirmed (no history)', async () => {
    const order = await createOrder('cash_sale');

    const cancelRes = await request(getTestApp())
      .post(`/api/orders/${order.id}/cancel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ reason: 'test' });
    expect(cancelRes.status).toBe(200);

    const res = await request(getTestApp())
      .delete(`/api/orders/${order.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(res.status).toBe(200);
    const check = await db.query(`SELECT 1 FROM orders WHERE id = $1`, [order.id]);
    expect(check.rows.length).toBe(0);
  });

  // ── 3. Non-Admin is rejected ────────────────────────────────────────────────

  it('3. Manager (non-Admin) cannot delete an order → 403', async () => {
    const order = await createOrder('cash_sale');

    const res = await request(getTestApp())
      .delete(`/api/orders/${order.id}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(res.status).toBe(403);

    const check = await db.query(`SELECT 1 FROM orders WHERE id = $1`, [order.id]);
    expect(check.rows.length).toBe(1);
  });

  // ── 4. CONFIRMED orders cannot be deleted ───────────────────────────────────

  it('4. Cannot delete a CONFIRMED order → 422 INVALID_STATE', async () => {
    const order = await createOrder('cash_sale');
    const confirmRes = await request(getTestApp())
      .post(`/api/orders/${order.id}/confirm`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({});
    expect(confirmRes.status).toBeGreaterThanOrEqual(200);
    expect(confirmRes.status).toBeLessThan(300);

    const res = await request(getTestApp())
      .delete(`/api/orders/${order.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('INVALID_STATE');
  });

  // ── 5. A cancelled order with real history (receivable) is protected ──────

  it('5. Cannot delete a CANCELLED credit order that left a receivable behind → 422 ORDER_HAS_DEPENDENCIES', async () => {
    const order = await createOrder('credit_sale', true);
    const confirmRes = await request(getTestApp())
      .post(`/api/orders/${order.id}/confirm`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ dueDate: '2099-12-31' });
    expect(confirmRes.status).toBeGreaterThanOrEqual(200);
    expect(confirmRes.status).toBeLessThan(300);

    // Confirm a receivable now exists for this order.
    const recCheck = await db.query(
      `SELECT 1 FROM receivables WHERE source_type = 'order_credit_sale' AND source_entity_id = $1`,
      [order.id],
    );
    expect(recCheck.rows.length).toBe(1);

    const cancelRes = await request(getTestApp())
      .post(`/api/orders/${order.id}/cancel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ reason: 'test' });
    expect(cancelRes.status).toBe(200);

    const res = await request(getTestApp())
      .delete(`/api/orders/${order.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('ORDER_HAS_DEPENDENCIES');

    const check = await db.query(`SELECT 1 FROM orders WHERE id = $1`, [order.id]);
    expect(check.rows.length).toBe(1);
  });

  // ── 6. Order reference date-stamp matches the DB's CURRENT_DATE ───────────

  it("6. New order's date-stamp matches the DB's CURRENT_DATE (not Node's UTC clock)", async () => {
    const order = await createOrder('cash_sale');
    const dbDate = await db.query(`SELECT TO_CHAR(CURRENT_DATE, 'YYYYMMDD') AS d`);
    expect(order.orderNumber).toContain(`ORD-${dbDate.rows[0].d}-`);
  });
});
