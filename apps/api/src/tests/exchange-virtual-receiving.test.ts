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
import { getInventoryExportRowsV2, getSalesExportRows } from '../modules/reports/reports.service.js';
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
  await db.query(`DELETE FROM exchange_outgoing_items WHERE exchange_id IN (SELECT id FROM exchanges WHERE branch_id = $1)`, [branchId]).catch(() => {});
  await db.query(`DELETE FROM exchange_incoming_items WHERE exchange_id IN (SELECT id FROM exchanges WHERE branch_id = $1)`, [branchId]).catch(() => {});
  await db.query(`DELETE FROM exchanges WHERE branch_id = $1`, [branchId]);
}

describe('Non-Destructive Catalog Search & Virtual Receiving for Incoming Exchanges', () => {
  let salesToken: string;
  let stockClerkToken: string;
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

    const exportRows = await getSalesExportRows({ branchId });
    const orderRow = exportRows.find(r => r.order_reference === orderNumber);
    expect(orderRow).toBeDefined();
    // costBasis.ts fallback — a never-procured book's cost basis is the
    // Customer Allowance Value it was exchanged in for, not $0.
    expect(orderRow!.purchase_cost).toBeCloseTo(ALLOWANCE, 2);
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
