/**
 * Inventory Valuation, Returns, Exchanges & Procurement Accounting
 * Standardization — automated tests.
 *
 * Verifies the six required scenarios plus the exact validation scenario
 * from the ticket:
 *   PO1: 10 @ 100 → Sell 8 → PO2: 10 @ 150
 *   Expected: sold 8 remain costed at 100; remaining stock before PO2 =
 *   2 @ 100; new average cost = 141.67; future sales use 141.67.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';
import { db } from '../db/index.js';
import { computeNetProfit } from '../lib/profit.service.js';

const STAFF_PREFIX = 'inv_val_test_';
const BRANCH_PREFIX = 'InvVal Test ';
const BOOK_PREFIX = 'InvVal Test Book ';

let adminToken: string;
let branchId: number;
let locationId: number;
let supplierId: number;
let customerId: number;
const createdBookIds: number[] = [];

async function createBook(title: string): Promise<number> {
  const res = await request(getTestApp())
    .post('/api/books')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ title, authors: ['Test Author'], defaultPrice: 20.0 });
  expect(res.status).toBe(201);
  const bookId = res.body.id as number;
  createdBookIds.push(bookId);
  return bookId;
}

async function createAndReceivePO(bookId: number, quantity: number, unitCost: number): Promise<void> {
  const createRes = await request(getTestApp())
    .post('/api/purchase-orders')
    .set('Authorization', `Bearer ${adminToken}`)
    .set('X-Branch-Id', String(branchId))
    .send({
      supplierId, branchId,
      notes: 'inv_val_test PO',
      lineItems: [{ bookId, quantity, unitCost }],
    });
  expect(createRes.status).toBe(201);
  const poId = createRes.body.id;
  const lineItemId = Number(createRes.body.lineItems[0].id);

  await request(getTestApp())
    .post(`/api/purchase-orders/${poId}/submit`)
    .set('Authorization', `Bearer ${adminToken}`)
    .set('X-Branch-Id', String(branchId));

  await request(getTestApp())
    .post(`/api/purchase-orders/${poId}/approve`)
    .set('Authorization', `Bearer ${adminToken}`)
    .set('X-Branch-Id', String(branchId));

  await request(getTestApp())
    .post(`/api/purchase-orders/${poId}/order`)
    .set('Authorization', `Bearer ${adminToken}`)
    .set('X-Branch-Id', String(branchId));

  const receiveRes = await request(getTestApp())
    .post(`/api/purchase-orders/${poId}/receive`)
    .set('Authorization', `Bearer ${adminToken}`)
    .set('X-Branch-Id', String(branchId))
    .send({ locationId, items: [{ poLineItemId: lineItemId, quantityReceived: quantity }] });
  expect(receiveRes.status).toBe(200);
}

async function sellUnits(bookId: number, quantity: number): Promise<{ txId: string; lineItemId: number }> {
  const priceRes = await db.query(`SELECT default_price FROM books WHERE id = $1`, [bookId]);
  const price = parseFloat(priceRes.rows[0].default_price as string);
  const amount = parseFloat((price * quantity).toFixed(2));
  const res = await request(getTestApp())
    .post('/api/pos/transactions')
    .set('Authorization', `Bearer ${adminToken}`)
    .set('X-Branch-Id', String(branchId))
    .send({
      branchId, locationId,
      items: [{ bookId, quantity }],
      payments: [{ method: 'cash', amount }],
    });
  expect(res.status).toBe(201);
  const txId = res.body.id as string;
  const liRes = await db.query(
    `SELECT id FROM transaction_line_items WHERE transaction_id = $1 AND book_id = $2`,
    [txId, bookId],
  );
  return { txId, lineItemId: liRes.rows[0].id as number };
}

async function getInventoryRow(bookId: number): Promise<{ quantity: number; averageCost: number }> {
  const res = await db.query(
    `SELECT quantity, average_cost FROM inventory WHERE book_id = $1 AND location_id = $2`,
    [bookId, locationId],
  );
  return { quantity: Number(res.rows[0].quantity), averageCost: Number(res.rows[0].average_cost) };
}

async function cleanTestData() {
  await db.query(`
    DELETE FROM financial_transactions WHERE exchange_id IN (
      SELECT id FROM exchanges WHERE branch_id IN (SELECT id FROM branches WHERE name LIKE $1)
    )
  `, [`${BRANCH_PREFIX}%`]).catch(() => {});
  await db.query(`DELETE FROM exchanges WHERE branch_id IN (SELECT id FROM branches WHERE name LIKE $1)`, [`${BRANCH_PREFIX}%`]).catch(() => {});
  await db.query(`
    DELETE FROM return_line_items WHERE return_id IN (
      SELECT r.id FROM returns r
      JOIN transactions t ON t.id = r.transaction_id
      WHERE t.branch_id IN (SELECT id FROM branches WHERE name LIKE $1)
    )
  `, [`${BRANCH_PREFIX}%`]).catch(() => {});
  await db.query(`
    DELETE FROM returns WHERE transaction_id IN (
      SELECT id FROM transactions WHERE branch_id IN (SELECT id FROM branches WHERE name LIKE $1)
    )
  `, [`${BRANCH_PREFIX}%`]).catch(() => {});
  await db.query(`
    DELETE FROM transaction_payments WHERE transaction_id IN (
      SELECT id FROM transactions WHERE branch_id IN (SELECT id FROM branches WHERE name LIKE $1)
    )
  `, [`${BRANCH_PREFIX}%`]).catch(() => {});
  await db.query(`
    DELETE FROM transaction_line_items WHERE transaction_id IN (
      SELECT id FROM transactions WHERE branch_id IN (SELECT id FROM branches WHERE name LIKE $1)
    )
  `, [`${BRANCH_PREFIX}%`]).catch(() => {});
  await db.query(`DELETE FROM transactions WHERE branch_id IN (SELECT id FROM branches WHERE name LIKE $1)`, [`${BRANCH_PREFIX}%`]).catch(() => {});
  await db.query(`
    DELETE FROM po_line_items WHERE po_id IN (SELECT id FROM purchase_orders WHERE branch_id IN (SELECT id FROM branches WHERE name LIKE $1))
  `, [`${BRANCH_PREFIX}%`]).catch(() => {});
  await db.query(`
    DELETE FROM po_receipt_items WHERE receipt_id IN (SELECT id FROM po_receipts WHERE po_id IN (SELECT id FROM purchase_orders WHERE branch_id IN (SELECT id FROM branches WHERE name LIKE $1)))
  `, [`${BRANCH_PREFIX}%`]).catch(() => {});
  await db.query(`
    DELETE FROM po_receipts WHERE po_id IN (SELECT id FROM purchase_orders WHERE branch_id IN (SELECT id FROM branches WHERE name LIKE $1))
  `, [`${BRANCH_PREFIX}%`]).catch(() => {});
  await db.query(`DELETE FROM purchase_orders WHERE branch_id IN (SELECT id FROM branches WHERE name LIKE $1)`, [`${BRANCH_PREFIX}%`]).catch(() => {});
  await db.query(`DELETE FROM inventory_history WHERE book_id = ANY($1)`, [createdBookIds]).catch(() => {});
  await db.query(`DELETE FROM inventory WHERE book_id = ANY($1)`, [createdBookIds]).catch(() => {});
  await db.query(`DELETE FROM books WHERE title LIKE $1`, [`${BOOK_PREFIX}%`]).catch(() => {});
  await db.query(`DELETE FROM suppliers WHERE name = 'InvVal Test Supplier'`).catch(() => {});
  await db.query(`
    DELETE FROM store_credit_history WHERE customer_id IN (
      SELECT id FROM customers WHERE customer_code = 'INVVAL-TEST-CUST'
    )
  `).catch(() => {});
  await db.query(`DELETE FROM customers WHERE customer_code = 'INVVAL-TEST-CUST'`).catch(() => {});
}

describe('Inventory Valuation, Returns, Exchanges & Procurement Accounting Standardization', () => {
  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);

    const branch = await createTestBranch({ name: `${BRANCH_PREFIX}Branch` });
    branchId = branch.branchId;
    const admin = await createTestStaff({ username: `${STAFF_PREFIX}admin`, role: 'Admin', branchId });
    adminToken = admin.token;

    const locRes = await db.query(
      `INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'InvVal Test Location', true) RETURNING id`,
      [branchId],
    );
    locationId = locRes.rows[0].id as number;

    await db.query(`DELETE FROM suppliers WHERE name = 'InvVal Test Supplier'`).catch(() => {});
    const supRes = await db.query(
      `INSERT INTO suppliers (name, contact_info, lead_time_days, supplier_type)
       VALUES ('InvVal Test Supplier', '{"phone":"555-INV"}', 5, 'external') RETURNING id`,
    );
    supplierId = supRes.rows[0].id as number;

    await db.query(`DELETE FROM customers WHERE customer_code = 'INVVAL-TEST-CUST'`).catch(() => {});
    const custRes = await db.query(
      `INSERT INTO customers (branch_id, customer_code, full_name) VALUES ($1, 'INVVAL-TEST-CUST', 'InvVal Test Customer') RETURNING id`,
      [branchId],
    );
    customerId = custRes.rows[0].id as number;
  });

  afterAll(async () => {
    await cleanTestData();
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  // ── Exact validation scenario from the ticket ──────────────────────────────
  it('Validation scenario: PO1 10@100 → sell 8 → PO2 10@150 → avg becomes 141.67, historical sale stays at 100', async () => {
    const bookId = await createBook(`${BOOK_PREFIX}Validation`);

    // PO1: 10 @ 100
    await createAndReceivePO(bookId, 10, 100);
    let inv = await getInventoryRow(bookId);
    expect(inv.quantity).toBe(10);
    expect(inv.averageCost).toBeCloseTo(100, 2);

    // Sell 8 — COGS posted at the current average (100), persisted on the line
    const sale1 = await sellUnits(bookId, 8);
    const sale1Cost = await db.query(`SELECT unit_cost FROM transaction_line_items WHERE id = $1`, [sale1.lineItemId]);
    expect(parseFloat(sale1Cost.rows[0].unit_cost as string)).toBeCloseTo(100, 2);

    // Remaining stock before PO2 = 2 @ 100
    inv = await getInventoryRow(bookId);
    expect(inv.quantity).toBe(2);
    expect(inv.averageCost).toBeCloseTo(100, 2); // stockOut never moves the average

    // PO2: 10 @ 150 → new average = (2*100 + 10*150) / 12 = 141.666...
    await createAndReceivePO(bookId, 10, 150);
    inv = await getInventoryRow(bookId);
    expect(inv.quantity).toBe(12);
    expect(inv.averageCost).toBeCloseTo(141.67, 2);

    // Future sale uses the new average (141.67), NOT the original sale's cost
    const sale2 = await sellUnits(bookId, 1);
    const sale2Cost = await db.query(`SELECT unit_cost FROM transaction_line_items WHERE id = $1`, [sale2.lineItemId]);
    expect(parseFloat(sale2Cost.rows[0].unit_cost as string)).toBeCloseTo(141.67, 2);

    // The FIRST sale's persisted cost is untouched by everything that happened since
    const sale1CostAfter = await db.query(`SELECT unit_cost FROM transaction_line_items WHERE id = $1`, [sale1.lineItemId]);
    expect(parseFloat(sale1CostAfter.rows[0].unit_cost as string)).toBeCloseTo(100, 2);
  });

  // ── 1. Multiple receipts with different prices ─────────────────────────────
  it('1. Multiple receipts at different prices blend into the correct weighted average', async () => {
    const bookId = await createBook(`${BOOK_PREFIX}MultiReceipt`);
    await createAndReceivePO(bookId, 5, 20); // 5 @ 20 = 100
    await createAndReceivePO(bookId, 5, 30); // +5 @ 30 = 150 → total 250 / 10 = 25
    const inv = await getInventoryRow(bookId);
    expect(inv.quantity).toBe(10);
    expect(inv.averageCost).toBeCloseTo(25, 2);
  });

  // ── 2. Sales before and after a price change ────────────────────────────────
  it('2. A sale made before a price change keeps its original cost after the price changes', async () => {
    const bookId = await createBook(`${BOOK_PREFIX}BeforeAfter`);
    await createAndReceivePO(bookId, 10, 50);
    const before = await sellUnits(bookId, 1);
    await createAndReceivePO(bookId, 10, 200); // big price jump
    const after = await sellUnits(bookId, 1);

    const beforeCost = await db.query(`SELECT unit_cost FROM transaction_line_items WHERE id = $1`, [before.lineItemId]);
    const afterCost = await db.query(`SELECT unit_cost FROM transaction_line_items WHERE id = $1`, [after.lineItemId]);
    expect(parseFloat(beforeCost.rows[0].unit_cost as string)).toBeCloseTo(50, 2);
    expect(parseFloat(afterCost.rows[0].unit_cost as string)).toBeGreaterThan(50); // moved with the new average
  });

  // ── 3. Return after a later higher-cost PO ──────────────────────────────────
  it('3. A return restores inventory and profit at the ORIGINAL cost, not a later higher-cost average', async () => {
    const bookId = await createBook(`${BOOK_PREFIX}ReturnHigherPO`);
    await createAndReceivePO(bookId, 10, 40);
    const sale = await sellUnits(bookId, 2); // posted at 40
    await createAndReceivePO(bookId, 10, 300); // average jumps way up

    const invBeforeReturn = await getInventoryRow(bookId);

    const returnRes = await request(getTestApp())
      .post('/api/returns')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        transactionId: parseInt(sale.txId, 10),
        refundMethod: 'cash',
        reason: 'inv_val_test return',
        lines: [{ transactionLineItemId: sale.lineItemId, quantity: 2 }],
      });
    expect(returnRes.status).toBe(201);

    // The stock-in this return caused was posted at the ORIGINAL cost (40),
    // not the current (much higher) average.
    const historyRes = await db.query(
      `SELECT unit_cost FROM inventory_history
       WHERE book_id = $1 AND reference_type = 'pos_return' ORDER BY id DESC LIMIT 1`,
      [bookId],
    );
    expect(parseFloat(historyRes.rows[0].unit_cost as string)).toBeCloseTo(40, 2);

    // Blending 2 units back in at 40 pulls the average DOWN from what it was
    // right before the return — proof the return didn't blend in at the
    // (much higher) current average instead.
    const invAfterReturn = await getInventoryRow(bookId);
    expect(invAfterReturn.averageCost).toBeLessThan(invBeforeReturn.averageCost);
  });

  // ── 4. Exchange receipt with custom valuation ───────────────────────────────
  it('4. An exchange incoming item posts at its assessed valuation and blends into the average', async () => {
    const bookId = await createBook(`${BOOK_PREFIX}ExchangeValuation`);
    await createAndReceivePO(bookId, 10, 20); // baseline average = 20

    const exchangeRes = await request(getTestApp())
      .post('/api/exchanges')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        branchId, locationId, customerId,
        incomingItems: [{ bookId, quantity: 5, unitPrice: 60 }], // assessed valuation, well above current average
        outgoingItems: [],
      });
    expect(exchangeRes.status).toBe(201);

    // New average = (10*20 + 5*60) / 15 = 33.33
    const inv = await getInventoryRow(bookId);
    expect(inv.quantity).toBe(15);
    expect(inv.averageCost).toBeCloseTo(33.33, 2);
  });

  // ── 5. Catalog selling-price change without inventory-cost change ──────────
  it('5. Changing a book\'s catalog selling price never changes its inventory cost', async () => {
    const bookId = await createBook(`${BOOK_PREFIX}CatalogPrice`);
    await createAndReceivePO(bookId, 10, 45);
    const invBefore = await getInventoryRow(bookId);

    const patchRes = await request(getTestApp())
      .put(`/api/books/${bookId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ defaultPrice: 999.99 });
    expect(patchRes.status).toBe(200);

    const invAfter = await getInventoryRow(bookId);
    expect(invAfter.averageCost).toBeCloseTo(invBefore.averageCost, 4);
    expect(invAfter.averageCost).toBeCloseTo(45, 2);
  });

  // ── 6. Historical gross profit unchanged after catalog price updates AND after new procurement ──
  it('6. Historical gross profit for an already-completed sale is unchanged by a later catalog price change or a later, differently-priced procurement', async () => {
    const bookId = await createBook(`${BOOK_PREFIX}HistoricalProfit`);
    await createAndReceivePO(bookId, 10, 60);
    await sellUnits(bookId, 1);

    const today = new Date().toISOString().slice(0, 10);
    const before = await computeNetProfit({ branchId, dateFrom: today, dateTo: today });

    // Catalog price change (selling price, not cost)
    await request(getTestApp())
      .put(`/api/books/${bookId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ defaultPrice: 5000 });

    // A brand new, much higher-cost procurement for the SAME book
    await createAndReceivePO(bookId, 10, 900);

    const after = await computeNetProfit({ branchId, dateFrom: today, dateTo: today });

    expect(after.netProfit).toBeCloseTo(before.netProfit, 2);
    expect(after.purchaseCost).toBeCloseTo(before.purchaseCost, 2);
  });
});
