/**
 * Non-Architectural Bug Sweep & Quick Fixes.
 *
 * Covers the concrete backend defects found and patched during the sweep:
 *   1. A non-numeric :id route param (e.g. GET /api/customers/abc) reached
 *      the DB as the literal string "NaN", which Postgres rejected as an
 *      unhandled error — surfacing as a raw 500 instead of a clean 400.
 *      Fixed via lib/http.ts's new paramInt() helper.
 *   2. Orders/POS/Exchanges accepted a zero/negative item quantity with no
 *      application-level check, relying entirely on the DB's
 *      CHECK (quantity > 0) constraint — an unhandled Postgres error, again
 *      surfacing as a raw 500 instead of a clean 400.
 *   3. A negative discountAmount/discountPct on Orders/POS was not clamped
 *      to zero, so it would INCREASE a line's total instead of discounting
 *      it (a real revenue-integrity bug, not just an error-shape issue).
 *   4. Exchanges validated a positive unitPrice for incoming (allowance)
 *      items but not outgoing (resale) items.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';
import { db } from '../db/index.js';

const STAFF_PREFIX = 'bugsweep_';
const BRANCH_PREFIX = 'BugSweep Test ';

async function getTestBook(): Promise<{ id: number; price: number }> {
  const result = await db.query(`SELECT id, default_price FROM books WHERE is_active = true AND default_price IS NOT NULL LIMIT 1`);
  if (!result.rows.length) throw new Error('No active books with price found');
  return { id: result.rows[0].id as number, price: parseFloat(result.rows[0].default_price as string) };
}

async function getOrCreateLocation(branchId: number): Promise<number> {
  const r = await db.query(`SELECT id FROM locations WHERE branch_id = $1 LIMIT 1`, [branchId]);
  if (r.rows.length) return r.rows[0].id as number;
  const c = await db.query(`INSERT INTO locations (branch_id, name, is_default_fulfillment) VALUES ($1, 'BugSweep Test Loc', true) RETURNING id`, [branchId]);
  return c.rows[0].id as number;
}

async function ensureInventory(bookId: number, locationId: number, qty = 50) {
  await db.query(
    `INSERT INTO inventory (book_id, location_id, quantity, reorder_point, version)
     VALUES ($1, $2, $3, 5, 0)
     ON CONFLICT (book_id, location_id) DO UPDATE SET quantity = $3, version = 0`,
    [bookId, locationId, qty],
  );
}

describe('Non-Architectural Bug Sweep — boundary validation & NaN-param guards', () => {
  let salesToken: string;
  let branchId: number;
  let locationId: number;
  let bookId: number;
  let bookPrice: number;

  beforeAll(async () => {
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);

    const branch = await createTestBranch({ name: 'BugSweep Test Branch' });
    branchId = branch.branchId;
    locationId = await getOrCreateLocation(branchId);

    const sales = await createTestStaff({ username: `${STAFF_PREFIX}sales`, role: 'Sales', branchId });
    salesToken = sales.token;

    const book = await getTestBook();
    bookId = book.id;
    bookPrice = book.price;
    await ensureInventory(bookId, locationId, 50);
  });

  afterAll(async () => {
    // cleanTestBranches() doesn't clean orders/POS transactions/exchanges
    // itself (documented caveat in testDb.ts) — clean up what these tests
    // created before it tries to delete the branch out from under them.
    await db.query(`DELETE FROM order_line_items WHERE order_id IN (SELECT id FROM orders WHERE branch_id = $1)`, [branchId]);
    await db.query(`DELETE FROM orders WHERE branch_id = $1`, [branchId]);
    await db.query(`DELETE FROM transaction_payments WHERE transaction_id IN (SELECT id FROM transactions WHERE branch_id = $1)`, [branchId]);
    await db.query(`DELETE FROM transaction_line_items WHERE transaction_id IN (SELECT id FROM transactions WHERE branch_id = $1)`, [branchId]);
    await db.query(`DELETE FROM transactions WHERE branch_id = $1`, [branchId]);
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  // ── 1. Non-numeric route params return a clean 400, not a 500 ─────────────

  it('1. GET /api/customers/:id with a non-numeric id returns 400 VALIDATION_ERROR, not 500', async () => {
    const res = await request(getTestApp())
      .get('/api/customers/not-a-number')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('1b. GET /api/orders/:id with a non-numeric id returns 400, not 500', async () => {
    const res = await request(getTestApp())
      .get('/api/orders/not-a-number')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  // ── 2. Zero/negative quantity returns a clean 400, not a 500 ──────────────

  it('2. POST /api/orders with quantity=0 returns 400, not a raw DB constraint 500', async () => {
    const res = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ items: [{ bookId, quantity: 0 }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('2b. POST /api/orders with a negative quantity returns 400, not a raw DB constraint 500', async () => {
    const res = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ items: [{ bookId, quantity: -3 }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('2c. POST /api/pos/transactions with a negative quantity returns 400, not a raw DB constraint 500', async () => {
    const res = await request(getTestApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        branchId, locationId,
        items: [{ bookId, quantity: -1 }],
        payments: [{ method: 'cash', amount: 10 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('2d. POST /api/exchanges with a negative outgoing quantity returns 400, not a raw DB constraint 500', async () => {
    const res = await request(getTestApp())
      .post('/api/exchanges')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        locationId,
        outgoingItems: [{ bookId, quantity: -2, unitPrice: 20 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  // ── 3. Negative discount no longer inflates the total ──────────────────────

  it('3. POST /api/orders with a negative discountAmount is clamped to 0, not subtracted as a negative', async () => {
    const res = await request(getTestApp())
      .post('/api/orders')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({ items: [{ bookId, quantity: 1, discountAmount: -50 }] });

    expect(res.status).toBe(201);
    // total must equal the plain unit price — NOT unitPrice + 50 (which a
    // negative "discount" would have produced pre-fix).
    expect(res.body.total).toBeCloseTo(bookPrice, 2);
  });

  it('3b. POST /api/pos/transactions with a negative discountPct is clamped to 0, not subtracted as a negative', async () => {
    const res = await request(getTestApp())
      .post('/api/pos/transactions')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        branchId, locationId,
        items: [{ bookId, quantity: 1, discountPct: -25 }],
        payments: [{ method: 'cash', amount: bookPrice }],
      });

    expect(res.status).toBe(201);
    expect(res.body.grandTotal).toBeCloseTo(bookPrice, 2);
  });

  // ── 4. Exchange outgoing (resale) unitPrice must be positive ──────────────

  it('4. POST /api/exchanges with a zero outgoing unitPrice returns 400', async () => {
    const res = await request(getTestApp())
      .post('/api/exchanges')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('X-Branch-Id', String(branchId))
      .send({
        locationId,
        outgoingItems: [{ bookId, quantity: 1, unitPrice: 0 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });
});
