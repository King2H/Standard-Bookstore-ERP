/**
 * special-orders.test.ts
 *
 * #174 (owner decisions 4a, and 1a–6a of its API survey, 2026-10-31): a book
 * not in stock is ordered for a customer. Its line is marked special order
 * and confirmed without stock, on a credit sale that can take a deposit.
 * Purchasers list the lines still to buy and add them to a purchase order,
 * which links the two. When the books arrive at the order's place they are
 * reserved for it, oldest order first, and the sellers are told; arriving
 * elsewhere, they are told to transfer them and reserve them from stock.
 * Lines still on order wait: delivery hands over what arrived, and
 * cancelling releases their link. Before, confirming refused a book not in
 * stock and nothing linked an order to a purchase order.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'spord_test_';
const BRANCH_PREFIX = 'Special Order ';
const CODE = 'SPORD';

interface Line { id: string; bookId: number; quantity: number; qtyReserved: number; qtyFulfilled: number; qtyCancelled: number; qtyOnOrder: number; specialOrder: boolean }
interface Order { id: string; orderNumber: string; status: string; total: number; amountPaid: number; lineItems: Line[]; allowedActions: string[] }
interface OpenLine { orderLineId: string; orderNumber: string; customerName: string | null; bookId: number; quantity: number; onOrder: number; linked: number; toOrder: number }

describe('Special orders for books not in stock (#174)', () => {
  let branchA: number;
  let shelf: number;
  let back: number;
  let customerId: number;
  let supplierId: number;
  let rare: number;
  let stocked: number;
  const t: Record<string, string> = {};
  const api = () => request(getTestApp());
  const as = (token: string) => ({
    get: (path: string) => api().get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) => api().post(path).set('Authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object = {}) => api().put(path).set('Authorization', `Bearer ${token}`).send(body),
  });
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  const onHand = async (book: number, location = shelf) =>
    Number((await one(`SELECT COALESCE(SUM(quantity), 0) AS q FROM inventory WHERE book_id = $1 AND location_id = $2`, [book, location])).q);
  const lineOf = (order: Order, book: number) => order.lineItems.find((l) => l.bookId === book)!;
  const getOrder = async (id: string): Promise<Order> => (await as(t.sales).get(`/api/v1/orders/${id}`)).body;
  const openLines = async (): Promise<OpenLine[]> => (await as(t.purchasor).get('/api/v1/special-orders')).body.items;

  /** A confirmed credit order of `copies` special-order copies of the rare book, and `plain` of the stocked one. */
  async function specialOrder(copies: number, plain = 0, deposit?: number): Promise<Order> {
    const items = [{ bookId: rare, quantity: copies, specialOrder: true }, ...(plain ? [{ bookId: stocked, quantity: plain }] : [])];
    const created = await as(t.sales).post('/api/v1/orders', { locationId: shelf, saleType: 'credit_sale', customerId, items });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const confirmed = await as(t.sales).post(`/api/v1/orders/${created.body.id}/confirm`, {
      dueDate: '2099-12-31', ...(deposit && { deposit, paymentMethod: 'cash' }),
    });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    return confirmed.body;
  }

  /** A draft purchase order of one stocked book, to add special orders to. */
  async function draftPo(): Promise<{ id: string }> {
    const created = await as(t.purchasor).post('/api/v1/purchase-orders', { supplierId, lineItems: [{ bookId: stocked, quantity: 1, unitCost: 5 }] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body;
  }
  const link = (poId: string, lines: object[], token = t.purchasor) => as(token).post(`/api/v1/purchase-orders/${poId}/special-orders`, { lines });
  async function receive(poId: string, quantity: number, locationId = shelf) {
    const po = (await as(t.purchasor).get(`/api/v1/purchase-orders/${poId}`)).body;
    const line = po.lineItems.find((l: { bookId: number }) => l.bookId === rare);
    const res = await as(t.clerk).post(`/api/v1/purchase-orders/${poId}/receive`, { locationId, items: [{ poLineItemId: Number(line.id), quantityReceived: quantity }] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
  const submit = async (poId: string) => expect((await as(t.purchasor).post(`/api/v1/purchase-orders/${poId}/submit`)).body.status).toBe('approved');

  async function cleanUp() {
    const branches = `SELECT id FROM branches WHERE name LIKE '${BRANCH_PREFIX}%'`;
    const orders = `SELECT id FROM orders WHERE branch_id IN (${branches})`;
    const pos = `SELECT id FROM purchase_orders WHERE supplier_id IN (SELECT id FROM suppliers WHERE name = '${CODE}')`;
    const customer = `SELECT id FROM customers WHERE customer_code = '${CODE}'`;
    for (const statement of [
      `DELETE FROM special_order_links WHERE po_id IN (${pos})`,
      `DELETE FROM order_deliveries WHERE order_id IN (${orders})`,
      `DELETE FROM refunds WHERE return_id IN (SELECT id FROM returns WHERE branch_id IN (${branches}))`,
      `DELETE FROM return_line_items WHERE return_id IN (SELECT id FROM returns WHERE branch_id IN (${branches}))`,
      `DELETE FROM order_refunds WHERE order_id IN (${orders})`,
      `DELETE FROM returns WHERE branch_id IN (${branches})`,
      `DELETE FROM order_payments WHERE order_id IN (${orders})`,
      `DELETE FROM financial_transactions WHERE receivable_id IN (SELECT id FROM receivables WHERE branch_id IN (${branches}))`,
      `DELETE FROM receivables WHERE branch_id IN (${branches})`,
      `DELETE FROM inventory_reservations WHERE order_id IN (${orders})`,
      `DELETE FROM cash_session_movements WHERE session_id IN (SELECT id FROM cash_sessions WHERE branch_id IN (${branches}))`,
      `DELETE FROM orders WHERE branch_id IN (${branches})`,
      `DELETE FROM po_receipt_items WHERE receipt_id IN (SELECT id FROM po_receipts WHERE po_id IN (${pos}))`,
      `DELETE FROM po_receipts WHERE po_id IN (${pos})`,
      `DELETE FROM supplier_payments WHERE po_id IN (${pos})`,
      `DELETE FROM po_line_items WHERE po_id IN (${pos})`,
      `DELETE FROM purchase_orders WHERE id IN (${pos})`,
      `DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM suppliers WHERE name = '${CODE}'`,
      `DELETE FROM store_credit_history WHERE customer_id IN (${customer})`,
      `DELETE FROM store_credit_accounts WHERE customer_id IN (${customer})`,
      `DELETE FROM customers WHERE customer_code = '${CODE}'`,
    ]) {
      await db.query(statement).catch((err: { code?: string }) => {
        if (err.code !== '42P01' && err.code !== '42703') throw err;
      });
    }
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    branchA = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    const branchB = (await createTestBranch({ name: `${BRANCH_PREFIX}B` })).branchId;
    const loc = async (name: string, isDefault: boolean) =>
      (await one(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, $2, $3) RETURNING id`, [branchA, name, isDefault])).id as number;
    shelf = await loc('Special shelf', true);
    back = await loc('Special back room', false);
    for (const [name, role, branch] of [
      ['sales', 'Sales', branchA], ['manager', 'Manager', branchA], ['purchasor', 'Purchasor', branchA], ['clerk', 'Stock_Clerk', branchA],
      ['purchasorB', 'Purchasor', branchB],
    ] as const) {
      t[name] = (await createTestStaff({ username: `${STAFF_PREFIX}${name}`, role, branchId: branch })).token;
    }
    [rare, stocked] = (await db.query(`SELECT id FROM books WHERE is_active = true AND default_price > 0 ORDER BY id LIMIT 2`)).rows.map((r) => r.id as number);
    await db.query(`INSERT INTO inventory (book_id, location_id, quantity, average_cost) VALUES ($1, $2, 0, 0), ($3, $2, 20, 1)`, [rare, shelf, stocked]);
    customerId = (await one(
      `INSERT INTO customers (branch_id, customer_code, full_name, is_active) VALUES ($1, $2, 'Special Customer', true) RETURNING id`, [branchA, CODE],
    )).id;
    supplierId = (await one(`INSERT INTO suppliers (name, contact_info, lead_time_days, supplier_type) VALUES ($1, '{}', 7, 'external') RETURNING id`, [CODE])).id;
  });

  afterAll(cleanUp);

  it('confirms a special-order line without stock, on a credit sale with a deposit, and lists it to buy (was: refused for lack of stock)', async () => {
    const order = await specialOrder(2, 1, 10);
    expect(order.status).toBe('CONFIRMED');
    expect(lineOf(order, rare)).toMatchObject({ specialOrder: true, qtyReserved: 0, qtyOnOrder: 2 });
    expect(lineOf(order, stocked)).toMatchObject({ specialOrder: false, qtyReserved: 1, qtyOnOrder: 0 });
    expect(order.amountPaid).toBe(10);
    expect(await onHand(rare)).toBe(0);
    const debt = await one(`SELECT outstanding_amount::float AS owed FROM receivables WHERE source_type = 'order_credit_sale' AND source_entity_id = $1`, [order.id]);
    expect(debt.owed).toBeCloseTo(order.total - 10, 2);

    const listed = (await openLines()).find((l) => l.orderLineId === lineOf(order, rare).id);
    expect(listed).toMatchObject({ orderNumber: order.orderNumber, customerName: 'Special Customer', bookId: rare, quantity: 2, onOrder: 2, linked: 0, toOrder: 2 });

    // A special order is a credit sale; its copies take no binding until they arrive.
    const cash = await as(t.sales).post('/api/v1/orders', { locationId: shelf, customerId, items: [{ bookId: rare, quantity: 1, specialOrder: true }] });
    expect([cash.status, cash.body.error]).toEqual([422, 'SPECIAL_ORDER_NEEDS_CREDIT']);
    const tooMuch = await as(t.sales).post('/api/v1/orders', { locationId: shelf, saleType: 'credit_sale', customerId, items: [{ bookId: rare, quantity: 1, specialOrder: true }] });
    expect((await as(t.sales).post(`/api/v1/orders/${tooMuch.body.id}/confirm`, { dueDate: '2099-12-31', deposit: 1e6 })).body.error).toBe('VALIDATION_ERROR');
    expect((await as(t.sales).get('/api/v1/special-orders')).status).toBe(403);
  });

  it('links lines to a purchase order and reserves the copies that arrive, oldest order first, telling the sellers', async () => {
    const first = await specialOrder(2);
    const second = await specialOrder(2);
    const po = await draftPo();
    const res = await link(po.id, [
      { orderLineId: Number(lineOf(first, rare).id), quantity: 2, unitCost: 8 },
      { orderLineId: Number(lineOf(second, rare).id), quantity: 2 },
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.lineItems.find((l: { bookId: number }) => l.bookId === rare)).toMatchObject({
      quantity: 4, unitCost: 8,
      // Receiving staff see which copies are for customers (screens 6a).
      specialOrders: [
        { orderLineId: lineOf(first, rare).id, orderNumber: first.orderNumber, quantity: 2, reserved: 0 },
        { orderLineId: lineOf(second, rare).id, orderNumber: second.orderNumber, quantity: 2, reserved: 0 },
      ],
    });
    expect((await link(po.id, [{ orderLineId: Number(lineOf(first, rare).id), quantity: 1 }])).body.error).toBe('SPECIAL_ORDER_EXCEEDS_REMAINING');
    expect((await link(po.id, [{ orderLineId: Number(lineOf(first, rare).id), quantity: 1 }], t.purchasorB)).status).toBe(404);
    expect((await openLines()).find((l) => l.orderLineId === lineOf(first, rare).id)).toMatchObject({ linked: 2, toOrder: 0 });

    // The purchase order keeps what is linked to it.
    const edited = await as(t.purchasor).put(`/api/v1/purchase-orders/${po.id}`, {
      lineItems: [{ bookId: stocked, quantity: 1, unitCost: 5 }, { bookId: rare, quantity: 3, unitCost: 8 }],
    });
    expect([edited.status, edited.body.error]).toEqual([422, 'SPECIAL_ORDERS_LINKED']);

    await submit(po.id);
    await receive(po.id, 3);
    const a = await getOrder(first.id);
    const b = await getOrder(second.id);
    expect(lineOf(a, rare)).toMatchObject({ qtyReserved: 2, qtyOnOrder: 0 });
    expect(lineOf(b, rare)).toMatchObject({ qtyReserved: 1, qtyOnOrder: 1 });
    expect(await onHand(rare)).toBe(0);
    const told = await db.query(`SELECT payload FROM outbox WHERE event_type = 'special_order.arrived' AND payload->>'orderId' IN ($1, $2)`, [first.id, second.id]);
    expect(told.rows.map((r) => r.payload.quantity).sort()).toEqual([1, 2]);

    // The first order is delivered in full; the second hands over what came and waits for the rest.
    expect((await as(t.sales).post(`/api/v1/orders/${first.id}/fulfill`)).body.status).toBe('COMPLETED');
    expect((await as(t.sales).post(`/api/v1/orders/${second.id}/fulfill`)).body.status).toBe('PART_DELIVERED');

    // The last copy arrives in the back room: the sellers are told to bring it over and reserve it.
    await receive(po.id, 1, back);
    expect(lineOf(await getOrder(second.id), rare)).toMatchObject({ qtyReserved: 0, qtyOnOrder: 1 });
    const elsewhere = await one(`SELECT payload FROM outbox WHERE event_type = 'special_order.arrived_elsewhere' AND payload->>'orderId' = $1`, [second.id]);
    expect(elsewhere.payload).toMatchObject({ quantity: 1, locationName: 'Special back room' });
    const short = await as(t.sales).post(`/api/v1/orders/${second.id}/lines/${lineOf(b, rare).id}/reserve`);
    expect([short.status, short.body.error]).toEqual([422, 'INSUFFICIENT_STOCK']);
    await db.query(`UPDATE inventory SET quantity = quantity + 1 WHERE book_id = $1 AND location_id = $2`, [rare, shelf]);
    await db.query(`UPDATE inventory SET quantity = quantity - 1 WHERE book_id = $1 AND location_id = $2`, [rare, back]);
    const reserved = await as(t.sales).post(`/api/v1/orders/${second.id}/lines/${lineOf(b, rare).id}/reserve`);
    expect(reserved.status, JSON.stringify(reserved.body)).toBe(200);
    expect(lineOf(reserved.body, rare)).toMatchObject({ qtyReserved: 1, qtyOnOrder: 0 });
    expect((await as(t.sales).post(`/api/v1/orders/${second.id}/fulfill`)).body.status).toBe('COMPLETED');
  });

  it('keeps copies still on order waiting, and cancelling releases their link', async () => {
    const mixed = await specialOrder(2, 1, 10);
    const only = await specialOrder(1);
    expect((await as(t.sales).post(`/api/v1/orders/${only.id}/fulfill`)).body.error).toBe('INVALID_STATE');
    // Nothing to hand over: neither the order nor the list offers it (screens 5a).
    expect(only.allowedActions).not.toEqual(expect.arrayContaining(['fulfill']));
    expect(only.allowedActions).not.toContain('deliver');
    const listed = (await as(t.sales).get(`/api/v1/orders?orderNumber=${only.orderNumber}`)).body.items[0];
    expect(listed.allowedActions).not.toContain('fulfill');
    expect(listed.allowedActions).not.toContain('deliver');
    expect(mixed.allowedActions).toEqual(expect.arrayContaining(['deliver', 'fulfill']));
    const part = await as(t.sales).post(`/api/v1/orders/${mixed.id}/fulfill`);
    expect([part.body.status, lineOf(part.body, rare).qtyOnOrder]).toEqual(['PART_DELIVERED', 2]);

    const po = await draftPo();
    await link(po.id, [{ orderLineId: Number(lineOf(mixed, rare).id), quantity: 2, unitCost: 8 }, { orderLineId: Number(lineOf(only, rare).id), quantity: 1 }]);
    const stock = await onHand(rare);
    const rest = await as(t.manager).post(`/api/v1/orders/${mixed.id}/cancel-rest`, { reason: 'Customer gave up', refundTo: 'original' });
    expect(rest.status, JSON.stringify(rest.body)).toBe(200);
    expect([rest.body.status, lineOf(rest.body, rare).qtyCancelled, lineOf(rest.body, rare).qtyOnOrder]).toEqual(['COMPLETED', 2, 0]);
    expect(await onHand(rare)).toBe(stock);
    const cancelled = await as(t.manager).post(`/api/v1/orders/${only.id}/cancel`, { reason: 'Not needed' });
    expect(cancelled.body.status).toBe('CANCELLED');
    const lines = await openLines();
    expect(lines.some((l) => [lineOf(mixed, rare).id, lineOf(only, rare).id].includes(l.orderLineId))).toBe(false);

    // Released, the copies arrive as ordinary stock.
    await submit(po.id);
    await receive(po.id, 3);
    expect(await onHand(rare)).toBe(stock + 3);
  });

  it('starts a purchase order from special-order lines alone, each copy counted once (screens 3a)', async () => {
    const order = await specialOrder(2);
    const line = Number(lineOf(order, rare).id);
    const res = await as(t.purchasor).post('/api/v1/purchase-orders', { supplierId, specialOrders: [{ orderLineId: line, quantity: 2, unitCost: 9 }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.lineItems.map((l: { bookId: number; quantity: number; unitCost: number }) => [l.bookId, l.quantity, l.unitCost])).toEqual([[rare, 2, 9]]);
    expect(res.body.totalAmount).toBe(18);
    expect((await openLines()).find((l) => l.orderLineId === String(line))).toMatchObject({ linked: 2, toOrder: 0 });
    const empty = await as(t.purchasor).post('/api/v1/purchase-orders', { supplierId });
    expect([empty.status, empty.body.error]).toEqual([400, 'VALIDATION_ERROR']);
    const over = await as(t.purchasor).post('/api/v1/purchase-orders', { supplierId, specialOrders: [{ orderLineId: line, quantity: 1, unitCost: 9 }] });
    expect(over.body.error).toBe('SPECIAL_ORDER_EXCEEDS_REMAINING');
  });
});
