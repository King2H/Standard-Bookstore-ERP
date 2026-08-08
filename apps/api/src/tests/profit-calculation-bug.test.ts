/**
 * Bug Condition Exploration Tests -- Bug 2: Profit Calculation
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5
 *
 * CRITICAL: These tests are EXPECTED TO FAIL on unfixed code.
 * Failure confirms the bug exists. DO NOT attempt to fix the code when tests fail.
 *
 * Bug conditions under test:
 *
 *   B2-1 -- getKpis() monthlySales includes CONFIRMED (unfulfilled) orders.
 *           The query is: SUM(total) WHERE status NOT IN ('Cancelled','CANCELLED')
 *           This includes 'CONFIRMED', 'DRAFT', 'PAID', etc. — unfulfilled orders
 *           count as revenue. Expected: only FULFILLED/COMPLETED orders count.
 *           (Bug condition: includesUnfulfilledOrders)
 *
 *   B2-2 -- getSalesReport() totalSales does NOT deduct discount_total from fulfilled
 *           orders. A Merchant Discount of 100 ETB on Order B is silently ignored.
 *           The gross total appears as net profit.
 *           (Bug condition: ignoresAllDiscountTypes)
 *
 *   B2-3 -- getKpis() monthlySales and getSalesReport() summary.totalSales use
 *           different query logic for the same dataset, producing inconsistent views.
 *           The KPI includes exchange values; the sales report does not. Neither
 *           returns true net profit (neither subtracts discount_total).
 *           (Bug condition: calculationDiffersFromKpis)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';
import { cleanTestStaff, cleanTestBranches } from './helpers/testDb.js';
import { createTestStaff, createTestBranch } from './helpers/seed.js';
import { db } from '../db/index.js';

// ---- Constants ---------------------------------------------------------------

const STAFF_PREFIX = 'profit_bug_';
const BRANCH_PREFIX = 'ProfitBug Test ';
const ORDER_PREFIX = 'BUG2TEST-';

// Seeded order values (all created today so they appear in daily/monthly KPIs)
const ORDER_A_TOTAL = 500.00;     // CONFIRMED, not fulfilled — unfulfilled credit order
const ORDER_B_TOTAL = 400.00;     // FULFILLED, has discount_total=100 (Merchant discount)
const ORDER_B_DISCOUNT = 100.00;  // Merchant discount on Order B
const ORDER_C_TOTAL = 300.00;     // FULFILLED, no discount

// Totals for assertions
const FULFILLED_GROSS_TOTAL = ORDER_B_TOTAL + ORDER_C_TOTAL;   // 700 (only fulfilled orders)
const ALL_ORDERS_GROSS_TOTAL = ORDER_A_TOTAL + ORDER_B_TOTAL + ORDER_C_TOTAL; // 1200 (all non-cancelled)
const FULFILLED_NET_OF_DISCOUNTS = FULFILLED_GROSS_TOTAL - ORDER_B_DISCOUNT; // 600 (correct net)

// ---- Shared state ------------------------------------------------------------

let adminToken: string;
let testBranchId: number;
let testCustomerId: number;
let testStaffId: number;

// ---- Cleanup helpers ---------------------------------------------------------

async function cleanBugTestOrders(): Promise<void> {
  await db.query(
    `DELETE FROM orders WHERE order_number LIKE $1`,
    [`${ORDER_PREFIX}%`],
  );
}

async function cleanBugTestCustomers(): Promise<void> {
  await db.query(
    `DELETE FROM customers WHERE customer_code LIKE 'BUG2CUS%'`,
  );
}

// ---- Test suite --------------------------------------------------------------

describe('Bug 2 -- Profit Calculation Bug Condition Exploration', () => {
  beforeAll(async () => {
    // Clean up any leftover test data from previous runs
    await cleanBugTestOrders();
    await cleanBugTestCustomers();
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);

    // Create branch and admin staff
    const branch = await createTestBranch({ name: 'ProfitBug Test Branch' });
    testBranchId = branch.branchId;

    const admin = await createTestStaff({
      username: 'profit_bug_admin',
      role: 'Admin',
      branchId: testBranchId,
    });
    adminToken = admin.token;
    testStaffId = admin.staffId;

    // Create a test customer associated with the test branch
    const custRes = await db.query(
      `INSERT INTO customers (branch_id, customer_code, full_name, phone, is_active, created_at)
       VALUES ($1, 'BUG2CUS-001', 'Bug2 Test Customer', '555-9999', true, now())
       ON CONFLICT (customer_code) DO UPDATE SET branch_id = EXCLUDED.branch_id
       RETURNING id`,
      [testBranchId],
    );
    testCustomerId = custRes.rows[0].id as number;

    // ---- Seed test orders directly into the DB --------------------------------

    // Order A: CONFIRMED (unfulfilled), total=500, discount_total=0
    // Represents an unpaid credit order that should NOT count as revenue.
    await db.query(
      `INSERT INTO orders (
         order_number, customer_id, branch_id, status, sale_type,
         total, subtotal, discount_amount, discount_total, tax_amount,
         payment_status, created_by, created_at, updated_at
       ) VALUES ($1, $2, $3, 'CONFIRMED', 'credit_sale',
         500.00, 500.00, 0.00, 0.00, 0.00,
         'unpaid', $4, now(), now())
       ON CONFLICT (order_number) DO NOTHING`,
      [`${ORDER_PREFIX}A`, testCustomerId, testBranchId, testStaffId],
    );

    // Order B: FULFILLED, total=400, discount_total=100 (Merchant discount)
    // The discount is NOT deducted from profit on unfixed code.
    await db.query(
      `INSERT INTO orders (
         order_number, customer_id, branch_id, status, sale_type,
         total, subtotal, discount_amount, discount_total, tax_amount,
         payment_status, created_by, created_at, updated_at
       ) VALUES ($1, $2, $3, 'FULFILLED', 'cash_sale',
         400.00, 500.00, 100.00, 100.00, 0.00,
         'paid', $4, now(), now())
       ON CONFLICT (order_number) DO NOTHING`,
      [`${ORDER_PREFIX}B`, testCustomerId, testBranchId, testStaffId],
    );

    // Order C: FULFILLED, total=300, discount_total=0
    // Simple fulfilled order with no discount — used for purchase cost test baseline.
    await db.query(
      `INSERT INTO orders (
         order_number, customer_id, branch_id, status, sale_type,
         total, subtotal, discount_amount, discount_total, tax_amount,
         payment_status, created_by, created_at, updated_at
       ) VALUES ($1, $2, $3, 'FULFILLED', 'cash_sale',
         300.00, 300.00, 0.00, 0.00, 0.00,
         'paid', $4, now(), now())
       ON CONFLICT (order_number) DO NOTHING`,
      [`${ORDER_PREFIX}C`, testCustomerId, testBranchId, testStaffId],
    );
  });

  afterAll(async () => {
    await cleanBugTestOrders();
    await cleanBugTestCustomers();
    await cleanTestStaff(STAFF_PREFIX);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  // ---- Sanity: test data is present -----------------------------------------

  it('Sanity -- all three test orders exist in DB with correct statuses and totals', async () => {
    const res = await db.query(
      `SELECT order_number, status, total::NUMERIC, discount_total::NUMERIC
       FROM orders
       WHERE order_number LIKE $1
       ORDER BY order_number`,
      [`${ORDER_PREFIX}%`],
    );

    expect(res.rows).toHaveLength(3);

    const orderA = res.rows.find(r => r.order_number === `${ORDER_PREFIX}A`);
    const orderB = res.rows.find(r => r.order_number === `${ORDER_PREFIX}B`);
    const orderC = res.rows.find(r => r.order_number === `${ORDER_PREFIX}C`);

    expect(orderA).toBeDefined();
    expect(orderA.status).toBe('CONFIRMED');
    expect(parseFloat(orderA.total)).toBe(ORDER_A_TOTAL);

    expect(orderB).toBeDefined();
    expect(orderB.status).toBe('FULFILLED');
    expect(parseFloat(orderB.total)).toBe(ORDER_B_TOTAL);
    expect(parseFloat(orderB.discount_total)).toBe(ORDER_B_DISCOUNT);

    expect(orderC).toBeDefined();
    expect(orderC.status).toBe('FULFILLED');
    expect(parseFloat(orderC.total)).toBe(ORDER_C_TOTAL);
  });

  // ---- B2-1: KPI monthlySales includes CONFIRMED (unfulfilled) order ---------

  /**
   * B2-1 -- Bug condition: includesUnfulfilledOrders
   *
   * The getKpis() Monthly Orders Sales query is:
   *   SUM(total) WHERE date_trunc('month', created_at) = date_trunc('month', now())
   *     AND status NOT IN ('Cancelled','CANCELLED')
   *     AND branch_id = ?
   *
   * This includes CONFIRMED orders (Order A = 500 ETB).
   * Fixed code should only include FULFILLED/COMPLETED orders.
   *
   * Fulfilled orders total = 700. If Order A (CONFIRMED, 500) is included,
   * monthlySales >= 1200 for this branch.
   *
   * EXPECTED ON UNFIXED CODE:
   *   monthlySales > FULFILLED_GROSS_TOTAL (700) → PASSES (bug: 1200 > 700)
   *   FAIL on fixed code (fixed: 700 is NOT > 700)
   *
   * EXPECTED ON FIXED CODE:
   *   monthlySales == FULFILLED_GROSS_TOTAL (700)
   *   The assertion below FAILS (confirms bug is fixed — unfulfilled order excluded)
   */
  it('B2-1 -- GET /api/reports/kpis monthlySales includes CONFIRMED (unfulfilled) order total (FAILS on fixed code)', async () => {
    const app = getTestApp();

    const res = await request(app)
      .get(`/api/reports/kpis?branchId=${testBranchId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);

    const { monthlySales } = res.body as { monthlySales: number };

    // On UNFIXED code: monthlySales includes Order A (CONFIRMED, 500 ETB)
    // so it is >= 1200 for this branch. Assert > 700 (fulfilled-only total).
    // This assertion PASSES on unfixed code (bug confirmed: unfulfilled order counted).
    // This assertion FAILS on fixed code (fixed: only fulfilled orders counted).
    expect(monthlySales).toBeGreaterThan(FULFILLED_GROSS_TOTAL);
  });

  // ---- B2-2: getSalesReport totalSales does not deduct discount_total --------

  /**
   * B2-2 -- Bug condition: ignoresAllDiscountTypes
   *
   * The getSalesReport() summary query is:
   *   SUM(o.total) WHERE status NOT IN ('Cancelled','CANCELLED')
   *
   * Order B has discount_total=100 ETB (Merchant discount), but o.total=400 already
   * includes this discount pre-applied to the subtotal. However the query returns the
   * gross total without a separate accounting for discounts in the profit formula.
   *
   * On unfixed code: totalSales = sum of all non-cancelled totals (1200 for this branch).
   * The discount_total column is never queried — it exists but is completely ignored.
   * Fixed code should return: fulfilledRevenue - discount_total = 700 - 100 = 600.
   *
   * Assertion: totalSales == FULFILLED_GROSS_TOTAL (700) for fulfilled orders only,
   * OR totalSales is the gross including CONFIRMED (1200) — either way it should NOT
   * equal NET_OF_DISCOUNTS (600).
   *
   * EXPECTED ON UNFIXED CODE:
   *   summary.totalSales >= FULFILLED_GROSS_TOTAL (700) — gross total, discount ignored
   *   totalSales != FULFILLED_NET_OF_DISCOUNTS (600) → PASSES (bug confirmed)
   *   FAILS on fixed code (fixed returns 600 net profit)
   */
  it('B2-2 -- GET /api/reports/sales summary.totalSales does not deduct discount_total (FAILS on fixed code)', async () => {
    const app = getTestApp();

    const today = new Date().toISOString().slice(0, 10);

    const res = await request(app)
      .get(`/api/reports/sales?branchId=${testBranchId}&dateFrom=${today}&dateTo=${today}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);

    const { totalSales } = res.body.summary as { totalSales: number };

    // On UNFIXED code: totalSales >= 700 (fulfilled orders gross) or 1200 (all non-cancelled)
    // — discount_total is never deducted.
    // Confirm the gross total is present (includes Order B's 400 and Order C's 300 at minimum)
    expect(totalSales).toBeGreaterThanOrEqual(FULFILLED_GROSS_TOTAL);

    // The key bug assertion: totalSales should NOT equal the net-of-discounts value (600).
    // On UNFIXED code, this is true because discounts are ignored → total is 700 or 1200.
    // This assertion PASSES on unfixed code (bug confirmed: discount not deducted).
    // This assertion FAILS on fixed code (fixed returns 600 = 700 - 100).
    expect(totalSales).not.toBe(FULFILLED_NET_OF_DISCOUNTS);
  });

  // ---- B2-3: KPI monthlySales and getSalesReport totalSales are inconsistent --

  /**
   * B2-3 -- Bug condition: calculationDiffersFromKpis
   *
   * getKpis() monthlySales = order_sales + POS_sales + exchange_sales
   * getSalesReport() totalSales = order_sales ONLY (no POS, no exchanges)
   *
   * Both include CONFIRMED orders (bug condition). Additionally, neither deducts
   * discount_total or purchase cost. For the same branch and same dataset, they
   * return different numbers because they use different query scopes.
   *
   * Even for this test's isolated dataset (no POS, no exchanges), the KPI and
   * sales report might show different values if any other orders exist globally
   * for this branch on this day. But even if they happen to match, neither value
   * equals the correct net profit (fulfilledRevenue - discounts = 600).
   *
   * Primary assertion: Neither KPI monthlySales nor salesReport totalSales
   * equals the correct net profit (FULFILLED_NET_OF_DISCOUNTS = 600).
   * Both return gross totals that overstate profit.
   *
   * EXPECTED ON UNFIXED CODE:
   *   kpis.monthlySales != FULFILLED_NET_OF_DISCOUNTS (600) → PASSES
   *   salesReport.totalSales != FULFILLED_NET_OF_DISCOUNTS (600) → PASSES
   *   Both return gross, neither returns net profit (bug confirmed)
   *   FAILS on fixed code (fixed: both return net profit = 600)
   */
  it('B2-3 -- Neither getKpis monthlySales nor getSalesReport totalSales equals correct net profit (FAILS on fixed code)', async () => {
    const app = getTestApp();

    const today = new Date().toISOString().slice(0, 10);

    // Fetch KPIs for the test branch (monthlySales covers current month)
    const kpiRes = await request(app)
      .get(`/api/reports/kpis?branchId=${testBranchId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(kpiRes.status).toBe(200);

    // Fetch sales report for the test branch scoped to today
    const salesRes = await request(app)
      .get(`/api/reports/sales?branchId=${testBranchId}&dateFrom=${today}&dateTo=${today}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(salesRes.status).toBe(200);

    const kpiMonthlySales = kpiRes.body.monthlySales as number;
    const salesTotalSales = salesRes.body.summary.totalSales as number;

    // The correct net profit for fulfilled orders minus discounts is 600.
    // On UNFIXED code, both endpoints return gross totals (>= 700, or 1200 if
    // CONFIRMED included), so neither equals 600.
    //
    // These assertions PASS on unfixed code (confirms neither computes net profit).
    // They FAIL on fixed code (both return the correct net profit 600).
    expect(kpiMonthlySales).not.toBe(FULFILLED_NET_OF_DISCOUNTS);
    expect(salesTotalSales).not.toBe(FULFILLED_NET_OF_DISCOUNTS);

    // Additional: KPI includes CONFIRMED order (500 ETB) in monthly orders bucket.
    // Confirm the KPI monthly orders component includes the CONFIRMED order.
    const confirmedOrdersTotal = await db.query(
      `SELECT COALESCE(SUM(total), 0)::NUMERIC AS val
       FROM orders
       WHERE order_number LIKE $1
         AND status NOT IN ('Cancelled', 'CANCELLED')
         AND branch_id = $2`,
      [`${ORDER_PREFIX}%`, testBranchId],
    );
    const confirmedIncludedTotal = parseFloat(confirmedOrdersTotal.rows[0].val as string);

    // The KPI orders bucket for this branch includes ALL non-cancelled orders = 1200
    // (Order A=500 CONFIRMED + Order B=400 FULFILLED + Order C=300 FULFILLED)
    expect(confirmedIncludedTotal).toBe(ALL_ORDERS_GROSS_TOTAL);

    // The correct fulfilled-only total is 700, NOT 1200.
    // This confirms the CONFIRMED order is improperly counted.
    expect(confirmedIncludedTotal).toBeGreaterThan(FULFILLED_GROSS_TOTAL);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Bug 2 -- Profit Calculation Preservation (POS Revenue Must Remain Separate)
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Validates: Requirements 3.2
 *
 * These tests capture BASELINE behavior on UNFIXED code and MUST PASS before
 * the Bug 2 fix is applied.  They assert that:
 *
 *   1. POS `transactions.grand_total` is included in `getKpis()` monthlySales /
 *      dailySales (the POS component is alive and used).
 *   2. `getSalesReport()` keeps POS revenue in its own `totalPosSales` field
 *      and does NOT double-count it in the order-based `totalSales` field.
 *
 * If these tests still pass AFTER the fix is applied (task 6.5), the Bug 2
 * fix has not broken the POS revenue path (Requirement 3.2).
 *
 * EXPECTED ON BOTH UNFIXED AND FIXED CODE: Tests PASS.
 */

const BUG2_POS_PREFIX     = 'BUG2POS-';
const POS_GRAND_TOTAL     = 250.00;

let bug2PosAdminToken: string;
let bug2PosBranchId: number;
let bug2PosLocationId: number;
let bug2PosStaffId: number;

describe('Bug 2 -- Profit Calculation Preservation (POS Revenue Must Remain Separate)', () => {
  beforeAll(async () => {
    // Re-use the already-created ProfitBug Test Branch / admin from the first
    // describe block when possible — but the first describe's afterAll may have
    // already cleaned up.  Create fresh isolated resources to be safe.
    const branchRes = await db.query(
      `INSERT INTO branches (name, address, contact_info, operating_hours, is_active)
       VALUES ($1, $2, $3, $4, true)
       RETURNING id`,
      [
        'ProfitBug Test Branch POS',
        '1 POS Street',
        JSON.stringify({ phone: '555-1111' }),
        JSON.stringify({ mon: '09:00-18:00' }),
      ],
    );
    bug2PosBranchId = branchRes.rows[0].id as number;

    // Create a location for this branch (required FK on transactions)
    const locRes = await db.query(
      `INSERT INTO locations (branch_id, name, is_default_fulfillment)
       VALUES ($1, 'POS Main Floor', true)
       RETURNING id`,
      [bug2PosBranchId],
    );
    bug2PosLocationId = locRes.rows[0].id as number;

    // Create admin staff for the test branch
    const { createTestStaff: _cts } = await import('./helpers/seed.js');
    const admin = await _cts({
      username: 'profit_bug_pos_admin',
      role: 'Admin',
      branchId: bug2PosBranchId,
    });
    bug2PosAdminToken = admin.token;
    bug2PosStaffId    = admin.staffId;

    // Clean up any leftover POS transactions from a prior run
    await db.query(
      `DELETE FROM transactions WHERE transaction_number LIKE $1`,
      [`${BUG2_POS_PREFIX}%`],
    );

    // Seed a completed POS transaction directly into the `transactions` table.
    // This simulates a real POS cash sale that stockOut has already processed.
    // We insert at the DB level (not via the POS API) to isolate the preservation
    // property without touching inventory or requiring books to exist.
    await db.query(
      `INSERT INTO transactions
         (branch_id, location_id, customer_id, staff_id,
          transaction_number, subtotal, discount_total, tax_total, grand_total,
          currency, status, created_at)
       VALUES ($1, $2, NULL, $3,
               $4, $5, 0.00, 0.00, $6,
               'ETB', 'completed', now())
       ON CONFLICT (transaction_number) DO NOTHING`,
      [
        bug2PosBranchId,
        bug2PosLocationId,
        bug2PosStaffId,
        `${BUG2_POS_PREFIX}001`,
        POS_GRAND_TOTAL,
        POS_GRAND_TOTAL,
      ],
    );
  });

  afterAll(async () => {
    // Clean up POS test data
    await db.query(
      `DELETE FROM transactions WHERE transaction_number LIKE $1`,
      [`${BUG2_POS_PREFIX}%`],
    );

    // Remove the location, staff_branch_roles and branch created for this suite
    await db.query(`DELETE FROM staff_locations   WHERE location_id = $1`, [bug2PosLocationId]);
    await db.query(`DELETE FROM staff_branch_roles WHERE branch_id  = $1`, [bug2PosBranchId]);
    await db.query(`DELETE FROM locations         WHERE id          = $1`, [bug2PosLocationId]);
    await db.query(`DELETE FROM branches          WHERE id          = $1`, [bug2PosBranchId]);

    // Remove the staff member added for this suite
    await db.query(`DELETE FROM refresh_tokens WHERE staff_id = $1`, [bug2PosStaffId]);
    await db.query(`DELETE FROM staff          WHERE id       = $1`, [bug2PosStaffId]);
  });

  // ── Sanity: POS transaction is present in DB ────────────────────────────────

  it('Sanity -- seeded POS transaction exists in DB with status=completed and grand_total=250', async () => {
    const res = await db.query(
      `SELECT transaction_number, status, grand_total::NUMERIC
       FROM transactions
       WHERE transaction_number = $1`,
      [`${BUG2_POS_PREFIX}001`],
    );

    expect(res.rows).toHaveLength(1);
    const row = res.rows[0];
    expect(row.status).toBe('completed');
    expect(parseFloat(row.grand_total)).toBe(POS_GRAND_TOTAL);
  });

  // ── P-POS-1: KPI monthlySales includes POS grand_total ─────────────────────

  /**
   * P-POS-1 -- Preservation: POS grand_total is counted in getKpis() monthlySales
   *
   * getKpis() builds monthlySales as:
   *   monthlyOrdersSales + monthlyPosSales (SUM(grand_total) from transactions) + monthlyExchangesSales
   *
   * The POS component queries:
   *   SELECT SUM(grand_total) FROM transactions
   *   WHERE date_trunc('month', created_at) = date_trunc('month', now())
   *     AND status = 'completed'
   *     AND branch_id = ?
   *
   * Assertion: monthlySales >= POS_GRAND_TOTAL (250).
   * This PASSES on both unfixed and fixed code because the POS sales path is
   * separate from the order-based profit formula and must remain untouched.
   *
   * PASSES on UNFIXED code (baseline observation).
   * PASSES on FIXED code  (Requirement 3.2: POS component unchanged by Bug 2 fix).
   */
  it('P-POS-1 -- GET /api/reports/kpis monthlySales includes POS grand_total (PASSES on unfixed and fixed code)', async () => {
    const app = getTestApp();

    const res = await request(app)
      .get(`/api/reports/kpis?branchId=${bug2PosBranchId}`)
      .set('Authorization', `Bearer ${bug2PosAdminToken}`);

    expect(res.status).toBe(200);

    const { monthlySales, dailySales } = res.body as { monthlySales: number; dailySales: number };

    // POS grand_total=250 is in the current month → monthlySales must be >= 250
    expect(monthlySales).toBeGreaterThanOrEqual(POS_GRAND_TOTAL);

    // dailySales also includes the POS component (transaction created today)
    expect(dailySales).toBeGreaterThanOrEqual(POS_GRAND_TOTAL);
  });

  // ── P-POS-2: getSalesReport keeps POS in totalPosSales, not in totalSales ───

  /**
   * P-POS-2 -- Preservation: POS revenue lives in totalPosSales, not totalSales
   *
   * getSalesReport() queries:
   *   totalSales      = SUM(o.total)  from `orders`       (order path)
   *   totalPosSales   = SUM(t.grand_total) from `transactions` (POS path)
   *
   * These are separate fields.  POS transactions must NOT appear in totalSales.
   *
   * Assertions:
   *   summary.totalPosSales >= 250   (POS path is alive and populates this field)
   *   summary.totalSales    does NOT equal totalPosSales alone  (no double-counting)
   *      — specifically: if there are zero orders for this branch on this day,
   *        totalSales should be 0 while totalPosSales should be >= 250.
   *
   * PASSES on UNFIXED code (baseline observation).
   * PASSES on FIXED code  (Requirement 3.2: POS component not merged into order profit).
   */
  it('P-POS-2 -- GET /api/reports/sales totalPosSales >= 250 and totalSales does not double-count POS (PASSES on unfixed and fixed code)', async () => {
    const app = getTestApp();

    const today = new Date().toISOString().slice(0, 10);

    const res = await request(app)
      .get(`/api/reports/sales?branchId=${bug2PosBranchId}&dateFrom=${today}&dateTo=${today}`)
      .set('Authorization', `Bearer ${bug2PosAdminToken}`);

    expect(res.status).toBe(200);

    const summary = res.body.summary as {
      totalSales: number;
      totalPosSales: number;
      totalPosTransactions: number;
    };

    // POS path is alive: totalPosSales must reflect our seeded transaction (250 ETB)
    expect(summary.totalPosSales).toBeGreaterThanOrEqual(POS_GRAND_TOTAL);

    // At least one POS transaction must be counted
    expect(summary.totalPosTransactions).toBeGreaterThanOrEqual(1);

    // Double-counting guard: totalSales is sourced from `orders` table only.
    // This branch has NO orders seeded in this describe block, so totalSales
    // should be exactly 0 (no orders = 0 order-based sales).
    // If it were > 0, that would indicate POS data leaked into the order query.
    expect(summary.totalSales).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Bug 2 -- Fix Verification: New netProfit / fulfilledRevenue fields
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Validates: Requirements 2.5, 2.7, 2.8
 *
 * These tests verify that the Bug 2 fix is in place by asserting the NEW
 * fields added by `computeNetProfit()` return correct values for the
 * BUG2TEST- dataset.
 *
 * Dataset (same as the exploration tests above):
 *   Order A: CONFIRMED, total=500 ETB  → must be EXCLUDED from fulfilled revenue
 *   Order B: FULFILLED, total=400 ETB, discount_total=100 ETB
 *   Order C: FULFILLED, total=300 ETB, discount_total=0 ETB
 *
 * Expected fixed values:
 *   fulfilledRevenue  = 400 + 300 = 700  (only FULFILLED orders)
 *   totalDiscounts    = 100              (Order B merchant discount, reporting-only)
 *   netProfit         = 700              (revenue - cost - returns + exchange adj.)
 *
 * NOTE: netProfit does NOT subtract totalDiscounts. o.total (400 for Order B) is
 * already post-discount -- it's what the customer actually paid (subtotal 500 -
 * discount 100). totalDiscounts is a separate reporting field (shown on the KPI
 * card so staff can see how much was discounted) but subtracting it from revenue
 * that's already net-of-discount would double-count the discount and understate
 * profit. See lib/profit.service.ts computeNetProfit() for the full reasoning.
 * (This suite originally expected 700 - 100 = 600 before that reasoning was
 * worked out; the formula below reflects the current, correct calculation.)
 *
 * These tests have their OWN beforeAll/afterAll to seed and clean data
 * independently (the exploration suite above cleans up in its afterAll).
 *
 * EXPECTED ON FIXED CODE: Tests PASS.
 */

const FIX_VERIFY_ORDER_PREFIX = 'BUG2FIX-';

// Expected values for this dataset (no purchase costs, no returns, no exchanges)
const FIX_FULFILLED_REVENUE  = 700;   // Order B (400) + Order C (300)
const FIX_TOTAL_DISCOUNTS    = 100;   // Order B discount_total (reporting-only, not subtracted)
const FIX_NET_PROFIT         = 700;   // revenue is already post-discount; see note above

let fixAdminToken: string;
let fixBranchId: number;
let fixCustomerId: number;
let fixStaffId: number;

describe('Bug 2 -- Fix Verification: netProfit and fulfilledRevenue Fields', () => {
  beforeAll(async () => {
    // Clean up any leftovers from a previous run
    await db.query(`DELETE FROM orders WHERE order_number LIKE $1`, [`${FIX_VERIFY_ORDER_PREFIX}%`]);
    await db.query(`DELETE FROM customers WHERE customer_code LIKE 'BUG2FIX%'`);

    // Create dedicated branch for this suite
    const branchRes = await db.query(
      `INSERT INTO branches (name, address, contact_info, operating_hours, is_active)
       VALUES ($1, $2, $3, $4, true)
       RETURNING id`,
      [
        'ProfitFix Test Branch',
        '1 Fix Verification Street',
        JSON.stringify({ phone: '555-7777' }),
        JSON.stringify({ mon: '09:00-18:00' }),
      ],
    );
    fixBranchId = branchRes.rows[0].id as number;

    // Create admin staff
    const { createTestStaff: _cts } = await import('./helpers/seed.js');
    const admin = await _cts({
      username: 'profit_fix_admin',
      role: 'Admin',
      branchId: fixBranchId,
    });
    fixAdminToken = admin.token;
    fixStaffId    = admin.staffId;

    // Create a test customer
    const custRes = await db.query(
      `INSERT INTO customers (branch_id, customer_code, full_name, phone, is_active, created_at)
       VALUES ($1, 'BUG2FIX-001', 'Bug2 Fix Verification Customer', '555-8888', true, now())
       ON CONFLICT (customer_code) DO UPDATE SET branch_id = EXCLUDED.branch_id
       RETURNING id`,
      [fixBranchId],
    );
    fixCustomerId = custRes.rows[0].id as number;

    // Seed the same three orders as the exploration suite:

    // Order A: CONFIRMED (unfulfilled), total=500, discount_total=0 → must be excluded
    await db.query(
      `INSERT INTO orders (
         order_number, customer_id, branch_id, status, sale_type,
         total, subtotal, discount_amount, discount_total, tax_amount,
         payment_status, created_by, created_at, updated_at
       ) VALUES ($1, $2, $3, 'CONFIRMED', 'credit_sale',
         500.00, 500.00, 0.00, 0.00, 0.00,
         'unpaid', $4, now(), now())
       ON CONFLICT (order_number) DO NOTHING`,
      [`${FIX_VERIFY_ORDER_PREFIX}A`, fixCustomerId, fixBranchId, fixStaffId],
    );

    // Order B: FULFILLED, total=400, discount_total=100 (Merchant discount)
    await db.query(
      `INSERT INTO orders (
         order_number, customer_id, branch_id, status, sale_type,
         total, subtotal, discount_amount, discount_total, tax_amount,
         payment_status, created_by, created_at, updated_at
       ) VALUES ($1, $2, $3, 'FULFILLED', 'cash_sale',
         400.00, 500.00, 100.00, 100.00, 0.00,
         'paid', $4, now(), now())
       ON CONFLICT (order_number) DO NOTHING`,
      [`${FIX_VERIFY_ORDER_PREFIX}B`, fixCustomerId, fixBranchId, fixStaffId],
    );

    // Order C: FULFILLED, total=300, discount_total=0
    await db.query(
      `INSERT INTO orders (
         order_number, customer_id, branch_id, status, sale_type,
         total, subtotal, discount_amount, discount_total, tax_amount,
         payment_status, created_by, created_at, updated_at
       ) VALUES ($1, $2, $3, 'FULFILLED', 'cash_sale',
         300.00, 300.00, 0.00, 0.00, 0.00,
         'paid', $4, now(), now())
       ON CONFLICT (order_number) DO NOTHING`,
      [`${FIX_VERIFY_ORDER_PREFIX}C`, fixCustomerId, fixBranchId, fixStaffId],
    );
  });

  afterAll(async () => {
    await db.query(`DELETE FROM orders WHERE order_number LIKE $1`, [`${FIX_VERIFY_ORDER_PREFIX}%`]);
    await db.query(`DELETE FROM customers WHERE customer_code LIKE 'BUG2FIX%'`);
    await db.query(`DELETE FROM staff_locations   WHERE location_id IN (SELECT id FROM locations WHERE branch_id = $1)`, [fixBranchId]);
    await db.query(`DELETE FROM staff_branch_roles WHERE branch_id = $1`, [fixBranchId]);
    await db.query(`DELETE FROM locations WHERE branch_id = $1`, [fixBranchId]);
    await db.query(`DELETE FROM branches  WHERE id = $1`, [fixBranchId]);
    await db.query(`DELETE FROM refresh_tokens WHERE staff_id = $1`, [fixStaffId]);
    await db.query(`DELETE FROM staff     WHERE id = $1`, [fixStaffId]);
  });

  // ── Sanity: test data present ──────────────────────────────────────────────

  it('FIX-SANITY -- all three fix-verification orders exist with correct values', async () => {
    const res = await db.query(
      `SELECT order_number, status, total::NUMERIC, discount_total::NUMERIC
       FROM orders
       WHERE order_number LIKE $1
       ORDER BY order_number`,
      [`${FIX_VERIFY_ORDER_PREFIX}%`],
    );
    expect(res.rows).toHaveLength(3);

    const a = res.rows.find(r => r.order_number === `${FIX_VERIFY_ORDER_PREFIX}A`);
    const b = res.rows.find(r => r.order_number === `${FIX_VERIFY_ORDER_PREFIX}B`);
    const c = res.rows.find(r => r.order_number === `${FIX_VERIFY_ORDER_PREFIX}C`);

    expect(a?.status).toBe('CONFIRMED');
    expect(parseFloat(a?.total)).toBe(500);
    expect(b?.status).toBe('FULFILLED');
    expect(parseFloat(b?.total)).toBe(400);
    expect(parseFloat(b?.discount_total)).toBe(100);
    expect(c?.status).toBe('FULFILLED');
    expect(parseFloat(c?.total)).toBe(300);
  });

  // ── FV-1: kpis.netProfit is defined (new field is present in response) ──────

  /**
   * FV-1 -- Fix Verification: kpis.netProfit field is present and is a number
   *
   * Confirms the new field added by the Bug 2 fix is returned by the KPI endpoint.
   * On unfixed code this field would be undefined.
   */
  it('FV-1 -- GET /api/reports/kpis netProfit field is present and is a number (NOT undefined)', async () => {
    const app = getTestApp();

    const res = await request(app)
      .get(`/api/reports/kpis?branchId=${fixBranchId}`)
      .set('Authorization', `Bearer ${fixAdminToken}`);

    expect(res.status).toBe(200);

    const kpis = res.body as { netProfit: unknown };
    expect(kpis.netProfit).toBeDefined();
    expect(typeof kpis.netProfit).toBe('number');
  });

  // ── FV-2: kpis.netProfit equals correct net profit (700) ───────────────────

  /**
   * FV-2 -- Fix Verification: kpis.netProfit == 700 for the BUG2FIX- dataset
   *
   * fulfilledRevenue (700) - purchaseCost (0) - returns (0) + exchangeAdj (0) = 700.
   * totalDiscounts (100) is NOT subtracted -- order totals are already
   * post-discount, so doing so would double-count the discount (see the
   * describe-block comment above and lib/profit.service.ts for the full
   * reasoning). CONFIRMED order (500) must NOT be counted.
   */
  it('FV-2 -- GET /api/reports/kpis netProfit equals 700 (fulfilled revenue, cost/returns-adjusted, not double-discounted)', async () => {
    const app = getTestApp();

    const res = await request(app)
      .get(`/api/reports/kpis?branchId=${fixBranchId}`)
      .set('Authorization', `Bearer ${fixAdminToken}`);

    expect(res.status).toBe(200);

    const { netProfit } = res.body as { netProfit: number };
    expect(netProfit).toBe(FIX_NET_PROFIT);
  });

  // ── FV-3: kpis.fulfilledRevenue equals 700 ─────────────────────────────────

  /**
   * FV-3 -- Fix Verification: kpis.fulfilledRevenue == 700 (only FULFILLED orders)
   *
   * Order B (400) + Order C (300) = 700.  Order A (CONFIRMED, 500) is excluded.
   */
  it('FV-3 -- GET /api/reports/kpis fulfilledRevenue equals 700 (only FULFILLED orders)', async () => {
    const app = getTestApp();

    const res = await request(app)
      .get(`/api/reports/kpis?branchId=${fixBranchId}`)
      .set('Authorization', `Bearer ${fixAdminToken}`);

    expect(res.status).toBe(200);

    const { fulfilledRevenue } = res.body as { fulfilledRevenue: number };
    expect(fulfilledRevenue).toBe(FIX_FULFILLED_REVENUE);
  });

  // ── FV-4: kpis.totalDiscounts equals 100 ──────────────────────────────────

  /**
   * FV-4 -- Fix Verification: kpis.totalDiscounts == 100 (Order B Merchant discount)
   *
   * The discount_total from FULFILLED orders is now properly reported.
   */
  it('FV-4 -- GET /api/reports/kpis totalDiscounts equals 100 (Order B Merchant discount)', async () => {
    const app = getTestApp();

    const res = await request(app)
      .get(`/api/reports/kpis?branchId=${fixBranchId}`)
      .set('Authorization', `Bearer ${fixAdminToken}`);

    expect(res.status).toBe(200);

    const { totalDiscounts } = res.body as { totalDiscounts: number };
    expect(totalDiscounts).toBe(FIX_TOTAL_DISCOUNTS);
  });

  // ── FV-5: salesReport.summary.netProfit equals 700 ────────────────────────

  /**
   * FV-5 -- Fix Verification: salesReport.summary.netProfit == 700
   *
   * The sales report now uses computeNetProfit() and must return the same
   * net profit value as the KPI endpoint (consistency requirement). See FV-2
   * above for why totalDiscounts is not subtracted from fulfilledRevenue.
   */
  it('FV-5 -- GET /api/reports/sales summary.netProfit equals 700 (consistent with KPI)', async () => {
    const app = getTestApp();

    const today = new Date().toISOString().slice(0, 10);

    const res = await request(app)
      .get(`/api/reports/sales?branchId=${fixBranchId}&dateFrom=${today}&dateTo=${today}`)
      .set('Authorization', `Bearer ${fixAdminToken}`);

    expect(res.status).toBe(200);

    const { netProfit } = res.body.summary as { netProfit: number };
    expect(netProfit).toBe(FIX_NET_PROFIT);
  });

  // ── FV-6: salesReport.summary.fulfilledRevenue equals 700 ─────────────────

  /**
   * FV-6 -- Fix Verification: salesReport.summary.fulfilledRevenue == 700
   *
   * Only FULFILLED orders contribute to fulfilledRevenue.
   */
  it('FV-6 -- GET /api/reports/sales summary.fulfilledRevenue equals 700 (only FULFILLED orders)', async () => {
    const app = getTestApp();

    const today = new Date().toISOString().slice(0, 10);

    const res = await request(app)
      .get(`/api/reports/sales?branchId=${fixBranchId}&dateFrom=${today}&dateTo=${today}`)
      .set('Authorization', `Bearer ${fixAdminToken}`);

    expect(res.status).toBe(200);

    const { fulfilledRevenue } = res.body.summary as { fulfilledRevenue: number };
    expect(fulfilledRevenue).toBe(FIX_FULFILLED_REVENUE);
  });

  // ── FV-7: salesReport.summary.totalDiscounts equals 100 ───────────────────

  /**
   * FV-7 -- Fix Verification: salesReport.summary.totalDiscounts == 100
   *
   * The Merchant discount on Order B (100 ETB) is now visible in the report summary.
   */
  it('FV-7 -- GET /api/reports/sales summary.totalDiscounts equals 100 (Order B Merchant discount)', async () => {
    const app = getTestApp();

    const today = new Date().toISOString().slice(0, 10);

    const res = await request(app)
      .get(`/api/reports/sales?branchId=${fixBranchId}&dateFrom=${today}&dateTo=${today}`)
      .set('Authorization', `Bearer ${fixAdminToken}`);

    expect(res.status).toBe(200);

    const { totalDiscounts } = res.body.summary as { totalDiscounts: number };
    expect(totalDiscounts).toBe(FIX_TOTAL_DISCOUNTS);
  });
});
