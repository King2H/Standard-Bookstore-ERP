// #236 (#225 O1, O5, P10; owner decisions 1a, 2a, 3a, 2026-11-04): an order
// and a sale are found by who bought them. The Orders list and Sales History
// carry the customer's name (Sales History also the cashier's), and one search
// finds them by number, customer name or code, or phone. A special-order line
// says how many copies are still to order and which purchase orders hold the
// rest. Before, neither list named the customer, and a line said "on order"
// before any purchase order existed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestBranches, cleanTestStaff } from './helpers/testDb.js';
import { createTestBranch, createTestStaff } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'ordlist_';
const BRANCH_PREFIX = 'Order Lists ';
const SUPPLIER = 'ORDLIST';
const PHONE = '+251911236236';

type Line = { id: string; bookId: number; qtyOnOrder: number; qtyToOrder: number; purchaseOrders: Array<{ poId: string; poNumber: string; quantity: number }> };

describe('Order lists name the customer (#236)', () => {
  let branchA: number;
  let branchB: number;
  let shelf: number;
  let rare: number;
  let stocked: number;
  let customerId: number;
  let customerCode: string;
  let supplierId: number;
  const t: Record<string, string> = {};
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  const as = (token: string, branch = branchA) => ({
    get: (path: string) => request(getTestApp()).get(path).set('Authorization', `Bearer ${token}`).set('X-Branch-Id', String(branch)),
    post: (path: string, body: object = {}) =>
      request(getTestApp()).post(path).set('Authorization', `Bearer ${token}`).set('X-Branch-Id', String(branch)).send(body),
  });
  const ok = async (res: request.Response, status = 200) => { expect(res.status, JSON.stringify(res.body)).toBe(status); return res.body; };
  const orderNumbers = async (q: string) =>
    (await ok(await as(t.sales).get(`/api/v1/orders?q=${encodeURIComponent(q)}&pageSize=100`))).items.map((o: { orderNumber: string }) => o.orderNumber);
  const saleNumbers = async (q: string) =>
    (await ok(await as(t.sales).get(`/api/v1/pos/transactions?q=${encodeURIComponent(q)}&pageSize=100`))).items.map((s: { transactionNumber: string }) => s.transactionNumber);

  async function cleanUp() {
    const branches = `SELECT id FROM branches WHERE name LIKE '${BRANCH_PREFIX}%'`;
    const orders = `SELECT id FROM orders WHERE branch_id IN (${branches})`;
    const pos = `SELECT id FROM purchase_orders WHERE supplier_id IN (SELECT id FROM suppliers WHERE name = '${SUPPLIER}')`;
    const tx = `SELECT id FROM transactions WHERE branch_id IN (${branches})`;
    const customers = `SELECT id FROM customers WHERE full_name = 'Almaz Order-Lists'`;
    for (const statement of [
      `DELETE FROM special_order_links WHERE po_id IN (${pos})`,
      `DELETE FROM order_payments WHERE order_id IN (${orders})`,
      `DELETE FROM financial_transactions WHERE receivable_id IN (SELECT id FROM receivables WHERE branch_id IN (${branches}))`,
      `DELETE FROM receivables WHERE branch_id IN (${branches})`,
      `DELETE FROM inventory_reservations WHERE order_id IN (${orders})`,
      `DELETE FROM cash_session_movements WHERE session_id IN (SELECT id FROM cash_sessions WHERE branch_id IN (${branches}))`,
      `DELETE FROM orders WHERE branch_id IN (${branches})`,
      `DELETE FROM transaction_payments WHERE transaction_id IN (${tx})`,
      `DELETE FROM transaction_line_items WHERE transaction_id IN (${tx})`,
      `DELETE FROM transactions WHERE branch_id IN (${branches})`,
      `DELETE FROM po_line_items WHERE po_id IN (${pos})`,
      `DELETE FROM purchase_orders WHERE id IN (${pos})`,
      `DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id IN (${branches}))`,
      `DELETE FROM suppliers WHERE name = '${SUPPLIER}'`,
      `DELETE FROM loyalty_accounts WHERE customer_id IN (${customers})`,
      `DELETE FROM store_credit_accounts WHERE customer_id IN (${customers})`,
      `DELETE FROM customers WHERE id IN (${customers})`,
    ]) {
      await db.query(statement).catch((err: { code?: string }) => { if (err.code !== '42P01' && err.code !== '42703') throw err; });
    }
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  }

  beforeAll(async () => {
    await cleanUp();
    branchA = (await createTestBranch({ name: `${BRANCH_PREFIX}A` })).branchId;
    branchB = (await createTestBranch({ name: `${BRANCH_PREFIX}B` })).branchId;
    shelf = (await one(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Lists shelf', true) RETURNING id`, [branchA])).id;
    await one(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Lists B shelf', true) RETURNING id`, [branchB]);
    for (const [name, role, branch] of [['sales', 'Sales', branchA], ['purchasor', 'Purchasor', branchA], ['salesB', 'Sales', branchB]] as const) {
      t[name] = (await createTestStaff({ username: `${STAFF_PREFIX}${name}`, role, branchId: branch })).token;
    }
    await db.query(`UPDATE staff SET full_name = 'Selam Cashier' WHERE username = $1`, [`${STAFF_PREFIX}sales`]);
    [rare, stocked] = (await db.query(`SELECT id FROM books WHERE is_active = true AND default_price > 0 ORDER BY id LIMIT 2`)).rows.map((r) => r.id as number);
    await db.query(`INSERT INTO inventory (book_id, location_id, quantity, average_cost) VALUES ($1, $2, 0, 0), ($3, $2, 20, 1)`, [rare, shelf, stocked]);
    const customer = await ok(await as(t.sales).post('/api/v1/customers', { fullName: 'Almaz Order-Lists', phone: PHONE }), 201);
    customerId = customer.id;
    customerCode = customer.customerCode;
    supplierId = (await one(`INSERT INTO suppliers (name, contact_info, lead_time_days, supplier_type) VALUES ($1, '{}', 7, 'external') RETURNING id`, [SUPPLIER])).id;
  });

  afterAll(cleanUp);

  describe('Orders (O1, 1a)', () => {
    let forCustomer: string;
    let walkIn: string;

    beforeAll(async () => {
      forCustomer = (await ok(await as(t.sales).post('/api/v1/orders', { locationId: shelf, customerId, items: [{ bookId: stocked, quantity: 1 }] }), 201)).orderNumber;
      walkIn = (await ok(await as(t.sales).post('/api/v1/orders', { locationId: shelf, items: [{ bookId: stocked, quantity: 1 }] }), 201)).orderNumber;
    });

    it("names each order's customer, none for a walk-in (was: no customer in the list)", async () => {
      const items = (await ok(await as(t.sales).get('/api/v1/orders?pageSize=100'))).items as Array<{ orderNumber: string; customerName: string | null }>;
      expect(items.find((o) => o.orderNumber === forCustomer)?.customerName).toBe('Almaz Order-Lists');
      expect(items.find((o) => o.orderNumber === walkIn)?.customerName).toBeNull();
    });

    it('finds orders by customer name in part, code, phone, or order number in part', async () => {
      expect(await orderNumbers('almaz')).toEqual([forCustomer]);
      expect(await orderNumbers(customerCode)).toEqual([forCustomer]);
      expect(await orderNumbers(PHONE)).toEqual([forCustomer]);
      expect(await orderNumbers(walkIn.slice(-6).toLowerCase())).toContain(walkIn);
      expect(await orderNumbers('nobody-by-this-name')).toEqual([]);
    });

    it("searches only the session branch's orders", async () => {
      const items = (await ok(await as(t.salesB, branchB).get('/api/v1/orders?q=almaz'))).items;
      expect(items).toEqual([]);
    });
  });

  describe('Special-order lines (O5, 2a)', () => {
    it('says "to order" until a purchase order holds the copies, then names it (was: "on order" with no purchase order)', async () => {
      const created = await ok(await as(t.sales).post('/api/v1/orders', {
        locationId: shelf, saleType: 'credit_sale', customerId, items: [{ bookId: rare, quantity: 3, specialOrder: true }],
      }), 201);
      const confirmed = await ok(await as(t.sales).post(`/api/v1/orders/${created.id}/confirm`, { dueDate: '2099-12-31' }));
      const lineOf = (order: { lineItems: Line[] }) => order.lineItems.find((l) => l.bookId === rare)!;
      expect(lineOf(confirmed)).toMatchObject({ qtyOnOrder: 3, qtyToOrder: 3, purchaseOrders: [] });

      const po = await ok(await as(t.purchasor).post('/api/v1/purchase-orders', {
        supplierId, specialOrders: [{ orderLineId: Number(lineOf(confirmed).id), quantity: 2, unitCost: 9 }],
      }), 201);
      const after = await ok(await as(t.sales).get(`/api/v1/orders/${created.id}`));
      expect(lineOf(after)).toMatchObject({ qtyOnOrder: 3, qtyToOrder: 1, purchaseOrders: [{ poId: String(po.id), poNumber: po.poNumber, quantity: 2 }] });
    });
  });

  describe('Sales History (P10, 3a)', () => {
    let sale: string;
    let walkInSale: string;

    beforeAll(async () => {
      const sell = async (body: object) => (await ok(await as(t.sales).post('/api/v1/pos/transactions', {
        locationId: shelf, items: [{ bookId: stocked, quantity: 1 }], payments: [{ method: 'mobile', amount: 1000, reference: 'TB-236' }], ...body,
      }), 201)).transactionNumber as string;
      const price = Number((await one(`SELECT default_price FROM books WHERE id = $1`, [stocked])).default_price);
      const payments = [{ method: 'mobile', amount: price, reference: 'TB-236' }];
      sale = await sell({ customerId, payments });
      walkInSale = await sell({ payments });
    });

    it('names the customer and the cashier of each sale (was: neither)', async () => {
      const items = (await ok(await as(t.sales).get('/api/v1/pos/transactions?pageSize=100'))).items as Array<Record<string, unknown>>;
      expect(items.find((s) => s.transactionNumber === sale)).toMatchObject({ customerName: 'Almaz Order-Lists', cashierName: 'Selam Cashier' });
      expect(items.find((s) => s.transactionNumber === walkInSale)).toMatchObject({ customerName: null, cashierName: 'Selam Cashier' });
    });

    it('finds sales by customer name, code, phone, or sale number in part', async () => {
      expect(await saleNumbers('ALMAZ')).toEqual([sale]);
      expect(await saleNumbers(customerCode)).toEqual([sale]);
      expect(await saleNumbers(PHONE)).toEqual([sale]);
      expect(await saleNumbers(walkInSale.slice(-6))).toContain(walkInSale);
    });
  });
});
