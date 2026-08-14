/**
 * Non-Destructive Catalog Search & Virtual Receiving for Incoming Exchanges
 *
 * Covers:
 *  - POST /api/books/quick-register — lightweight catalog-only registration
 *    from the Exchange screen (metadata only, no inventory row).
 *  - Acquisition Allowance Capture / Valuation Integrity — incoming exchange
 *    items require a positive unitPrice (the Customer Allowance Value).
 *  - Virtual Exchange Receiving — createExchange()'s incoming stockIn() is
 *    tagged 'customer_exchange' and carries unit_cost = the allowance value.
 *  - costBasis.ts fallback — a book that's never been procured (no
 *    po_line_items) still gets a non-zero cost basis in profit/valuation
 *    reporting once it's been received via a customer exchange.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';
import { db } from '../db/index.js';
import { getInventoryExportRowsV2, getSalesReportRows } from '../modules/reports/reports.service.js';
import * as invTxSvc from '../modules/inventory/inventoryTransaction.service.js';

const STAFF_PREFIX = 'exc_vr_test_';
const BRANCH_PREFIX = 'Exchange VR Test ';

async function getOrCreateLocation(branchId: number): Promise<number> {
  const r = await db.query(`SELECT id FROM locations WHERE branch_id = $1 LIMIT 1`, [branchId]);
  if (r.rows.length) return r.rows[0].id as number;
  const c = await db.query(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'Exc VR Test Loc', true) RETURNING id`, [branchId]);
  return c.rows[0].id as number;
}

async function cleanExchanges(branchId: number) {
  await db.query(`DELETE FROM financial_transactions WHERE exchange_id IN (SELECT id FROM exchanges WHERE branch_id = $1)`, [branchId]).catch(() => {});
  await db.query(`DELETE FROM exchange_settlement_entries WHERE exchange_id IN (SELECT id FROM exchanges WHERE branch_id = $1)`, [branchId]).catch(() => {});
  await db.query(`DELETE FROM exchange_items WHERE exchange_id IN (SELECT id FROM exchanges WHERE branch_id = $1)`, [branchId]).catch(() => {});
  await db.query(`DELETE FROM exchange_outgoing_items WHERE exchange_id IN (SELECT id FROM exchanges WHERE branch_id = $1)`, [branchId]).catch(() => {});
  await db.query(`DELETE FROM exchange_incoming_items WHERE exchange_id IN (SELECT id FROM exchanges WHERE branch_id = $1)`, [branchId]).catch(() => {});
  await db.query(`DELETE FROM exchanges WHERE branch_id = $1`, [branchId]);
}

describe('Non-Destructive Catalog Search & Virtual Receiving for Incoming Exchanges', () => {
  let salesToken: string;
  let stockClerkToken: string;
  let managerToken: string;
  let branchId: number;
  let locationId: number;
  let customerId: number;
  const quickRegisteredBookIds: number[] = [];

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    const oldBranches = await db.query(`SELECT id FROM branches WHERE name LIKE $1`, [`${BRANCH_PREFIX}%`]);
    for (const row of oldBranches.rows) await cleanExchanges(row.id as number);
    await cleanTestBranches(BRANCH_PREFIX);

    const branch = await createTestBranch({ name: `${BRANCH_PREFIX}Branch` });
    branchId = branch.branchId;
    const sales = await createTestStaff({ username: `${STAFF_PREFIX}sales`, role: 'Sales', branchId });
    salesToken = sales.token;
    const clerk = await createTestStaff({ username: `${STAFF_PREFIX}clerk`, role: 'Stock_Clerk', branchId });
    stockClerkToken = clerk.token;
    // Manager — the initiate/review/approve/settle lifecycle (test 7c, the
    // 'damaged' condition path) requires APPROVE_EXCHANGE, which Sales lacks.
    const mgr = await createTestStaff({ username: `${STAFF_PREFIX}mgr`, role: 'Manager', branchId });
    managerToken = mgr.token;

    locationId = await getOrCreateLocation(branchId);

    const custRes = await db.query(
      `INSERT INTO customers (full_name, customer_code, is_active) VALUES ('Exc VR Test Customer', 'EXC-VR-001', true) RETURNING id`,
    );
    customerId = custRes.rows[0].id as number;
  });

  afterAll(async () => {
    await cleanExchanges(branchId);
    await db.query(`DELETE FROM order_payments WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`, [branchId]).catch(() => {});
    await db.query(`DELETE FROM order_line_items WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`, [branchId]).catch(() => {});
    await db.query(`DELETE FROM orders WHERE branch_id = $1`, [branchId]).catch(() => {});
    await db.query(`DELETE FROM store_credit_history WHERE customer_id = $1`, [customerId]).catch(() => {});
    await db.query(`DELETE FROM store_credit_accounts WHERE customer_id = $1`, [customerId]).catch(() => {});
    await db.query(`DELETE FROM customers WHERE id = $1`, [customerId]).catch(() => {});
    await db.query(`DELETE FROM inventory_history WHERE location_id IN (SELECT id FROM locations WHERE branch_id = $1)`, [branchId]);
    await db.query(`DELETE FROM inventory WHERE location_id IN (SELECT id FROM locations WHERE branch_id = $1)`, [branchId]);
    for (const bookId of quickRegisteredBookIds) {
      await db.query(`DELETE FROM book_authors WHERE book_id = $1`, [bookId]).catch(() => {});
      await db.query(`DELETE FROM books WHERE id = $1`, [bookId]).catch(() => {});
    }
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  // ── Quick Catalog Register ──────────────────────────────────────────────────

  it('1. Sales can quick-register a new catalog book (title only) — metadata only, no inventory row', async () => {
    const res = await request(getTestApp())
      .post('/api/books/quick-register')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ title: 'A Never-Procured Book' });

    expect(res.status).toBe(201);
    expect(res.body.title).toBe('A Never-Procured Book');
    expect(res.body.isActive).toBe(true);
    quickRegisteredBookIds.push(res.body.id);

    // Catalog metadata only — no inventory row created anywhere for it.
    const invRes = await db.query(`SELECT 1 FROM inventory WHERE book_id = $1`, [res.body.id]);
    expect(invRes.rows.length).toBe(0);
  });

  it('2. Quick-register accepts ISBN, Author, and Base List Price', async () => {
    const res = await request(getTestApp())
      .post('/api/books/quick-register')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ isbn: '9780306406157', title: 'Quick Add With Details', author: 'Jane Trader', defaultPrice: 25.5 });

    expect(res.status).toBe(201);
    expect(res.body.isbn).toBe('9780306406157');
    expect(res.body.authors).toContain('Jane Trader');
    expect(Number(res.body.defaultPrice)).toBeCloseTo(25.5, 2);
    quickRegisteredBookIds.push(res.body.id);
  });

  it('3. Quick-register without a title → 400 ValidationError', async () => {
    const res = await request(getTestApp())
      .post('/api/books/quick-register')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ isbn: '9780306406157' });

    expect(res.status).toBe(400);
  });

  it('4. A role without CREATE_SALE (Stock_Clerk) cannot quick-register → 403', async () => {
    const res = await request(getTestApp())
      .post('/api/books/quick-register')
      .set('Authorization', `Bearer ${stockClerkToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ title: 'Should Not Be Created' });

    expect(res.status).toBe(403);
  });

  // ── Acquisition Allowance Capture / Valuation Integrity ────────────────────

  it('5. Incoming exchange item with a zero allowance → 400 ValidationError; no inventory change', async () => {
    const regRes = await request(getTestApp())
      .post('/api/books/quick-register')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ title: 'Zero Allowance Book' });
    quickRegisteredBookIds.push(regRes.body.id);
    const bookId = regRes.body.id as number;

    const res = await request(getTestApp())
      .post('/api/exchanges')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, incomingItems: [{ bookId, quantity: 1, unitPrice: 0 }], outgoingItems: [] });

    expect(res.status).toBe(400);

    const invRes = await db.query(`SELECT 1 FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locationId]);
    expect(invRes.rows.length).toBe(0);
  });

  // ── Virtual Exchange Receiving ───────────────────────────────────────────────

  it('6. Exchanging in a never-procured book: catalog register → exchange in with an allowance → inventory increases with that unit cost, tagged customer_exchange', async () => {
    const regRes = await request(getTestApp())
      .post('/api/books/quick-register')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ title: 'Trade-In Novel', author: 'Some Author' });
    expect(regRes.status).toBe(201);
    quickRegisteredBookIds.push(regRes.body.id);
    const bookId = regRes.body.id as number;

    // Confirmed never procured — no po_line_items row exists for this brand-new book.
    const poCheck = await db.query(`SELECT 1 FROM po_line_items WHERE book_id = $1`, [bookId]);
    expect(poCheck.rows.length).toBe(0);

    const ALLOWANCE = 12.5;
    const res = await request(getTestApp())
      .post('/api/exchanges')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, customerId, incomingItems: [{ bookId, quantity: 3, unitPrice: ALLOWANCE }], outgoingItems: [] });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('Completed');

    // Inventory stock increases by incoming quantity.
    const invRes = await db.query(`SELECT quantity FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locationId]);
    expect(invRes.rows[0].quantity).toBe(3);

    // Assigned unit cost equal to the trade-in credit extended, tagged as a
    // 'customer_exchange' SOURCE (Virtual Exchange Receiving).
    const histRes = await db.query(
      `SELECT * FROM inventory_history WHERE book_id = $1 AND location_id = $2 AND reference_type = 'customer_exchange'`,
      [bookId, locationId],
    );
    expect(histRes.rows.length).toBe(1);
    expect(histRes.rows[0].delta).toBe(3);
    expect(parseFloat(histRes.rows[0].unit_cost as string)).toBeCloseTo(ALLOWANCE, 2);

    // ── costBasis.ts fallback: this book has never been procured, but the
    // Inventory Valuation export must still show a non-zero unit cost —
    // Valuation Integrity, tracked by COGS/Profit/Sales. Calls the report
    // service directly — the HTTP export endpoints return CSV and require
    // VIEW_REPORTS (Sales doesn't hold it), neither of which this assertion
    // needs to go through.
    const exportRows = await getInventoryExportRowsV2({ branchId });
    const exportRow = exportRows.find(r => r.title === 'Trade-In Novel');
    expect(exportRow).toBeDefined();
    expect(exportRow!.unit_cost).toBeCloseTo(ALLOWANCE, 2);
  });

  it('7. Reselling the never-procured book now carries a real purchase_cost in the Sales Export (never $0 for a never-procured book)', async () => {
    const regRes = await request(getTestApp())
      .post('/api/books/quick-register')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ title: 'Resold Trade-In Novel', defaultPrice: 40 });
    quickRegisteredBookIds.push(regRes.body.id);
    const bookId = regRes.body.id as number;

    const ALLOWANCE = 8;
    const excRes = await request(getTestApp())
      .post('/api/exchanges')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, customerId, incomingItems: [{ bookId, quantity: 5, unitPrice: ALLOWANCE }], outgoingItems: [] });
    expect(excRes.status).toBe(201);

    const orderRes = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, saleType: 'cash_sale', items: [{ bookId, quantity: 1 }] });
    expect(orderRes.status).toBe(201);
    const orderId = orderRes.body.id as string;
    const orderNumber = orderRes.body.orderNumber as string;

    const confirmRes = await request(getTestApp())
      .post(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ paymentMethod: 'cash' });
    expect(confirmRes.status).toBe(200);
    await request(getTestApp())
      .post(`/api/orders/${orderId}/fulfill`)
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId));

    const { rows: exportRows } = await getSalesReportRows({ branchId });
    const orderRow = exportRows.find(r => r.source === 'ORDER' && r.invoiceNo === orderNumber);
    expect(orderRow).toBeDefined();
    // costBasis.ts fallback — a never-procured book's cost basis is the
    // Customer Allowance Value it was exchanged in for, not $0. (qty is 1,
    // so costAmount === unit cost here.)
    expect(orderRow!.costAmount).toBeCloseTo(ALLOWANCE, 2);
  });

  it('7b. A trade-in book is not double-counted as a loss: the exchange leg nets to $0 profit, and the ENTIRE margin lands on the eventual resale (financialReport.service.ts / Unified engine, mapExchangeRow)', async () => {
    const regRes = await request(getTestApp())
      .post('/api/books/quick-register')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ title: 'Full-Lifecycle Trade-In Novel', defaultPrice: 25 });
    quickRegisteredBookIds.push(regRes.body.id);
    const bookId = regRes.body.id as number;

    const ALLOWANCE = 8;
    const RESALE_PRICE = 25;

    // Leg 1: pure buy-back — customer trades in the book for an $8 allowance,
    // takes nothing in return (no outgoingItems).
    const excRes = await request(getTestApp())
      .post('/api/exchanges')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, customerId, incomingItems: [{ bookId, quantity: 1, unitPrice: ALLOWANCE }], outgoingItems: [] });
    expect(excRes.status).toBe(201);

    // The trade-in leg alone must be profit-neutral: the allowance is a real
    // inventory purchase (capitalized as average_cost, asserted in test 6),
    // not an expense — so it must not also drag down reported profit here.
    const { rows: afterTradeIn } = await getSalesReportRows({ branchId });
    const exchangeRow = afterTradeIn.find(r => r.source === 'EXCHANGE' && r.book === 'Full-Lifecycle Trade-In Novel');
    expect(exchangeRow).toBeDefined();
    expect(exchangeRow!.netSalesAmount).toBeCloseTo(-ALLOWANCE, 2);
    expect(exchangeRow!.costAmount).toBeCloseTo(-ALLOWANCE, 2);   // signed to match netSalesAmount — see header comment
    expect(exchangeRow!.grossProfit).toBeCloseTo(0, 2);

    // Leg 2: the book is later resold at full price.
    const orderRes = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, saleType: 'cash_sale', items: [{ bookId, quantity: 1, unitPrice: RESALE_PRICE }] });
    expect(orderRes.status).toBe(201);
    const orderId = orderRes.body.id as string;
    const orderNumber = orderRes.body.orderNumber as string;
    await request(getTestApp())
      .post(`/api/orders/${orderId}/confirm`)
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ paymentMethod: 'cash' });
    await request(getTestApp())
      .post(`/api/orders/${orderId}/fulfill`)
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId));

    const { rows: afterResale } = await getSalesReportRows({ branchId });
    const orderRow = afterResale.find(r => r.source === 'ORDER' && r.invoiceNo === orderNumber);
    expect(orderRow).toBeDefined();
    expect(orderRow!.costAmount).toBeCloseTo(ALLOWANCE, 2);
    expect(orderRow!.grossProfit).toBeCloseTo(RESALE_PRICE - ALLOWANCE, 2);

    // Full lifecycle reconciliation — the ONLY assertion that would have
    // caught the double-counting bug: summing both legs' grossProfit must
    // equal the item's true economic profit (resale price − acquisition
    // cost), not that minus ALLOWANCE a second time.
    const exchangeRowAfter = afterResale.find(r => r.source === 'EXCHANGE' && r.book === 'Full-Lifecycle Trade-In Novel')!;
    const lifecycleProfit = exchangeRowAfter.grossProfit + orderRow!.grossProfit;
    expect(lifecycleProfit).toBeCloseTo(RESALE_PRICE - ALLOWANCE, 2);
  });

  it('7c. A DAMAGED trade-in has no future resale to defer to — its full allowance is a real loss recognized immediately', async () => {
    const regRes = await request(getTestApp())
      .post('/api/books/quick-register')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ title: 'Damaged Trade-In Novel' });
    quickRegisteredBookIds.push(regRes.body.id);
    const bookId = regRes.body.id as number;

    const ALLOWANCE = 6;
    // The initiate → review → approve → settle exchange_items lifecycle is
    // what supports a 'damaged' condition — Quick Exchange (used by tests
    // 6-7b) has no damaged concept, always resellable. Manager holds
    // APPROVE_EXCHANGE for the review/approve/settle steps.
    const initRes = await request(getTestApp())
      .post('/api/exchanges/initiate')
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ locationId, customerId, items: [{ bookId, quantity: 1, unitPrice: ALLOWANCE, type: 'returned', condition: 'damaged' }] });
    expect(initRes.status).toBe(201);
    const exchangeId = initRes.body.id as string;

    const reviewRes = await request(getTestApp())
      .post(`/api/exchanges/${exchangeId}/review`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));
    expect(reviewRes.status).toBe(200);

    const approveRes = await request(getTestApp())
      .post(`/api/exchanges/${exchangeId}/approve`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId));
    expect(approveRes.status).toBe(200);

    const settleRes = await request(getTestApp())
      .post(`/api/exchanges/${exchangeId}/settle`)
      .set('Authorization', `Bearer ${managerToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ entries: [{ entryType: 'cash_refund', amount: ALLOWANCE, method: 'cash' }], idempotencyKey: `test-7c-${exchangeId}` });
    expect(settleRes.status).toBe(200);

    // Damaged stock never enters sellable inventory / average_cost.
    const invRes = await db.query(`SELECT quantity, damaged_quantity FROM inventory WHERE book_id = $1 AND location_id = $2`, [bookId, locationId]);
    expect(invRes.rows[0]?.quantity ?? 0).toBe(0);
    expect(invRes.rows[0]?.damaged_quantity ?? 0).toBe(1);

    const { rows } = await getSalesReportRows({ branchId });
    const exchangeRow = rows.find(r => r.source === 'EXCHANGE' && r.book === 'Damaged Trade-In Novel');
    expect(exchangeRow).toBeDefined();
    expect(exchangeRow!.netSalesAmount).toBeCloseTo(-ALLOWANCE, 2);
    expect(exchangeRow!.costAmount).toBeCloseTo(0, 2);            // no future resale — costAmount stays 0
    expect(exchangeRow!.grossProfit).toBeCloseTo(-ALLOWANCE, 2);  // the full allowance is a real loss, recognized now
  });

  // ── invTxSvc.stockIn() unitCost — Valuation Integrity at the shared layer ──

  describe('invTxSvc.stockIn() unitCost', () => {
    it('8. rejects a zero/negative unitCost when explicitly provided', async () => {
      const regRes = await request(getTestApp())
        .post('/api/books/quick-register')
        .set('Authorization', `Bearer ${salesToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({ title: 'StockIn Unit Test Book' });
      quickRegisteredBookIds.push(regRes.body.id);
      const bookId = regRes.body.id as number;
      await db.query('INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version) VALUES ($1,$2,0,5,0) ON CONFLICT (book_id, location_id) DO NOTHING', [bookId, locationId]);

      await expect(invTxSvc.stockIn({
        bookId, locationId, quantity: 1, unitCost: 0,
        staffCtx: { staffId: 1, role: 'Admin', branchId },
      })).rejects.toThrow();

      await expect(invTxSvc.stockIn({
        bookId, locationId, quantity: 1, unitCost: -5,
        staffCtx: { staffId: 1, role: 'Admin', branchId },
      })).rejects.toThrow();
    });

    it('9. a stockIn() with no unitCost (the default for every other caller) still works and leaves unit_cost NULL', async () => {
      const regRes = await request(getTestApp())
        .post('/api/books/quick-register')
        .set('Authorization', `Bearer ${salesToken}`)
        .set('X-Branch-Id', String(branchId))
        .send({ title: 'StockIn No-Cost Test Book' });
      quickRegisteredBookIds.push(regRes.body.id);
      const bookId = regRes.body.id as number;
      await db.query('INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version) VALUES ($1,$2,0,5,0) ON CONFLICT (book_id, location_id) DO NOTHING', [bookId, locationId]);

      await invTxSvc.stockIn({
        bookId, locationId, quantity: 4, referenceType: 'manual',
        staffCtx: { staffId: 1, role: 'Admin', branchId },
      });

      const histRes = await db.query(
        `SELECT unit_cost FROM inventory_history WHERE book_id = $1 AND location_id = $2 AND reference_type = 'manual'`,
        [bookId, locationId],
      );
      expect(histRes.rows.length).toBe(1);
      expect(histRes.rows[0].unit_cost).toBeNull();
    });
  });
});
