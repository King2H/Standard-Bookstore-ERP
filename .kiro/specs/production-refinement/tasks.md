# Implementation Plan

## Overview

This task list addresses the six production bugs identified in `bugfix.md` and designed in `design.md`. Tasks are ordered by dependency: Bug 1 (shared catalog search infrastructure) → Bug 2 (shared profit module) → Bug 3 (orders.service.ts lifecycle) → Bug 4 (reset script) → Bug 5 (stability + integration tests that depend on Bugs 1–4) → Bug 6 (CSV builder utility). Each bug area follows the exploratory bugfix workflow: write tests before the fix, implement, then validate.

**Architecture constraint (hard):** `inventoryTransactions.service.ts` is the ONLY inventory mutation engine. No task may create a new inventory service or issue direct `UPDATE inventory SET quantity = ...` from any other module.

## Task Dependency Graph

```json
{
  "waves": [
    { "wave": 1, "tasks": ["1", "2"] },
    { "wave": 2, "tasks": ["3"] },
    { "wave": 3, "tasks": ["4", "5"] },
    { "wave": 4, "tasks": ["6"] },
    { "wave": 5, "tasks": ["7", "8"] },
    { "wave": 6, "tasks": ["9"] },
    { "wave": 7, "tasks": ["10", "11"] },
    { "wave": 8, "tasks": ["12"] },
    { "wave": 9, "tasks": ["13", "14"] },
    { "wave": 10, "tasks": ["15"] },
    { "wave": 11, "tasks": ["16", "17"] },
    { "wave": 12, "tasks": ["18"] },
    { "wave": 13, "tasks": ["19"] }
  ]
}
```

## Tasks

<!-- ═══════════════════════════════════════════════════════════════
     BUG 1 — UNIFIED CATALOG SEARCH
     Shared infrastructure that all other transactional modules depend on.
     Must be built first so downstream call-sites can reference it.
     ═══════════════════════════════════════════════════════════════ -->

## Bug 1 — Unified Catalog Search

- [x] 1. Write bug condition exploration test (Bug 1 — Catalog Search)
  - **Property 1: Bug Condition** - Search Returns Empty for Books Beyond Current Page
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior — it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the catalog search bug exists
  - **Scoped PBT Approach**: Scope the property to the concrete failing case: a book seeded at catalog row ≥ 26 (page 2+ at default page-size 25) AND a book searchable only by barcode or publisher name
  - Test that `GET /api/catalog?q=<isbn>&page=1` returns 0 results for a book on page 3 (from Bug Condition in design: `matchingBookPageNumber(input.q) > input.page`)
  - Test that `GET /api/catalog?q=<publisher>&page=1` returns 0 results because publisher is not in the WHERE predicate
  - Test that `GET /api/catalog?q=<barcode>&page=1` returns 0 results because barcode is not in the WHERE predicate
  - Run test on UNFIXED code — **EXPECTED OUTCOME**: Tests FAIL (confirms the bug exists)
  - Document counterexamples found (e.g., "book at row 52 not returned on page 1 search", "publisher name search always empty")
  - Mark task complete when test is written, run, and failures are documented
  - _Requirements: 1.1, 1.2, 1.3_


