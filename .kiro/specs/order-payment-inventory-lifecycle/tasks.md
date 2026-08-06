# Implementation Plan

- [x] 1. Write bug condition exploration tests (BEFORE implementing fixes)
  - **Property 1: Bug Condition** - Order–Payment–Inventory Lifecycle Defects
  - **CRITICAL**: These tests MUST FAIL on unfixed code — failure confirms the bugs exist
  - **DO NOT attempt to fix the test or the code when they fail**
  - **NOTE**: These tests encode the expected behavior — they will validate the fix when they pass after implementation
  - **GOAL**: Surface counterexamples that demonstrate the five root causes (C1–C5)
  - **Scoped PBT Approach**: Scope each property to concrete failing cases for reproducibility

  - [x] 1.1 Bug Condition C1 — PARTIALLY_PAID orders have no allowed actions
    - Create a CREDIT order → confirm → record partial payment → assert `payment_status = 'partially_paid'`
    - Call `computeOrderAllowedActions('PARTIALLY_PAID', ...)` → assert returns empty array `[]`
    - **EXPECTED OUTCOME**: Test FAILS on unfixed code (PARTIALLY_PAID falls through to default branch)
    - After fix: should return `['cancel', 'fulfill']`
    - _Requirements: 2.4, 2.5, 9.2_

  - [x] 1.2 Bug Condition C1 — `fulfill()` double-deducts stock
    - Create order with 10 units, confirm (stock deducted by 10), read `inventory.quantity` after confirm
    - Call `fulfill()`, read `inventory.quantity` after fulfill
    - Assert `inventory.quantity` decreased by 20 total (double-deduction bug)
    - **EXPECTED OUTCOME**: Test FAILS on unfixed code (confirms double-deduction)
    - After fix: stock should only be deducted once at confirm, unchanged at fulfill
    - _Requirements: 2.2, 2.7, 2.8_

  - [x] 1.3 Bug Condition C2 — FULFILLED CREDIT order absent from `listUnpaidOrders()`
    - Create CREDIT order → confirm → fulfill (order now COMPLETED with `payment_status = 'unpaid'`)
    - Call `listUnpaidOrders()` → assert order does NOT appear in result
    - **EXPECTED OUTCOME**: Test FAILS on unfixed code (COMPLETED orders excluded from query)
    - After fix: FULFILLED/COMPLETED orders with outstanding balance should appear
    - _Requirements: 1.3, 4.2_

  - [x] 1.4 Bug Condition C4 — `cancel()` does not restore inventory
    - Create order → confirm (stock deducted) → read `inventory.quantity` before cancel
    - Call `cancel()` → read `inventory.quantity` after cancel
    - Assert `inventory.quantity` is NOT restored (still deducted)
    - **EXPECTED OUTCOME**: Test FAILS on unfixed code (cancel releases reservation but doesn't call stockIn)
    - After fix: `inventory.quantity` should be restored via `invTxSvc.stockIn()`
    - _Requirements: 2.11, 3.2_

  - [x] 1.5 Bug Condition C5 — Return disposition undifferentiated
    - Create return for a FULFILLED order
    - Assert return does NOT have a `disposition` field (current API shape)
    - Create return, check that `inventory.quantity` is always incremented regardless of item condition
    - **EXPECTED OUTCOME**: Test FAILS on unfixed code (no disposition flag exists, all returns restore sellable stock)
    - After fix: `disposition = 'DAMAGED'` should update `damaged_quantity`, not `quantity`
    - _Requirements: 5.1, 5.2_

  - Mark task complete when all 5 tests are written, run, and failures are documented
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.2, 2.4, 2.5, 2.7, 2.11, 5.1, 9.2_

- [x] 2. Write preservation property tests (BEFORE implementing fixes)
  - **Property 2: Preservation** - Non-Buggy Behaviors Unchanged
  - **IMPORTANT**: Follow observation-first methodology — run UNFIXED code with non-buggy inputs first
  - **Observe**: POS cash sale completes atomically — transaction, payment, inventory deduction, audit log all written in one DB transaction on UNFIXED code
  - **Observe**: DRAFT order creation leaves `inventory.quantity` unchanged on UNFIXED code
  - **Observe**: FULFILLED order cancellation attempt throws `ORDER_ALREADY_FULFILLED` on UNFIXED code
  - **Observe**: `confirm()` already calls `invTxSvc.stockOut()` with `reference_type = 'order_confirmed'` on UNFIXED code
  - **Observe**: `cancel()` already settles receivable via `updateReceivableOnPayment()` inside savepoint on UNFIXED code
  - **Observe**: POS credit sale creates `pos_credit_sale` receivable on UNFIXED code
  - **Observe**: Dashboard KPIs read live `inventory + inventory_reservations` data on UNFIXED code

  - [x] 2.1 Preservation test: POS cash sale flow unchanged
    - Create POS transaction with full payment
    - Assert `inventory.quantity` decremented once, `inventory_history` row with `reference_type = 'sale'`, outbox `pos.sale_completed` emitted
    - Assert no `order_credit_sale` receivable created
    - _Requirements: 3.3_

  - [x] 2.2 Preservation test: DRAFT order zero inventory impact
    - Create order in DRAFT status
    - Assert `inventory.quantity` unchanged, no `inventory_history` rows for this order
    - _Requirements: 3.1_

  - [x] 2.3 Preservation test: FULFILLED order cancel blocked
    - Create order → confirm → fulfill → attempt cancel
    - Assert throws `BusinessError('ORDER_ALREADY_FULFILLED')`
    - Assert `inventory.quantity` unchanged
    - _Requirements: 3.2_

  - [x] 2.4 Preservation test: `confirm()` already uses `invTxSvc.stockOut()`
    - Create order → confirm
    - Assert `inventory_history` row exists with `reference_type = 'order_confirmed'`
    - Assert `inventory.quantity` deducted correctly
    - _Requirements: 3.13_

  - [x] 2.5 Preservation test: POS credit sale receivable unaffected
    - Create POS credit sale → assert `pos_credit_sale` receivable created
    - Create unrelated order payment → assert POS receivable unchanged
    - _Requirements: 3.4_

  - [x] 2.6 Preservation test: Dashboard KPIs use live data
    - Confirm an order → read Dashboard Available Stock KPI
    - Assert value matches `inventory.quantity - SUM(active_reservations)`
    - _Requirements: 7.2_

  - [x] 2.7 Preservation test: `computeOrderAllowedActions()` DRAFT/FULFILLED/COMPLETED/CANCELLED branches unchanged
    - Assert `computeOrderAllowedActions('DRAFT', ...)` returns expected actions
    - Assert `computeOrderAllowedActions('FULFILLED', ...)` returns `['return']`
    - Assert `computeOrderAllowedActions('COMPLETED', ...)` returns `['print']` or `[]`
    - Assert `computeOrderAllowedActions('CANCELLED', ...)` returns `[]`
    - _Requirements: 3.16_

  - Verify all tests PASS on UNFIXED code
  - Mark task complete when all 7 preservation tests pass on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.13, 3.16, 7.2_

- [x] 3. Add migration to extend `inventory_history.reference_type` constraint

  - [x] 3.1 Create `apps/api/src/db/migrations/1700000042_order_fulfilled_reference_type.cjs`
    - Drop existing `inventory_history_reference_type_check` constraint
    - Re-add constraint with all existing values PLUS `'order_fulfilled'` and `'order_return'`
    - Existing values: `'purchase_order'`, `'return'`, `'adjustment'`, `'manual'`, `'initial_stock'`, `'sale'`, `'void'`, `'pos_return'`, `'order'`, `'exchange_in'`, `'exchange_out'`, `'exchange_damaged'`, `'order_confirmed'`, `'order_cancelled'`
    - New values: `'order_fulfilled'`, `'order_return'`
    - Include `down` function to revert
    - _Requirements: 2.7, 5.1_

- [x] 4. Add `fulfillReservation()` to `inventoryTransaction.service.ts`

  - [x] 4.1 Define `FulfillReservationParams` interface
    - `orderId: number | string`
    - `locationId: number`
    - `lineItems: Array<{ bookId: number; qtyReserved: number }>`
    - `staffCtx: StaffCtx`

  - [x] 4.2 Implement `fulfillReservation()` method
    - Accept optional `externalClient?: PoolClient` to participate in caller's transaction
    - For each line item where `qtyReserved > 0`:
      - Read current `inventory.quantity` (no UPDATE — stock was already deducted at confirm)
      - Insert `inventory_history` row with:
        - `movement_type = 'stock_out'` (for audit continuity)
        - `reference_type = 'order_fulfilled'`
        - `reference_id = orderId`
        - `qty_before = qty_after = inventory.quantity` (unchanged)
        - `delta = 0` (no physical change)
        - `staff_id` from `staffCtx`
    - Update `inventory_reservations SET status = 'deducted', updated_at = now() WHERE order_id = $1 AND status = 'reserved'`
    - Does NOT modify `inventory.quantity`
    - Graceful degradation if `inventory_reservations` table doesn't exist
    - _Bug_Condition: C1 where fulfill() incorrectly calls stockOut() for second deduction_
    - _Expected_Behavior: Reservation transitions to 'deducted', history written with delta=0, quantity unchanged_
    - _Requirements: 2.7, 2.8, 2.9, 2.10_

- [x] 5. Fix `orders.service.fulfill()` — remove double-deduction

  - [x] 5.1 Remove the `invTxSvc.stockOut()` call from the fulfillment loop
    - Stock was already deducted at `confirm()` time
    - Replace with call to `invTxSvc.fulfillReservation()`
    - _Bug_Condition: C1 where fulfill() incorrectly deducts stock a second time_
    - _Expected_Behavior: Stock remains unchanged at fulfill, reservation marked 'deducted'_
    - _Requirements: 2.7, 2.8_

  - [x] 5.2 Remove the payment status gate for CASH orders
    - Remove the `cash_sale && !effectivelyPaid` guard that blocks fulfillment
    - Accept CONFIRMED, PARTIALLY_PAID, and PAID statuses for fulfill action
    - CREDIT orders must be fulfillable from CONFIRMED status (no payment required)
    - CASH orders are already paid at confirmation (`payment_status = 'paid'`), so gate is unnecessary
    - _Bug_Condition: C1 where fulfill is blocked by payment_status check_
    - _Expected_Behavior: Fulfillment allowed for CONFIRMED, PARTIALLY_PAID, and PAID orders_
    - _Requirements: 2.4, 2.5, 2.6, 2.7_

  - [x] 5.3 Remove direct `UPDATE inventory_reservations` statement
    - Reservation status transition now handled inside `fulfillReservation()`
    - _Requirements: 2.7_

  - [x] 5.4 Keep auto-transition to COMPLETED for both sale types
    - Both CASH and CREDIT orders transition to COMPLETED at fulfillment
    - For CREDIT orders, receivable stays open until paid
    - _Requirements: 2.9, 2.10_

  - [x] 5.5 Ensure fulfill does NOT settle or modify receivables
    - Remove any receivable settlement logic from fulfill path
    - Receivables are settled by `payments.service.createPayment()` only
    - _Requirements: 2.9, 2.10_

- [x] 6. Fix `orders.service.cancel()` — add inventory restoration

  - [x] 6.1 Add `invTxSvc.stockIn()` call for CONFIRMED/PARTIALLY_PAID/PAID orders
  - [x] 6.2 Resolve `locationId` using `resolveLocationId()` helper
  - [x] 6.3 Make cancellation fully atomic
  - [x] 6.4 Ensure DRAFT cancellations do NOT call stockIn

- [x] 7. Fix `computeOrderAllowedActions()` — add PARTIALLY_PAID branch and remove payment gate

  - [x] 7.1 Add `'PARTIALLY_PAID'` branch
  - [x] 7.2 Remove payment status gate from `'CONFIRMED'` branch
  - [x] 7.3 Keep `'FULFILLED'` branch unchanged

- [x] 8. Fix `payments.service.listUnpaidOrders()` — include FULFILLED CREDIT orders

  - [x] 8.1 Update CTE query to include FULFILLED/COMPLETED CREDIT orders with outstanding balance
  - [x] 8.2 Ensure CASH orders never appear in pending payments
  - [x] 8.3 Ensure DRAFT orders never appear in pending payments

- [x] 9. Fix `payments.service.createPayment()` for post-fulfillment CREDIT orders

  - [x] 9.1 Remove status block for FULFILLED/COMPLETED orders
  - [x] 9.2 Ensure receivable sync runs for FULFILLED orders
  - [x] 9.3 Verify `EXCEEDS_ORDER_TOTAL` guard remains active

- [x] 10. Fix `returns.service.createReturn()` — add disposition flag

  - [x] 10.1 Add `disposition` field to `ReturnLineInput` interface
  - [x] 10.2 Branch on disposition when restoring inventory
  - [x] 10.3 For CREDIT orders, adjust receivable balance

- [x] 11. Fix `exchanges.service.settleExchange()` — guarantee atomicity

  - [x] 11.1 Verify all inventory mutations happen inside single transaction
  - [x] 11.2 Verify existing idempotency check remains
  - [x] 11.3 For CREDIT order exchanges, call `updateReceivableOnPayment()`
  - [x] 11.4 Ensure outer `catch` block rolls back all sub-steps

- [x] 12. Frontend: Fix OrdersPage fulfill button visibility

  - [x] 12.1 Update legacy fallback for `!order.allowedActions`

- [x] 13. Frontend: Fix PaymentsPage button visibility

  - [x] 13.1 Hide "Void/Refund" button for payments on FULFILLED orders
  - [x] 13.2 Ensure DRAFT orders do not show Collect button
  - [x] 13.3 Ensure CASH orders do not appear in Pending Payments

- [x] 14. Write integration tests — all 9 required scenarios

  - [x] 14.1 Test: CASH lifecycle — DRAFT → CONFIRMED (paid) → FULFILLED → COMPLETED
    - Create CASH order → confirm (assert `payment_status = 'paid'` immediately, no receivable)
    - Fulfill (assert no stock deduction, reservation → 'deducted')
    - Assert order status = COMPLETED
    - Assert `inventory.quantity = preConfirm - qty`
    - _Requirements: 2.3, 2.7, 2.8_

  - [x] 14.2 Test: CREDIT lifecycle — DRAFT → CONFIRMED → FULFILLED → post-fulfillment payment
    - Create CREDIT order → confirm (assert receivable created, `payment_status = 'unpaid'`)
    - Fulfill (assert receivable unchanged, order COMPLETED)
    - Call `createPayment()` → assert receivable reduced
    - Full payment → assert `payment_status = 'paid'`, receivable Settled
    - _Requirements: 2.4, 2.9, 4.6_

  - [x] 14.3 Test: PARTIAL CREDIT — CONFIRMED → PARTIALLY_PAID → FULFILLED → post-fulfillment payment
    - Create CREDIT order → confirm → record partial payment (assert `payment_status = 'partially_paid'`)
    - Fulfill (assert allowed from PARTIALLY_PAID)
    - Record remaining payment → assert receivable Settled
    - _Requirements: 2.5, 2.10, 4.6_

  - [x] 14.4 Test: Cancellation before fulfillment — atomic guarantee
    - Create CREDIT order → confirm → cancel
    - Assert in one assertion block:
      - `inventory.quantity` restored to pre-confirm value
      - `inventory_reservations.status = 'released'`
      - `receivable.status = 'Settled'`, `outstanding_amount = 0`
    - _Requirements: 2.11, 3.2_

  - [x] 14.5 Test: FULFILLED order cancellation rejected
    - Create CREDIT order → confirm → fulfill
    - Call `cancel()` → assert throws `BusinessError('ORDER_ALREADY_FULFILLED')`
    - Assert `inventory.quantity` unchanged
    - _Requirements: 2.12, 3.2_

  - [x] 14.6 Test: Return SELLABLE — stock restored to inventory.quantity
    - Create order → confirm → fulfill → return with `disposition = 'SELLABLE'`
    - Assert `inventory.quantity` increases by returned qty
    - Assert `inventory.damaged_quantity` unchanged
    - _Requirements: 5.1_

  - [x] 14.7 Test: Return DAMAGED — inventory.damaged_quantity increased, inventory.quantity unchanged
    - Same flow, `disposition = 'DAMAGED'`
    - Assert `inventory.quantity` unchanged
    - Assert `inventory.damaged_quantity` increased by returned qty
    - _Requirements: 5.1_

  - [x] 14.8 Test: CREDIT return — receivable balance reduced
    - CREDIT order → fulfill → return (SELLABLE)
    - Assert `receivable.outstanding_amount` decreases by returned line value
    - _Requirements: 5.2_

  - [x] 14.9 Test: Concurrent confirmations — only one succeeds, no negative stock
    - `inventory.quantity = 3` for book X
    - Two concurrent `confirm()` calls, each requesting 3 units
    - Assert exactly one succeeds, other throws `INSUFFICIENT_STOCK`
    - Assert `inventory.quantity = 0` after winner
    - _Requirements: 8.1, 8.2_

- [x] 15. Write unit tests

  - [x] 15.1 Unit test: `computeOrderAllowedActions('PARTIALLY_PAID')` returns `['cancel', 'fulfill']`
  - [x] 15.2 Unit test: `computeOrderAllowedActions('CONFIRMED')` returns `['cancel', 'fulfill']` regardless of `paymentStatus` or `saleType`
  - [x] 15.3 Unit test: `computeOrderAllowedActions('FULFILLED')` returns `['return']`
  - [x] 15.4 Unit test: `fulfillReservation()` writes `inventory_history` with `delta=0`, `reference_type='order_fulfilled'`
  - [x] 15.5 Unit test: `fulfillReservation()` sets `inventory_reservations.status='deducted'`
  - [x] 15.6 Unit test: `fulfillReservation()` does NOT modify `inventory.quantity`
  - [x] 15.7 Unit test: `cancel()` on CONFIRMED order calls `invTxSvc.stockIn()`
  - [x] 15.8 Unit test: `cancel()` on DRAFT order does NOT call `invTxSvc.stockIn()`
  - [x] 15.9 Unit test: `createPayment()` accepts FULFILLED CREDIT orders with outstanding balance

- [x] 16. Verify bug condition exploration tests now PASS

  - [x] 16.1 Re-run test 1.1 (PARTIALLY_PAID allowed actions) — assert returns `['cancel', 'fulfill']`
  - [x] 16.2 Re-run test 1.2 (fulfill double-deduction) — assert stock only deducted once
  - [x] 16.3 Re-run test 1.3 (FULFILLED CREDIT in listUnpaidOrders) — assert order appears
  - [x] 16.4 Re-run test 1.4 (cancel restores inventory) — assert inventory restored
  - [x] 16.5 Re-run test 1.5 (return disposition) — assert disposition flag works correctly

- [x] 17. Verify preservation tests still PASS

  - [x] 17.1 Re-run test 2.1 (POS cash sale) — assert unchanged
  - [x] 17.2 Re-run test 2.2 (DRAFT zero impact) — assert unchanged
  - [x] 17.3 Re-run test 2.3 (FULFILLED cancel blocked) — assert unchanged
  - [x] 17.4 Re-run test 2.4 (confirm uses invTxSvc) — assert unchanged
  - [x] 17.5 Re-run test 2.5 (POS receivable unaffected) — assert unchanged
  - [x] 17.6 Re-run test 2.6 (Dashboard KPIs) — assert unchanged
  - [x] 17.7 Re-run test 2.7 (computeOrderAllowedActions branches) — assert unchanged

- [x] 19. Disable taxation globally — API layer

  - [x] 19.1 Zero out tax calculation in `orders.service.ts` `createOrder()`
    - Replace the `getEffectiveConfig(branchId, 'tax_rate')` read with a constant `0`
    - Set `taxRate = 0`, `taxAmount = 0`, `total = subtotal` (subtotal already has discounts applied)
    - Remove or comment the `getEffectiveConfig` tax_rate call — do not delete the column
    - Ensure `INSERT INTO orders` sets `tax_rate = 0, tax_amount = 0`
    - _Policy: Order total = subtotal − discount. No tax._

  - [x] 19.2 Zero out tax in `pos.service.ts` `createTransaction()`
    - Confirm `taxTotal = 0` is already hardcoded (it is) — verify and add assertion comment
    - Ensure `grandTotal = subtotal` (already true) — add explicit comment: "No tax: grandTotal = subtotal"
    - Remove any future re-introduction guard
    - _Policy: POS grand total = subtotal − discount. No tax._

  - [x] 19.3 Remove `tax_rate` from `config.service.ts` CONFIG_SCHEMA (UI only — keep DB key)
    - Remove `tax_rate: { type: 'number' }` from `CONFIG_SCHEMA`
    - This prevents the Settings page from showing/editing it
    - Keep the DB row in `system_config` — do not delete data

  - [x] 19.4 Remove `tax_rate` from seed defaults in `seed.ts`
    - Remove the `['tax_rate', ...]` entry from `configDefaults` array in `seed.ts`
    - Prevents re-seeding a non-zero tax rate

- [x] 20. Disable taxation globally — Frontend layer

  - [x] 20.1 Remove `taxAmount` display and field from `OrdersPage.tsx`
    - Remove `taxAmount` from `Order` interface (or keep field but stop rendering it)
    - Change "Subtotal (excl. tax)" label to "Subtotal"
    - Remove any "Tax" line from order detail view
    - Ensure order total shown = subtotal − discount only
    - _Policy: No tax line anywhere in UI_

  - [x] 20.2 Remove `taxTotal` display from `POSPage.tsx`
    - Remove `taxTotal` from the `Transaction` interface (or set to always 0)
    - Remove any Tax row from POS receipt/totals panel if present
    - Verify "Totals — no tax" comment block has no tax line rendered

  - [x] 20.3 Remove `tax_rate` from `SettingsPage.tsx` CONFIG_META
    - Remove the `tax_rate: { label: 'Tax Rate', ... }` entry from `CONFIG_META`
    - This prevents the Settings page from rendering the Tax Rate field
    - _Policy: Tax rate is not configurable during this phase_

  - [x] 20.4 Update `config.test.ts` to remove tax_rate assertions
    - Remove or update `expect(keys).toContain('tax_rate')` assertion
    - Remove the `PUT /api/config/system/tax_rate` test cases (or update to expect 404/rejection)
    - Update `afterAll` cleanup to not reset `tax_rate`
    - Remove `tax_rate` from the `GET /api/config/effective` test assertion

- [x] 21. Inventory page — display Reserved and Available columns

  - [x] 21.1 Add `reserved` and `available` fields to `InventoryRow` interface in `InventoryPage.tsx`
    - The API already returns these fields — just add them to the frontend type
    - `reserved: number; available: number;`

  - [x] 21.2 Add "Reserved" and "Available" columns to the Stock Levels table header
    - Add `<th>` cells for "On Hand", "Reserved", "Available" after existing "Qty" column
    - "Qty" → rename to "On Hand" (raw `inventory.quantity`)
    - Add "Reserved" (sum of active reservations)
    - Add "Available" (on_hand − reserved)

  - [x] 21.3 Render reserved and available values per row
    - Show `row.quantity` under "On Hand"
    - Show `row.reserved` under "Reserved" (dim/muted style)
    - Show `row.available` under "Available" (highlight if 0 or low)
    - Update `colSpan` values for empty state and skeleton rows to match new column count

  - [x] 21.4 Ensure Inventory page always loads and refreshes reliably
    - Add `retry: 2` and `staleTime: 0` to the inventory `useQuery` config
    - Add an error boundary / error state render: show "Failed to load inventory — Retry" button
    - Add explicit `refetchOnWindowFocus: true` to force refresh on tab switch

- [x] 22. Book search — display Qty / On hand / Reserved / Available in OrdersPage

  - [x] 22.1 Update `BookResult` interface in `OrdersPage.tsx`
    - Add `availability?: { locationId: number; locationName: string | null; onHand: number; reserved: number; available: number } | null`
    - This matches the existing API response shape from `/books/with-availability`

  - [x] 22.2 Pass `locationId` to the book search query in `OrdersPage.tsx`
    - The query currently hits `/books/with-availability?q=...&branchId=...`
    - Add `&locationId=${locationId}` when `locationId` is set
    - This enables the API to populate `availability`

  - [x] 22.3 Render availability in the book search dropdown
    - For each search result, show: `On hand: X · Reserved: Y · Available: Z`
    - Mirror the POS display pattern: `📍 {locationName} · On hand: {onHand} · Reserved: {reserved}`
    - Disable the "Add" button when `availability.available === 0` (same as POS)
    - Show the stock badge (in-stock / low-stock / out-of-stock) next to the book title

- [x] 23. Inventory reconciliation script

  - [x] 23.1 Create `apps/api/scripts/reconcile-inventory.mjs`
    - Rebuild `inventory.quantity` for each `(book_id, location_id)` from the canonical `inventory_history` ledger
    - Algorithm:
      - For each `(book_id, location_id)` pair in `inventory_history`:
        - `computed_qty = SUM(delta) WHERE movement_type IN ('stock_in','stock_out','transfer_in','transfer_out','adjustment','transfer')`
        - Compare against `inventory.quantity`
        - If mismatch: `UPDATE inventory SET quantity = computed_qty WHERE ...`
        - Log mismatches to stdout as JSON
    - Release stale `inventory_reservations` with `status = 'reserved'` for orders that are FULFILLED, COMPLETED, or CANCELLED
    - Print summary: total rows checked, mismatches repaired, reservations released
    - Accept `--dry-run` flag to log without writing

  - [x] 23.2 Add `"reconcile": "node scripts/reconcile-inventory.mjs"` to `apps/api/package.json` scripts

- [x] 18. Final checkpoint — full test suite + TypeScript compile check

  - [x] 18.1 Run full test suite in `apps/api`: `npm test --run`
  - [x] 18.2 Run TypeScript compiler: `npx tsc --noEmit`
  - [x] 18.3 Assert zero failures
  - If any test fails, diagnose and fix before marking complete
  - _Requirements: All requirements must pass_
