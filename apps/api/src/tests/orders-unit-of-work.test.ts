import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';
import * as ordersService from '../modules/orders/orders.service.js';
import type { StaffCtx } from '../modules/orders/orders.service.js';

// #20: confirming an order is one Unit of Work across Orders, Inventory and
// Receivables. If its last step fails, nothing before it stays done.

const STAFF_PREFIX = 'uow_orders_test_';
const BRANCH_PREFIX = 'UoW Orders Branch';
const CUSTOMER_CODE = 'UOW-ORD-001';

describe('Orders: one Unit of Work per use case', () => {
  let staff: StaffCtx;
  let branchId: number;
  let locationId: number;
  let bookId: number;
  let customerId: number;
  const orderIds: string[] = [];

  const stockOf = async () =>
    Number((await db.query(`SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locationId])).rows[0].quantity);

  async function cleanUp() {
    await db.query(`DROP TRIGGER IF EXISTS uow_test_fail_receivable ON receivables`);
    await db.query(`DROP FUNCTION IF EXISTS uow_test_fail_receivable()`);
    const branches = (await db.query(`SELECT id FROM branches WHERE name LIKE $1`, [`${BRANCH_PREFIX}%`])).rows.map((r) => r.id);
    if (branches.length) {
      const ids = `(SELECT id FROM orders WHERE branch_id = ANY($1))`;
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
    branchId = (await createTestBranch({ name: `${BRANCH_PREFIX} A` })).branchId;
    locationId = (await db.query(
      `INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, $2, true) RETURNING id`,
      [branchId, `${BRANCH_PREFIX} Loc`],
    )).rows[0].id;
    const s = await createTestStaff({ username: `${STAFF_PREFIX}admin`, role: 'Admin', branchId });
    staff = { staffId: s.staffId, role: 'Admin', branchId };
    bookId = (await db.query(`SELECT id FROM books WHERE is_active = true AND default_price IS NOT NULL ORDER BY id LIMIT 1`)).rows[0].id;
    await db.query(
      `INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version, average_cost) VALUES ($1, $2, 10, 0, 0, 5)`,
      [bookId, locationId],
    );
    customerId = (await db.query(
      `INSERT INTO customers (full_name, customer_code, is_active) VALUES ('UoW Orders Customer', $1, true) RETURNING id`,
      [CUSTOMER_CODE],
    )).rows[0].id;
  });

  afterAll(cleanUp);

  async function draftCreditOrder(): Promise<string> {
    const order = await ordersService.create(
      { customerId, locationId, saleType: 'credit_sale', items: [{ bookId, quantity: 3 }] },
      staff,
    );
    orderIds.push(order.id);
    return order.id;
  }

  it('rolls back the stock-out and the status change when opening the receivable fails', async () => {
    const orderId = await draftCreditOrder();
    const before = await stockOf();

    // Make the last step of confirm() fail: the receivable insert.
    await db.query(`CREATE FUNCTION uow_test_fail_receivable() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'receivable refused by test'; END $$`);
    await db.query(`CREATE TRIGGER uow_test_fail_receivable BEFORE INSERT ON receivables
      FOR EACH ROW EXECUTE FUNCTION uow_test_fail_receivable()`);
    try {
      await expect(ordersService.confirm(orderId, staff, '2999-12-31')).rejects.toThrow('receivable refused by test');
    } finally {
      await db.query(`DROP TRIGGER uow_test_fail_receivable ON receivables`);
      await db.query(`DROP FUNCTION uow_test_fail_receivable()`);
    }

    expect(await stockOf()).toBe(before);
    const order = await ordersService.getById(orderId);
    expect(order.status).toBe('DRAFT');
    expect(order.lineItems?.[0]).toMatchObject({ qtyReserved: 0, unitCost: null });
    const reservations = await db.query(`SELECT 1 FROM inventory_reservations WHERE order_id = $1`, [orderId]);
    expect(reservations.rows).toHaveLength(0);
    const history = await db.query(
      `SELECT 1 FROM inventory_history WHERE reference_type = 'order_confirmed' AND reference_id = $1`,
      [orderId],
    );
    expect(history.rows).toHaveLength(0);
  });

  it('commits all three modules together when every step succeeds', async () => {
    const orderId = await draftCreditOrder();
    const before = await stockOf();

    const order = await ordersService.confirm(orderId, staff, '2999-12-31');

    expect(order.status).toBe('CONFIRMED');
    expect(await stockOf()).toBe(before - 3);
    const receivable = await db.query(
      `SELECT original_amount FROM receivables WHERE source_type = 'order_credit_sale' AND source_entity_id = $1`,
      [orderId],
    );
    expect(Number(receivable.rows[0].original_amount)).toBe(order.total);
  });

  it('confirms an order only once, even when asked twice at the same time', async () => {
    const orderId = await draftCreditOrder();
    const before = await stockOf();

    const results = await Promise.allSettled([
      ordersService.confirm(orderId, staff, '2999-12-31'),
      ordersService.confirm(orderId, staff, '2999-12-31'),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'INVALID_STATE' });
    expect(await stockOf()).toBe(before - 3);
  });
});