- [x] 2. Write preservation property tests (BEFORE implementing Bug 1 fix)
  - **Property 2: Preservation** - Existing Title/Author/ISBN/SKU Search Fields Still Work
  - **IMPORTANT**: Follow observation-first methodology
  - Observe: `GET /api/catalog?q=<title-fragment>&page=1` returns correct books on UNFIXED code
  - Observe: `GET /api/catalog?q=<author-name>&page=1` returns correct books on UNFIXED code
  - Observe: `GET /api/catalog?q=<isbn>&page=1` returns correct books that ARE on page 1
  - Write property-based test: for all search terms matching books on the current page, existing search returns those books (from Preservation Requirements 3.9 in design)
  - Verify test PASSES on UNFIXED code
  - Run tests on UNFIXED code — **EXPECTED OUTCOME**: Tests PASS (confirms baseline behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.9_

- [x] 3. Implement Bug 1 fix — Unified Catalog Search

  - [x] 3.1 Create `catalogSearch.service.ts` — shared full-catalog search function
    - Create new file `apps/api/src/modules/catalog/catalogSearch.service.ts`
    - Export `search(q: string, opts: { branchId?: number; limit?: number }): Promise<BookRecord[]>`
    - SQL: full catalog scan with NO OFFSET; LIMIT only; predicate covers all 6 fields
    - WHERE clause: `lower(b.title) LIKE`, `b.isbn LIKE`, `lower(b.sku) LIKE`, `lower(b.barcode) LIKE` (new), `lower(p.name) LIKE` via publishers join (new), author name via EXISTS subquery
    - Filter: `AND b.is_active = true`; default limit 50, max 200
    - Return same `BookRecord` shape as `catalog.service.ts` — no new shape needed
    - _Bug_Condition: `isBugCondition` where `matchingBookPageNumber(q) > page` OR `q MATCHES_ONLY_BY [barcode, publisher]`_
    - _Expected_Behavior: `catalogSearch(q)` returns all matching records regardless of page position_
    - _Preservation: Existing `searchBooks()` in `catalog.service.ts` is NOT modified (Requirement 3.9)_
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 3.2 Add `GET /api/catalog/search` route
    - Add route to `apps/api/src/modules/catalog/catalog.routes.ts`
    - Query params: `q` (required, min 2 chars), `limit` (optional, max 200), `branchId` (optional)
    - Returns `{ results: BookRecord[], total: number }`; HTTP 200 with `results: []` on no matches (never an error)
    - Validate `q.length >= 2`; return HTTP 400 if shorter
    - _Requirements: 2.1, 2.4a_

  - [x] 3.3 Update Procurement book picker to use shared search endpoint
    - Modify `apps/api/src/modules/procurement/procurement.routes.ts`
    - When `q` param is present and `q.length >= 2`, call `catalogSearchService.search()` instead of paginated list
    - When `q` is absent or short, fall back to existing paginated `searchBooks()` call
    - _Requirements: 2.4_

  - [x] 3.4 Update remaining transactional modules (Inventory/StockIn, Orders, Returns, Exchanges)
    - Apply the same consumer pattern to `inventory.routes.ts` (stock-in book lookup), `orders.routes.ts`, `returns.routes.ts`, `exchanges.routes.ts`
    - Pattern: `if (q && q.length >= 2) { results = await catalogSearchService.search(q, ...) } else { results = await catalogService.searchBooks(...) }`
    - _Requirements: 2.1, 2.3_

  - [x] 3.5 Verify catalog search exploration test now passes
    - **Property 1: Expected Behavior** - Catalog Search Returns Results Independent of Page Position
    - **IMPORTANT**: Re-run the SAME test from task 1 — do NOT write a new test
    - Run the exploration test from task 1 against FIXED code
    - **EXPECTED OUTCOME**: Test PASSES (confirms bug is fixed — books beyond page 1 and barcode/publisher searches now return results)
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 3.6 Verify preservation tests still pass (Bug 1)
    - **Property 2: Preservation** - Existing Title/Author/ISBN/SKU Search Fields Still Work
    - **IMPORTANT**: Re-run the SAME tests from task 2 — do NOT write new tests
    - Run preservation property tests from task 2 against FIXED code
    - **EXPECTED OUTCOME**: Tests PASS (existing search fields still return same results — no regressions in Requirement 3.9)


<!-- ═══════════════════════════════════════════════════════════════
     BUG 2 — REAL PROFIT CALCULATION
     Shared profit module used by dashboard KPIs and reports.
     Must be built before Bug 5 integration tests (T-5.4) that
     call computeNetProfit() directly.
     ═══════════════════════════════════════════════════════════════ -->

## Bug 2 — Real Profit Calculation

- [x] 4. Write bug condition exploration test (Bug 2 — Profit Calculation)
  - **Property 1: Bug Condition** - Dashboard KPI Counts Unfulfilled/Unpaid Credit Orders as Revenue
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **GOAL**: Surface counterexamples demonstrating profit overstatement
  - **Scoped PBT Approach**: Scope to concrete cases: (a) a CONFIRMED credit order with no payment, (b) an order with Merchant discount, (c) a book with procurement cost
  - Create a CONFIRMED (unfulfilled) credit order for 500 ETB with no payment; call `GET /api/reports/kpis`; assert `monthlySales` currently includes the 500 ETB (confirms bug: unfulfilled order counted as revenue)
  - Create an order with a Merchant Discount of 100 ETB; assert current KPI does NOT subtract it from profit (confirms ignoresAllDiscountTypes bug)
  - Create a PO receipt for a book at 200 ETB cost; create a fulfilled order for 500 ETB; assert current KPI shows 500 ETB as profit rather than 300 ETB (confirms ignoresPurchaseCost bug)
  - Assert `getSalesReport()` and `getKpis()` produce different profit totals for the same dataset (confirms calculationDiffersFromKpis bug)
  - Run tests on UNFIXED code — **EXPECTED OUTCOME**: Tests FAIL (confirms bugs exist)
  - Document counterexamples found
  - Mark task complete when tests are written, run, and failures are documented
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

- [x] 5. Write preservation property tests (BEFORE implementing Bug 2 fix)
  - **Property 2: Preservation** - POS Revenue Unaffected; POS Cash Transaction Atomicity Unchanged
  - **IMPORTANT**: Follow observation-first methodology
  - Observe: POS `grand_total` on `transactions` table is separate from order-based profit
  - Observe: POS cash transaction completes atomically with `stockOut()` call and `pos.sale_completed` outbox event on UNFIXED code
  - Write property-based test: for all POS cash transactions, the `transactions.grand_total` column is unchanged and not included in order-based `computeNetProfit()` scope (from Preservation Requirement 3.2 in design)
  - Verify test PASSES on UNFIXED code
  - Run tests on UNFIXED code — **EXPECTED OUTCOME**: Tests PASS
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.2_

- [ ] 6. Implement Bug 2 fix — Real Profit Calculation

  - [ ] 6.1 Create `profit.service.ts` — single source of truth for net profit formula
    - Create new file `apps/api/src/lib/profit.service.ts`
    - Export `computeNetProfit(opts: { branchId?: number; dateFrom?: string; dateTo?: string }): Promise<NetProfitResult>`
    - Step 1: `fulfilledRevenue` = SUM(o.total) WHERE `o.status IN ('FULFILLED','COMPLETED','Fulfilled','Completed')` + date/branch filters
    - Step 2: `purchaseCost` = SUM(pli.unit_cost × oli.quantity) via LEFT JOIN po_line_items on book_id for fulfilled orders
    - Step 3: `totalDiscounts` = SUM(o.discount_total) from fulfilled orders
    - Step 4: `returnsValue` = SUM(ri.unit_price × ri.quantity) from approved/completed returns linked to fulfilled orders
    - Step 5: `exchangeAdjustment` = SUM(cash_payment entries) − SUM(cash_refund entries) from completed exchanges
    - Step 6: `netProfit = fulfilledRevenue − purchaseCost − totalDiscounts − returnsValue + exchangeAdjustment`
    - Return full `NetProfitResult` with all breakdown fields: `netProfit`, `fulfilledRevenue`, `purchaseCost`, `totalDiscounts`, `returnsValue`, `exchangeAdjustment`, `cashSalesRevenue`, `creditSalesRevenue`, `collectedCreditRevenue`, `outstandingReceivables`
    - Credit orders contribute to revenue ONLY after receivable is Settled (outstanding_amount = 0)
    - _Bug_Condition: `isBugCondition` where `includesUnfulfilledOrders OR includesUnpaidCreditOrders OR ignoresPurchaseCost OR ignoresAllDiscountTypes OR calculationDiffersFromKpis`_
    - _Expected_Behavior: `computeNetProfit()` returns `fulfilledRevenue − purchaseCost − totalDiscounts − returnsValue ± exchangeAdjustment`_
    - _Preservation: POS revenue from `transactions` table is NOT included in this formula (Requirement 3.2)_
    - _Requirements: 2.5, 2.6, 2.7, 2.8, 2.9_

  - [x] 6.2 Update `getKpis()` in `reports.service.ts` to use `computeNetProfit()`
    - Replace ad-hoc `dailySales`/`monthlySales` aggregation with two calls to `computeNetProfit()` — one scoped to today, one scoped to current month
    - Update `KpiReport` interface: add `netProfit`, `fulfilledRevenue`, `outstandingReceivables` fields; deprecate misleading `dailySales`/`monthlySales` gross-sales fields
    - _Requirements: 2.5, 2.7_

  - [x] 6.3 Update `getSalesReport()` in `reports.service.ts` to use `computeNetProfit()`
    - Replace `summaryRes` SUM(o.total) query with a call to `computeNetProfit()`
    - Update `SalesReport.summary` interface: add `netProfit`, `purchaseCost`, `totalDiscounts` fields
    - Both KPIs and reports now use the same formula — inconsistency eliminated
    - _Requirements: 2.8_

  - [ ] 6.4 Verify profit calculation exploration test now passes
    - **Property 1: Expected Behavior** - Net Profit Uses Fulfilled-Only Revenue Minus All Cost Components
    - **IMPORTANT**: Re-run the SAME test from task 4 — do NOT write a new test
    - Run the exploration test from task 4 against FIXED code
    - **EXPECTED OUTCOME**: Test PASSES (unfulfilled credit order not counted; discounts deducted; purchase cost deducted; dashboard and reports match)
    - _Requirements: 2.5, 2.6, 2.7, 2.8, 2.9_

  - [x] 6.5 Verify preservation tests still pass (Bug 2)
    - **Property 2: Preservation** - POS Revenue Unaffected; POS Cash Transaction Atomicity Unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 5 — do NOT write new tests
    - Run preservation property tests from task 5 against FIXED code
    - **EXPECTED OUTCOME**: Tests PASS (POS transactions unaffected, Requirement 3.2 intact)


<!-- ═══════════════════════════════════════════════════════════════
     BUG 3 — STRICT ORDER LIFECYCLE
     Changes to orders.service.ts. Depends on invTxSvc (already
     exists). Bug 5 integration tests depend on this fix being in
     place (T-5.1, T-5.2, T-5.3).
     ═══════════════════════════════════════════════════════════════ -->

## Bug 3 — Strict Order Lifecycle

- [ ] 7. Write bug condition exploration test (Bug 3 — Order Lifecycle)
  - **Property 1: Bug Condition** - Order Lifecycle Violations (Four Distinct Cases)
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **GOAL**: Surface counterexamples for each lifecycle defect
  - **Scoped PBT Approach**: Scope each sub-condition to a concrete deterministic failing case
  - Case A — CASH confirm: Create a CASH DRAFT order; call `confirm()`; assert `payment_status` is NOT 'paid' after confirm (confirms atomic-payment-status-and-stockOut bug, requirement 3.1)
  - Case B — CREDIT fulfill gate: Create a CONFIRMED CREDIT order with `payment_status='unpaid'`; call `fulfill()`; assert HTTP 422/400 (confirms payment-status gate blocks valid credit flow, requirement 3.2)
  - Case C — Post-fulfillment payment: Create a FULFILLED CREDIT order; call `collectPayment()`; assert HTTP 422/400 (confirms post-fulfillment payment is rejected, requirement 3.3)
  - Case D — Cancel does not restore inventory: Create a CONFIRMED order; call `cancel()`; assert `inventory.quantity` is NOT restored (confirms inventory leak, requirement 3.4)
  - Run tests on UNFIXED code — **EXPECTED OUTCOME**: Tests FAIL (all four defects confirmed)
  - Document exact counterexamples and error responses observed
  - Mark task complete when tests are written, run, and failures are documented
  - _Requirements: 3.1, 3.2, 3.3, 3.4_

- [ ] 8. Write preservation property tests (BEFORE implementing Bug 3 fix)
  - **Property 2: Preservation** - DRAFT Order Unchanged; allowedActions for FULFILLED/CANCELLED; POS Inventory Path Untouched
  - **IMPORTANT**: Follow observation-first methodology
  - Observe: Creating a DRAFT order leaves `inventory.quantity` unchanged and writes no `inventory_history` rows (Requirement 3.3)
  - Observe: `computeOrderAllowedActions('FULFILLED', ...)` returns `['return']` on UNFIXED code (Requirement 3.6)
  - Observe: `computeOrderAllowedActions('CANCELLED', ...)` returns `[]` on UNFIXED code (Requirement 3.7)
  - Observe: POS `stockOut()` with `reference_type='sale'` and `pos.sale_completed` outbox event still works correctly (Requirement 3.2)
  - Write property-based test: for all non-DRAFT order status × saleType combinations that are NOT in the bug condition set, the allowed-actions computation matches the observed values
  - Verify tests PASS on UNFIXED code
  - Run tests on UNFIXED code — **EXPECTED OUTCOME**: Tests PASS
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.2, 3.3, 3.6, 3.7_

- [ ] 9. Implement Bug 3 fix — Strict Order Lifecycle

  - [ ] 9.1 Fix `confirm()` — atomic stockOut + correct payment_status
    - Modify `apps/api/src/modules/orders/orders.service.ts`
    - Remove reservation-only model; replace with `invTxSvc.stockOut()` call for each line item inside a single DB transaction
    - Call `invTxSvc.stockOut({ bookId, locationId, qty, referenceType: 'order_confirmed', referenceId: orderId, staffCtx }, client)` for each line item
    - Soft reservation record still created after stockOut (for compatibility with `fulfillReservation()`)
    - CASH path: SET `payment_status = 'paid'` in the same UPDATE within the transaction; no receivable created
    - CREDIT path: SET `payment_status = 'unpaid'`; promote receivable INSERT from savepoint to hard-fail (any receivable error rolls back full transaction)
    - Any step failure → full ROLLBACK — no savepoints that swallow errors in confirm()
    - **Architecture constraint**: route mutation exclusively through `invTxSvc.stockOut()` — no direct `UPDATE inventory SET quantity = ...`
    - _Bug_Condition: `NOT atomicPaymentStatusAndStockOut(orderId)` for CASH confirm_
    - _Expected_Behavior: single DB transaction sets payment_status='paid' (CASH) or creates receivable (CREDIT) and decrements inventory_
    - _Preservation: DRAFT creation leaves inventory unchanged (Requirement 3.3); POS stockOut path unchanged (Requirement 3.2)_
    - _Requirements: 2.10, 2.11, 3.4_

  - [ ] 9.2 Fix `fulfill()` — remove payment-status gate; allow CONFIRMED credit orders
    - Remove any `payment_status` or `paymentStatus` check that blocks `CREDIT` orders from fulfillment
    - Allow status IN ('CONFIRMED', 'PARTIALLY_PAID', 'PAID') — this is the only gate
    - `invTxSvc.fulfillReservation()` call is unchanged (already in place — writes audit history rows with delta=0, transitions reservations to 'deducted')
    - UPDATE `order_line_items SET qty_fulfilled = qty_reserved, qty_reserved = 0`
    - UPDATE `orders SET status = 'FULFILLED'`
    - `inventory.quantity` SHALL remain unchanged at this step — verify no second stockOut call
    - _Bug_Condition: `fulfill rejected when saleType='credit_sale' AND paymentStatus='unpaid'`_
    - _Expected_Behavior: fulfill succeeds for any CONFIRMED/PARTIALLY_PAID/PAID order regardless of payment_status_
    - _Requirements: 2.12, 3.2_

  - [ ] 9.3 Implement new `collectPayment()` function for credit orders
    - Add `collectPayment(orderId, paymentAmount, staffCtx)` to `orders.service.ts`
    - Validate: `status IN ('FULFILLED', 'COMPLETED')` AND `saleType = 'credit_sale'`
    - SELECT `outstanding_amount FROM receivables WHERE source_entity_id = orderId FOR UPDATE`
    - `newOutstanding = MAX(0, outstanding_amount - paymentAmount)`
    - UPDATE `receivables SET outstanding_amount = newOutstanding, status = CASE WHEN newOutstanding = 0 THEN 'Settled' ELSE 'PartiallyPaid' END`
    - UPDATE `orders SET payment_status = CASE WHEN newOutstanding = 0 THEN 'paid' ELSE 'partially_paid' END`
    - Add route `POST /api/orders/:id/collect-payment` in `orders.routes.ts`
    - _Bug_Condition: `collectPayment rejected when status IN ('FULFILLED','COMPLETED')`_
    - _Expected_Behavior: reduces outstanding_amount; sets payment_status correctly_
    - _Requirements: 2.13_

  - [ ] 9.4 Fix `cancel()` — atomic all-or-nothing inventory restoration
    - Remove the unreliable `stockWasDeducted` history check
    - Replace with: `hasDeductedStock = status IN ('CONFIRMED', 'PARTIALLY_PAID', 'PAID')` as the sole gate
    - BEGIN TRANSACTION (no savepoints that swallow errors)
    - IF hasDeductedStock: FOR each line item with qty_reserved > 0: `invTxSvc.stockIn(bookId, locationId, qty, 'order_cancelled', orderId, staffCtx)` — routes through `inventoryTransactions.service.ts`
    - UPDATE `inventory_reservations SET status='released' WHERE order_id = orderId AND status='reserved'`
    - IF open receivable exists: `updateReceivableOnPayment(..., newOutstandingAmount=0, isFullySettled=true)`
    - UPDATE `orders SET status='CANCELLED'`
    - COMMIT — any step failure → full ROLLBACK
    - Reject `FULFILLED`/`COMPLETED` cancel with HTTP 422 and error code `ORDER_ALREADY_FULFILLED` with message "Use the Return workflow"
    - _Bug_Condition: `cancel NOT IN ('FULFILLED','COMPLETED') does not restore inventory`_
    - _Expected_Behavior: all-or-nothing restore of inventory.quantity via stockIn_
    - _Requirements: 2.14, 2.15_

  - [ ] 9.5 Fix `computeOrderAllowedActions()` — correct state machine for all status × saleType
    - Remove payment-status gate on CONFIRMED — always return `['fulfill', 'cancel']` for CONFIRMED (both CASH and CREDIT)
    - Full state machine: `DRAFT` → `['confirm','cancel']`; `CONFIRMED` → `['fulfill','cancel']`; `PARTIALLY_PAID` → `['fulfill','cancel']`; `PAID` → `['fulfill']`; `FULFILLED` → `['collectPayment']` (credit with outstanding > 0) or `[]` (cash); `COMPLETED` → same as FULFILLED; `CANCELLED` → `[]`
    - Ensure `allowedActions` array is included in EVERY order lifecycle API response (confirm, fulfill, pay, cancel, collectPayment)
    - _Bug_Condition: `allowedActionsAbsentInResponse OR paymentGateBlocksConfirmedCreditFulfill`_
    - _Expected_Behavior: allowedActions present in all responses; matches state machine table_
    - _Requirements: 2.16, 3.6, 3.7_

  - [ ] 9.6 Verify order lifecycle exploration test now passes
    - **Property 1: Expected Behavior** - Order Confirm Atomically Deducts Stock; Credit Fulfill Not Blocked; Post-Fulfillment Payment Accepted; Cancel Restores Inventory
    - **IMPORTANT**: Re-run the SAME test from task 7 — do NOT write a new test
    - Run all four exploration cases from task 7 against FIXED code
    - **EXPECTED OUTCOME**: All four cases PASS
    - _Requirements: 2.10, 2.11, 2.12, 2.13, 2.14, 3.4_

  - [ ] 9.7 Verify preservation tests still pass (Bug 3)
    - **Property 2: Preservation** - DRAFT Order Unchanged; allowedActions for FULFILLED/CANCELLED; POS Inventory Path Untouched
    - **IMPORTANT**: Re-run the SAME tests from task 8 — do NOT write new tests
    - Run preservation property tests from task 8 against FIXED code
    - **EXPECTED OUTCOME**: Tests PASS (Requirement 3.2, 3.3, 3.6, 3.7 all intact)


<!-- ═══════════════════════════════════════════════════════════════
     BUG 4 — resetDemoData() SCRIPT
     Standalone maintenance script. Bug 5 integration test T-5.6
     tests this script, so it must exist before that test is written.
     ═══════════════════════════════════════════════════════════════ -->

## Bug 4 — resetDemoData() Script

- [ ] 10. Write bug condition exploration test (Bug 4 — Reset Script)
  - **Property 1: Bug Condition** - No Safe Reset Command Exists
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **GOAL**: Confirm the script does not exist and no safe reset path exists
  - **Scoped PBT Approach**: Deterministic — verify the file `apps/api/scripts/reset-demo-data.mjs` does NOT exist
  - Assert `scripts/reset-demo-data.mjs` does not exist (confirms `NOT hasSafeResetCommand` bug)
  - Assert `scripts/reseed.mjs` has no `--dry-run` flag (confirms `NOT hasDryRun` bug)
  - Assert `scripts/reseed.mjs` has no confirmation prompt before executing (confirms `NOT hasConfirmPrompt` bug)
  - Run test on UNFIXED code — **EXPECTED OUTCOME**: Test FAILS / assertions confirm bugs exist
  - Document findings
  - Mark task complete when test is written, run, and results documented
  - _Requirements: 4.1, 4.2, 4.3, 4.4_

- [ ] 11. Write preservation property tests (BEFORE implementing Bug 4 fix)
  - **Property 2: Preservation** - Seed Tables Remain Intact After Reset; Atomic Rollback on Failure
  - **IMPORTANT**: Follow observation-first methodology
  - Observe current state of `staff`, `books`, `authors`, `categories`, `publishers`, `branches`, `locations`, `system_config` tables — record row counts as baseline
  - Observe that `reseed.mjs` (existing script) does NOT delete these tables
  - Write property-based test: for all inputs to the reset script, tables in the TABLES_TO_PRESERVE allowlist have the same row count before and after execution (from Preservation Requirement 2.18 in design)
  - Verify test can be defined as a pre-condition even before the script exists
  - Run tests on UNFIXED code (baseline capture) — **EXPECTED OUTCOME**: Tests PASS (baseline captured)
  - Mark task complete when preservation baseline is recorded and tests are written
  - _Requirements: 2.18_

- [ ] 12. Implement Bug 4 fix — resetDemoData() Script

  - [ ] 12.1 Create `reset-demo-data.mjs` with dry-run mode
    - Create new file `apps/api/scripts/reset-demo-data.mjs`
    - Parse `--dry-run` flag from `process.argv`
    - STEP 1: For each table in TABLES_TO_DELETE, run `SELECT COUNT(*)` and print: `  <table>: N rows [would be deleted]`
    - STEP 2: Validate TABLES_TO_PRESERVE are not in deletion list; EXIT 1 with error if violated
    - IF `--dry-run`: print dry-run summary → EXIT 0 (zero writes)
    - Correct FK-dependency delete order: `exchange_items`, `exchanges`, `return_items`, `returns`, `transaction_payments`, `transaction_line_items`, `transactions`, `order_line_items`, `order_payments`, `payments`, `receivables`, `inventory_reservations`, `inventory_history`, `po_receipt_items`, `po_receipts`, `po_line_items`, `purchase_orders`, `customers`, `suppliers (non-seeded)`
    - Use correct schema table names: `transactions`/`transaction_line_items` (not `pos_transactions`); `purchase_orders`/`po_line_items` (not `procurement_orders`)
    - _Bug_Condition: `NOT hasSafeResetCommand OR NOT hasDryRun`_
    - _Expected_Behavior: `--dry-run` prints table/count preview; exits without any DELETE_
    - _Requirements: 2.17, 2.18, 2.19_

  - [ ] 12.2 Add confirmation prompt and atomic delete transaction
    - After dry-run check, print: `"The above N rows across M tables will be PERMANENTLY DELETED."`
    - Print: `"Preserved tables (staff, catalog, config) will NOT be touched."`
    - Print: `"Type YES to confirm deletion: "` and read input via `readline`
    - If input ≠ "YES": print `"Aborted."` → EXIT 0
    - BEGIN TRANSACTION: execute all DELETE statements in FK order; UPDATE inventory SET quantity=0 for opening-balance reset
    - COMMIT; on any error: ROLLBACK; print `"Reset failed. Database unchanged."`; EXIT 1
    - Print `"Reset complete. N rows deleted across M tables."` on success
    - Use `process.stdin.isTTY` check for non-interactive environments (test mode can inject auto-YES)
    - _Bug_Condition: `NOT hasConfirmPrompt OR NOT isAtomic OR NOT distinguishesTransactionalVsSeed`_
    - _Expected_Behavior: requires explicit "YES"; atomic rollback on any failure; seed tables untouched_
    - _Requirements: 2.17, 2.18, 2.20, 2.20a_

  - [ ] 12.3 Verify reset script exploration test now passes
    - **Property 1: Expected Behavior** - resetDemoData Dry-Run Previews and Atomic Delete Preserves Seed
    - **IMPORTANT**: Re-run the SAME test from task 10 — do NOT write a new test
    - Run the exploration test from task 10 against FIXED code (script now exists)
    - **EXPECTED OUTCOME**: Test PASSES (script exists; `--dry-run` works; confirmation prompt present)
    - _Requirements: 2.17, 2.18, 2.19, 2.20_

  - [ ] 12.4 Verify preservation tests still pass (Bug 4)
    - **Property 2: Preservation** - Seed Tables Remain Intact After Reset; Atomic Rollback on Failure
    - **IMPORTANT**: Re-run the SAME tests from task 11 — do NOT write new tests
    - Run `reset-demo-data.mjs --dry-run` and then run confirmed reset; assert seed table row counts unchanged
    - **EXPECTED OUTCOME**: Tests PASS (staff, books, authors, categories, publishers, branches all intact)


<!-- ═══════════════════════════════════════════════════════════════
     BUG 5 — STABILITY
     Retry logic + reconciliation script verification + integration
     tests for all six scenarios (T-5.1 through T-5.6). Depends on
     Bug 1 (T-5.5), Bug 2 (T-5.4), Bug 3 (T-5.1, T-5.2, T-5.3),
     Bug 4 (T-5.6) being implemented first.
     ═══════════════════════════════════════════════════════════════ -->

## Bug 5 — Stability

- [ ] 13. Write bug condition exploration test (Bug 5 — Stability)
  - **Property 1: Bug Condition** - Inventory Route Has No Retry; Reconciliation Status List Incomplete; Integration Tests Missing
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bugs exist
  - **DO NOT attempt to fix the test or the code when it fails**
  - **GOAL**: Confirm retry wrapper absent, reconciliation gap exists, and integration tests are missing
  - **Scoped PBT Approach**: Scope to deterministic checks
  - Assert `inventory.routes.ts` GET /api/inventory handler has no retry wrapper (confirm `withRetry` function does not exist in that file)
  - Simulate a transient PG error code `40001` (serialization failure) injected into `listInventory()`; assert the route returns HTTP 500 (not retried, confirms `noRetryMechanism` bug)
  - Assert `reconcile-inventory.mjs` terminal-status list is missing casing variants (e.g., `'Fulfilled'`, `'Completed'` with capital F/C)
  - Assert the test file `apps/api/src/tests/production-refinement.test.ts` does NOT yet exist (confirms missing integration tests T-5.1 through T-5.6)
  - Run tests on UNFIXED code — **EXPECTED OUTCOME**: Tests FAIL / assertions confirm bugs
  - Document findings
  - Mark task complete when tests are written, run, and failures documented
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8_

- [ ] 14. Write preservation property tests (BEFORE implementing Bug 5 fix)
  - **Property 2: Preservation** - Inventory Route Still Returns Data Normally; Reconciliation Dry-Run Correct; Existing Tests Unaffected
  - **IMPORTANT**: Follow observation-first methodology
  - Observe: `GET /api/inventory` returns HTTP 200 with inventory data under normal (non-transient) conditions on UNFIXED code
  - Observe: `reconcile-inventory.mjs --dry-run` prints correct output for books with correct quantities and exits 0 on UNFIXED code
  - Write property-based test: for all non-transient-error conditions on `GET /api/inventory`, the route returns HTTP 200 and the inventory data array is unchanged
  - Verify test PASSES on UNFIXED code
  - Run tests on UNFIXED code — **EXPECTED OUTCOME**: Tests PASS
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 5.1_

- [ ] 15. Implement Bug 5 fix — Stability

  - [ ] 15.1 Add `withRetry` wrapper to `GET /api/inventory` route
    - Modify `apps/api/src/modules/inventory/inventory.routes.ts`
    - Implement `withRetry<T>(fn, maxRetries=2, delayMs=200): Promise<T>` helper
    - Transient PG error codes to retry: `40001` (serialization), `40P01` (deadlock), `57P03` (cannot connect now), `08006` (connection failure), `08001` (unable to establish connection)
    - Retry strategy: attempt 0, 1, 2 with delays of 200ms × (attempt+1)
    - Non-transient errors rethrow immediately without retry
    - Wrap `listInventory()` call in `GET /api/inventory` and `GET /api/inventory/low-stock` with `withRetry()`
    - On exhaustion of all retries: rethrow — global error handler returns HTTP 503
    - _Bug_Condition: `GET /api/inventory` with transient DB error AND `noRetryMechanism`_
    - _Expected_Behavior: retry up to 2 times with 200ms back-off; return HTTP 503 only after all retries exhausted_
    - _Preservation: route still returns HTTP 200 with inventory data under normal conditions_
    - _Requirements: 5.1_

  - [ ] 15.2 Verify and update `reconcile-inventory.mjs` terminal-status list
    - Review `apps/api/scripts/reconcile-inventory.mjs`
    - Ensure the terminal-status IN clause for releasing stale reservations includes ALL casing variants: `('FULFILLED','COMPLETED','CANCELLED','Fulfilled','Completed','Cancelled')`
    - Confirm `expected_quantity = SUM(delta) FROM inventory_history` already covers all movement_type values
    - Confirm `--dry-run` path prints correct output and exits 0
    - Confirm exit codes: 0 on success, 1 on error (no silent swallowing)
    - No structural changes needed if already correct — document verification outcome
    - _Bug_Condition: `stale reservations not released because status list missing casing variants`_
    - _Expected_Behavior: all reservations for FULFILLED/COMPLETED/CANCELLED orders are released_
    - _Requirements: 5.2_

  - [ ] 15.3 Create integration test file `production-refinement.test.ts` — T-5.1: Confirm→Fulfill lifecycle
    - Create `apps/api/src/tests/production-refinement.test.ts` using existing test infrastructure (`src/tests/setup.ts`)
    - T-5.1 (CASH order lifecycle): Create book + inventory; create DRAFT CASH order; call `confirm()`
    - Assert after confirm: `inventory.quantity` decreased by order qty; exactly one `inventory_history` row with `reference_type='order_confirmed'`; `payment_status='paid'`
    - Call `fulfill()`; assert after fulfill: `inventory.quantity` UNCHANGED; exactly one `inventory_history` row with `reference_type='order_fulfilled'`; `order.status='FULFILLED'`
    - Assert `allowedActions` present in every API response
    - _Requirements: 2.23, 5.3_

  - [ ] 15.4 Add T-5.2 integration test — Credit order fulfill before payment
    - Add to `production-refinement.test.ts`
    - T-5.2: Create DRAFT CREDIT order; call `confirm()`; then call `fulfill()` with NO payment
    - Assert: `fulfill()` returns HTTP 200; `order.status='FULFILLED'`; `receivables.outstanding_amount = original order total`; `payment_status='unpaid'`
    - _Requirements: 2.24, 5.4_

  - [ ] 15.5 Add T-5.3 integration test — Post-fulfillment payment reduces receivable
    - Add to `production-refinement.test.ts`
    - T-5.3: Continue from T-5.2 FULFILLED credit order; call `collectPayment(partialAmount)`
    - Assert: `receivables.outstanding_amount` decreases by payment amount; `payment_status='partially_paid'`; `inventory.quantity` UNCHANGED by payment
    - Call `collectPayment(remainingAmount)`; assert: `outstanding_amount=0`; `payment_status='paid'`
    - _Requirements: 2.25, 5.5_

  - [ ] 15.6 Add T-5.4 integration test — Profit formula against fixture dataset
    - Add to `production-refinement.test.ts`
    - T-5.4: Seed fixture: 2 cash orders (fulfilled) + 1 credit order with partial payment + 1 return + 1 merchant discount + 1 exchange
    - Hand-calculate expected net profit: `fulfilledRevenue − purchaseCost − totalDiscounts − returnsValue ± exchangeAdjustment`
    - Call `computeNetProfit()` with fixture filters
    - Assert: computed `netProfit` equals hand-calculated value (within floating-point tolerance 0.01)
    - _Requirements: 2.26, 5.6_

  - [ ] 15.7 Add T-5.5 integration test — Catalog search beyond page 1
    - Add to `production-refinement.test.ts`
    - T-5.5: Seed a book at position > 25 in default sort (e.g., insert 26+ books alphabetically so target is on page 2+)
    - Call `GET /api/catalog/search?q=<unique-term-for-seeded-book>`; assert response contains the seeded book; `total ≥ 1`
    - Call same endpoint with `?q=<term>&page=1&limit=5`; assert seeded book still present (pagination params have no effect on search results)
    - _Requirements: 2.27, 5.7_

  - [ ] 15.8 Add T-5.6 integration test — resetDemoData preserves seed data
    - Add to `production-refinement.test.ts`
    - T-5.6: Record baseline counts for seed tables; run `reset-demo-data.mjs` in test mode (auto-YES, no prompt)
    - Assert after reset: `staff` rows with `id IN (1, 2)` exist; all seeded `books`, `authors`, `categories`, `publishers` records present; `inventory.quantity = 0` for all books; all transactional tables (orders, payments, receivables, reservations, inventory_history, purchase_orders, transactions, returns, exchanges, customers) have 0 rows
    - _Requirements: 2.28, 5.8_

  - [ ] 15.9 Verify stability exploration test now passes
    - **Property 1: Expected Behavior** - Retry Wrapper Active; Reconciliation Status List Complete; Integration Tests Present
    - **IMPORTANT**: Re-run the SAME test from task 13 — do NOT write a new test
    - Run the exploration test from task 13 against FIXED code
    - **EXPECTED OUTCOME**: Test PASSES (retry wrapper present; status list complete; test file exists)
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8_

  - [ ] 15.10 Verify preservation tests still pass (Bug 5)
    - **Property 2: Preservation** - Inventory Route Still Returns Data Normally; Reconciliation Dry-Run Correct
    - **IMPORTANT**: Re-run the SAME tests from task 14 — do NOT write new tests
    - Run preservation property tests from task 14 against FIXED code
    - **EXPECTED OUTCOME**: Tests PASS (normal GET /api/inventory still returns HTTP 200; reconcile --dry-run still works correctly)


<!-- ═══════════════════════════════════════════════════════════════
     BUG 6 — CSV EXPORT
     Shared csvBuilder utility + enhanced report queries + route
     updates. Last in the chain — no other bug depends on this.
     ═══════════════════════════════════════════════════════════════ -->

## Bug 6 — CSV Export

- [ ] 16. Write bug condition exploration test (Bug 6 — CSV Export)
  - **Property 1: Bug Condition** - CSV Exports Missing Required Columns and Incorrect Formatting
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **GOAL**: Surface concrete column gaps and formatting defects in current CSV exports
  - **Scoped PBT Approach**: Scope to deterministic column-presence and format checks for each of the four report types
  - Call `GET /api/reports/inventory/export`; parse CSV; assert `book_code` column is ABSENT (confirms missing column bug, requirement 6.3)
  - Call `GET /api/reports/sales/export` (if it exists); parse CSV; assert `net_profit` column is ABSENT (requirement 6.2)
  - Parse any numeric column in the current CSV; assert it contains currency symbols or thousand-separator formatting (e.g., `ETB 1,250.00`) rather than plain decimal (confirms requirement 6.6)
  - Parse any date column; assert format is NOT consistently `YYYY-MM-DD` (confirms requirement 6.4)
  - Assert response body does NOT start with UTF-8 BOM `\uFEFF` (confirms requirement 6.5)
  - Run tests on UNFIXED code — **EXPECTED OUTCOME**: Tests FAIL (all column and format bugs confirmed)
  - Document exact counterexamples found (e.g., "inventory CSV header row: title,author,quantity — missing book_code, publisher, quantity_reserved")
  - Mark task complete when tests are written, run, and failures documented
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_

- [ ] 17. Write preservation property tests (BEFORE implementing Bug 6 fix)
  - **Property 2: Preservation** - Existing Report Data Is Not Lost; Export Routes Still Accessible
  - **IMPORTANT**: Follow observation-first methodology
  - Observe: existing CSV export routes (`GET /api/reports/inventory/export`, etc.) return HTTP 200 on UNFIXED code
  - Observe: row counts in exported CSV match the number of inventory/orders/PO records in DB
  - Write property-based test: for all export requests, the number of data rows in the CSV equals the count of records in the source table matching the filter; the first byte of the response is a valid CSV character (not a server error HTML)
  - Verify test PASSES on UNFIXED code
  - Run tests on UNFIXED code — **EXPECTED OUTCOME**: Tests PASS
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 6.1_

- [ ] 18. Implement Bug 6 fix — CSV Export

  - [ ] 18.1 Create `csvBuilder.ts` — shared CSV utility (single source of truth)
    - Create new file `apps/api/src/lib/csvBuilder.ts`
    - Implement `CsvColumnDef` interface: `{ key: string; header: string; type: 'string' | 'number' | 'date' | 'integer' }`
    - Implement `buildCsv(rows: Record<string, unknown>[], columns: CsvColumnDef[]): string`
    - `formatValue()`: `number` → `parseFloat(v).toFixed(2)` (plain decimal, NO currency symbol); `integer` → `Math.round(Number(v))`; `date` → `d.toISOString().slice(0, 10)` (YYYY-MM-DD); `string` → `String(v)`; null/undefined → `''`
    - `escape()`: wrap in double-quotes if value contains comma, double-quote, or newline; escape internal double-quotes as `""`
    - Line separator: `\r\n`; first line is header row
    - Implement `sendCsv(res: Response, filename: string, csvContent: string): void`
    - `sendCsv` adds UTF-8 BOM prefix `'\uFEFF'` (not `buildCsv` — keeps `buildCsv` pure)
    - Set headers: `Content-Type: text/csv; charset=utf-8`; `Content-Disposition: attachment; filename="<filename>"`
    - _Bug_Condition: `missingColumns OR numericFieldIsFormattedString OR dateFieldNotISO8601 OR noBomPrefix`_
    - _Expected_Behavior: `buildCsv` produces plain-decimal numbers, YYYY-MM-DD dates, correct columns; `sendCsv` adds BOM_
    - _Requirements: 2.29–2.35, 6.6_

  - [ ] 18.2 Define column schemas as constants (all four report types)
    - Define `SALES_COLUMNS: CsvColumnDef[]` (15 columns): `order_reference`(string), `date`(date), `customer_name`(string), `sale_type`(string), `fulfillment_status`(string), `subtotal`(number), `discount_normal`(number), `discount_merchant`(number), `discount_special`(number), `total_discount`(number), `purchase_cost`(number), `net_profit`(number), `payment_status`(string), `collected_amount`(number), `outstanding_amount`(number)
    - Define `INVENTORY_COLUMNS: CsvColumnDef[]` (11 columns): `book_code`(string), `isbn`(string), `title`(string), `author`(string), `category`(string), `publisher`(string), `quantity_on_hand`(integer), `quantity_reserved`(integer), `quantity_available`(integer), `unit_cost`(number), `last_movement_date`(date)
    - Define `PROCUREMENT_COLUMNS: CsvColumnDef[]` (11 columns): `po_reference`(string), `date`(date), `supplier_name`(string), `status`(string), `book_code`(string), `title`(string), `ordered_quantity`(integer), `received_quantity`(integer), `unit_cost`(number), `line_total`(number), `po_total`(number)
    - Define `RECEIVABLES_COLUMNS: CsvColumnDef[]` (9 columns): `order_reference`(string), `date`(date), `customer_name`(string), `original_amount`(number), `collected_amount`(number), `outstanding_amount`(number), `due_date`(date), `days_overdue`(integer), `payment_status`(string)
    - _Requirements: 2.29, 2.30, 2.31, 2.32_

  - [ ] 18.3 Implement new export query functions in `reports.service.ts`
    - `getSalesExportRows(filters)`: JOIN `orders`, `order_line_items`, `customers`, `receivables`, `po_line_items` (purchase cost per book); apply profit formula per order; filter `status NOT IN ('CANCELLED')`; return 15-column row objects matching `SALES_COLUMNS` keys
    - `getProcurementExportRows(filters)`: JOIN `purchase_orders`, `po_line_items`, `books`, `suppliers`; return 11-column row objects matching `PROCUREMENT_COLUMNS` keys
    - `getReceivablesExportRows(filters)`: JOIN `receivables`, `orders` (for order_reference), `customers`; compute `days_overdue`; return 9-column row objects matching `RECEIVABLES_COLUMNS` keys
    - `getInventoryExportRows(filters)` (enhanced): add missing joins for `publishers`, `book_authors/authors`, `categories`; add `inventory_reservations` for `quantity_reserved`; LEFT JOIN `po_line_items` for `unit_cost`; add `last_movement_date` from MAX(inventory_history.created_at); return 11-column row objects matching `INVENTORY_COLUMNS` keys
    - _Requirements: 2.29, 2.30, 2.31, 2.32_

  - [ ] 18.4 Update all four export routes in `reports.routes.ts`
    - Remove the existing ad-hoc `toCSV()` function
    - Import `buildCsv`, `sendCsv`, and all four column schema constants from `csvBuilder.ts`
    - Replace each of the four existing export route bodies with: `const rows = await getSalesExportRows(filters); sendCsv(res, 'sales-report.csv', buildCsv(rows, SALES_COLUMNS));` (and equivalent for other types)
    - Add `GET /api/reports/procurement/export` route (may be new)
    - Add `GET /api/reports/receivables/export` route (may be new)
    - _Requirements: 2.29–2.35_

  - [ ] 18.5 Verify CSV export exploration test now passes
    - **Property 1: Expected Behavior** - CSV Exports Include All Required Columns with Correct Formatting
    - **IMPORTANT**: Re-run the SAME test from task 16 — do NOT write a new test
    - Run all four export endpoint checks from task 16 against FIXED code
    - **EXPECTED OUTCOME**: Test PASSES (all required columns present; numerics are plain decimals; dates are YYYY-MM-DD; BOM prefix present)
    - _Requirements: 2.29, 2.30, 2.31, 2.32, 2.33, 2.34, 2.35_

  - [ ] 18.6 Verify preservation tests still pass (Bug 6)
    - **Property 2: Preservation** - Existing Report Data Is Not Lost; Export Routes Still Accessible
    - **IMPORTANT**: Re-run the SAME tests from task 17 — do NOT write new tests
    - Run preservation property tests from task 17 against FIXED code
    - **EXPECTED OUTCOME**: Tests PASS (export routes return HTTP 200; data row counts match source tables)


<!-- ═══════════════════════════════════════════════════════════════
     FINAL CHECKPOINT
     All six bug areas complete. Verify full suite passes and the
     architecture constraint (inventoryTransactions.service.ts) holds.
     ═══════════════════════════════════════════════════════════════ -->

## Checkpoint — All Bugs

- [ ] 19. Checkpoint — Ensure all tests pass and architecture constraints hold
  - Run the full test suite: `npm test` (or the project's equivalent test command)
  - All six exploration tests (Properties 1) must now PASS (bugs fixed)
  - All six preservation tests (Properties 2) must PASS (no regressions)
  - All six integration test scenarios T-5.1 through T-5.6 must PASS
  - **Architecture constraint verification**: grep for `UPDATE inventory SET quantity` in all files except `inventoryTransactions.service.ts`; assert zero matches — `inventoryTransactions.service.ts` remains the ONLY inventory mutation engine
  - Verify no new inventory service has been created (only one `*.service.ts` file may export `stockIn`/`stockOut`/`adjust`/`transfer`/`fulfillReservation`)
  - Run `scripts/reset-demo-data.mjs --dry-run` and verify output lists all expected tables with row counts
  - Run `scripts/reconcile-inventory.mjs --dry-run` and verify correct output and exit code 0
  - Ask the user if any questions arise before closing the task

## Notes

- **Inventory mutation constraint**: All six bug fixes are strictly forbidden from issuing direct `UPDATE inventory SET quantity = ...` statements. Every inventory mutation (stockIn, stockOut, adjust, transfer, fulfillReservation) must go through `inventoryTransactions.service.ts`.
- **No new inventory service**: Tasks 3, 9 are the only ones touching inventory. Both route through the existing `invTxSvc` import — no new service file may be created.
- **Bug 5 depends on Bugs 1–4**: Integration tests T-5.1 through T-5.6 (tasks 15.3–15.8) require the fixes from Bugs 1–4 to already be in place. Do not attempt Bug 5 implementation until tasks 3, 6, 9, and 12 are complete.
- **PBT format**: All exploration and preservation tasks use `**Property N: Type** - [Title]` format to enable hover status in the spec viewer.
- **Deterministic exploration tests**: Where bugs are deterministic (e.g., Bug 4 — file doesn't exist), the "property" is scoped to the concrete failing case rather than a random-input generator.
- **Table name mapping**: The schema uses `transactions`/`transaction_line_items` (not `pos_transactions`/`pos_transaction_items`) and `purchase_orders`/`po_line_items` (not `procurement_orders`/`procurement_order_items`). Task 12 uses the correct schema names.
