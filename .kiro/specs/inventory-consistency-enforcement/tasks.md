# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Direct Inventory Mutation Bypasses Centralized Service
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior — it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate each module writes `UPDATE inventory` directly
  - **Scoped PBT Approach**: For each caller listed in `isBugCondition`, scope the property to one concrete failing case per module to ensure reproducibility
  - Test that `pos.service.createTransaction` deducts stock WITHOUT consulting `InventoryTransactionService` (Bug Condition: `X.usedCentralizedService = false`)
  - Test that `orders.service.confirm` deducts stock WITHOUT consulting `InventoryTransactionService`
  - Test that `orders.service.cancel` restores stock WITHOUT consulting `InventoryTransactionService`
  - Test that `procurement.service.receivePO` adds stock WITHOUT consulting `InventoryTransactionService`
  - Test that `returns.service.createReturn` adds stock WITHOUT consulting `InventoryTransactionService`
  - Test that `exchanges.service.createExchange` / `settleExchange` mutates stock WITHOUT consulting `InventoryTransactionService`
  - Additional scoped case: POS sells a book when active reservations exist — assert POS uses raw `quantity` (ignores reservations), i.e. `available = quantity` not `quantity - reservations`
  - Additional scoped case: `stockOut` API call does not subtract active reservations (reads raw `quantity`)
  - Additional scoped case: `adjustStock` writes an `inventory_history` row with `reference_type = NULL` even when a source document exists
  - Additional scoped case: `transferStock` writes history with `reference_type = NULL` and does not check reservations at source
  - Run test on UNFIXED code
  - **EXPECTED OUTCOME**: Test FAILS (this is correct — it proves the bugs exist)
  - Document counterexamples found per module to understand root cause
  - Mark task complete when test is written, run, and failures are documented
  - _Requirements: 1.1, 1.2, 1.8, 1.16, 1.17, 1.18, 1.19_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Non-Inventory Module Behaviors Unchanged
  - **IMPORTANT**: Follow observation-first methodology — run UNFIXED code with non-buggy inputs first
  - **Observe**: A POS transaction with full payment completes atomically — `transactionRecord EXISTS`, `paymentRecord EXISTS`, `auditLog EXISTS` on UNFIXED code
  - **Observe**: A DRAFT order creation leaves `inventory.quantity` unchanged on UNFIXED code
  - **Observe**: A FULFILLED / COMPLETED order cancellation attempt is rejected with `ORDER_ALREADY_FULFILLED` on UNFIXED code
  - **Observe**: `adjustStock` with a valid `version` and supported `reasonCode` succeeds on UNFIXED code, writes history, emits outbox event
  - **Observe**: `transferStock` with both locations in the same branch succeeds on UNFIXED code, writes paired history rows, emits `inventory.transfer_completed` outbox event
  - **Observe**: `isNegativeStockAllowed() = true` allows stock to proceed to 0 on UNFIXED code
  - **Observe**: A POS credit sale creates the receivable record, updates store_credit_accounts, and emits loyalty accrual events on UNFIXED code
  - **Observe**: `rejectReturn` leaves `inventory.quantity` unchanged on UNFIXED code
  - Write property-based tests: for all inputs NOT matching `isBugCondition`, `F(X) = F'(X)` — same DB state before and after for non-inventory fields
  - Write property-based test: for all `adjustStock` / `transferStock` calls with valid inputs, optimistic locking (version check) still rejects stale versions
  - Write property-based test: for all order cancellations on DRAFT orders, `inventory.quantity` is unchanged
  - Verify tests PASS on UNFIXED code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.12, 3.13, 3.14, 3.15, 3.16_

- [x] 3. Audit and document all direct `inventory.quantity` mutations

  - [x] 3.1 Grep every service file for direct inventory UPDATE statements
    - Search `pos.service.ts`, `orders.service.ts`, `procurement.service.ts`, `returns.service.ts`, `exchanges.service.ts`, `inventory.service.ts` for `UPDATE inventory SET quantity`
    - Catalogue each occurrence: file, function name, mutation type (deduction/addition), whether reservation check is performed, whether `inventory_history` is written, which fields are populated
    - Document findings in a code comment at the top of the new `inventoryTransaction.service.ts`
    - _Bug_Condition: isBugCondition(X) where X.usedCentralizedService = false_
    - _Requirements: 1.1, 1.2, 1.8, 1.12, 1.13, 1.14, 1.15, 1.16, 1.17, 1.18, 1.19_

- [x] 4. Create `InventoryTransactionService` — the single inventory mutation pipeline

  - [x] 4.1 Create `apps/api/src/modules/inventory/inventoryTransaction.service.ts`
    - Export four operations: `stockIn`, `stockOut`, `adjust`, `transfer`
    - `stockOut(params, client?)`: acquire `SELECT FOR UPDATE`, compute `available = quantity - SUM(active_reservations WHERE status='reserved')`, reject with `BusinessError('INSUFFICIENT_STOCK', ...)` if `available < requested`, apply `UPDATE inventory SET quantity = quantity - delta`, write complete `inventory_history` row
    - `stockIn(params, client?)`: acquire lock, apply `UPDATE inventory SET quantity = quantity + delta`, write complete `inventory_history` row
    - `adjust(params, client?)`: enforce optimistic lock (`version` check), enforce negative-stock policy, apply update, write `inventory_history` including optional `referenceType` / `referenceId`
    - `transfer(params, client?)`: validate same-branch, deadlock-safe lock order (lower `location_id` first), check `available = source.quantity - SUM(active_reservations at source)` before deducting, apply both updates, write paired history rows with `reference_type = 'transfer'` and a shared `reference_id`
    - All operations must write `inventory_history` with: `book_id`, `location_id`, `qty_before`, `qty_after`, `delta`, `movement_type`, `reason_code`, `reference_type`, `reference_id`, `staff_id` — none nullable except where schema permits
    - Graceful degradation: when `inventory_reservations` table does not exist, fall back to raw `quantity` for availability check (mirror existing `hasReservationsTable()` pattern)
    - Accept an optional pg `PoolClient` so callers can compose this service inside their own transactions
    - _Bug_Condition: isBugCondition(X) where X.usedCentralizedService = false_
    - _Expected_Behavior: expectedBehavior — all mutations route through this service; availability uses `quantity - SUM(active_reservations)`_
    - _Preservation: optimistic locking, negative-stock policy, graceful degradation, outbox events all preserved_
    - _Requirements: 2.1, 2.2, 2.3, 2.14, 2.18, 2.19, 2.20, 2.21, 2.22, 3.4, 3.6, 3.8, 3.12_

  - [x] 4.2 Add `getAvailableStock(bookId, locationId, client)` helper inside `inventoryTransaction.service.ts`
    - Returns `{ quantity, reserved, available }` where `available = quantity - SUM(active_reservations)`
    - Used internally by `stockOut` and `transfer` before deduction
    - Also exported for use by POS, Orders, and `stockOut` API path
    - _Requirements: 2.3, 2.19_

- [ ] 5. Migrate POS module to use `InventoryTransactionService`

  - [x] 5.1 Replace direct `UPDATE inventory` in `pos.service.createTransaction`
    - Remove inline `UPDATE inventory SET quantity = GREATEST(0, quantity - $1, ...)` block
    - Call `inventoryTransactionService.stockOut({ bookId, locationId, quantity, referenceType: 'sale', referenceId: txId, staffCtx }, client)` instead
    - The availability check inside `stockOut` now uses `quantity - active_reservations`, satisfying requirement 2.3 and 2.4
    - Preserve existing `FOR UPDATE` row lock — the service takes it internally, so remove the duplicate lock in POS
    - Preserve all surrounding logic: payment processing, loyalty accrual, receivable creation, audit log, outbox events
    - _Bug_Condition: isBugCondition(X) for pos.service.createTransaction_
    - _Expected_Behavior: deduction uses reservation-aware available quantity; inventory_history written with reference_type='sale'_
    - _Requirements: 1.2, 2.1, 2.3, 2.4, 3.3, 3.9_

  - [x] 5.2 Replace direct `UPDATE inventory` in POS void path (if applicable)
    - If a void/restore path exists in `pos.service.ts`, replace it with `inventoryTransactionService.stockIn({ ..., referenceType: 'void' }, client)`
    - Write `inventory_history` with `movement_type = 'stock_in'`, `reference_type = 'void'`
    - _Requirements: 2.9_

- [x] 6. Migrate Orders module to use `InventoryTransactionService`

  - [x] 6.1 Replace direct inventory deduction in `orders.service.confirm`
    - Remove inline `UPDATE inventory SET quantity = $1` block
    - Call `inventoryTransactionService.stockOut({ bookId, locationId, quantity, referenceType: 'order_confirmed', referenceId: orderId, staffCtx }, client)` for each line item
    - Ensure reservation insert (`inventory_reservations`) still runs after the service call, inside the same transaction
    - Availability check now handled inside service: `available = quantity - SUM(active_reservations)` (req 2.5b/c)
    - The entire confirmation is rejected atomically if any line is short (req 2.5c)
    - _Bug_Condition: isBugCondition(X) for orders.service.confirm_
    - _Expected_Behavior: (a) SELECT FOR UPDATE, (b) available = quantity - reservations, (c) reject on shortage, (d) deduct, (e) insert reservation, (f) write history_
    - _Requirements: 1.3, 1.6, 1.7, 2.1, 2.5, 3.1_

  - [x] 6.2 Confirm `orders.service.fulfill` does NOT deduct inventory
    - Verify `fulfill` does not call `inventoryTransactionService.stockOut` — inventory was already deducted at confirm time
    - `fulfill` should only update `qty_fulfilled`, transition reservation status `'reserved' → 'deducted'`, and write no new `inventory_history` deduction row
    - Add an explicit comment documenting this invariant
    - _Requirements: 2.6, 1.5_

  - [x] 6.3 Replace direct inventory restoration in `orders.service.cancel`
    - Remove inline `UPDATE inventory SET quantity = quantity + $1` block for confirmed cancellations
    - Call `inventoryTransactionService.stockIn({ bookId, locationId, quantity: item.qtyReserved, referenceType: 'order_cancelled', referenceId: orderId, staffCtx }, client)` for each line where `qtyReserved > 0`
    - DRAFT cancellations must NOT call stockIn (req 2.8 — no inventory impact for DRAFT)
    - Write `inventory_history` with `movement_type = 'stock_in'`, `reference_type = 'order_cancelled'`
    - _Bug_Condition: isBugCondition(X) for orders.service.cancel_
    - _Expected_Behavior: stock restored for CONFIRMED/PAID cancellations; DRAFT cancellation has zero inventory impact_
    - _Requirements: 1.5, 2.7, 2.8, 3.1, 3.2_

- [x] 7. Migrate Procurement module to use `InventoryTransactionService`

  - [x] 7.1 Replace direct `UPDATE inventory` in `procurement.service.receivePO`
    - Remove inline `SELECT quantity FOR UPDATE` + `UPDATE inventory SET quantity = quantity + $1` block
    - Call `inventoryTransactionService.stockIn({ bookId, locationId: effectiveLocationId, quantity: item.quantityReceived, referenceType: 'purchase_order', referenceId: poId, staffCtx }, client)` for each received line
    - Preserve all surrounding receipt logic (PO status update, `po_receipt_items` insert, audit log, outbox events)
    - _Bug_Condition: isBugCondition(X) for procurement.service.receivePO_
    - _Expected_Behavior: stock increased via centralized service with reference_type='purchase_order' and complete history row_
    - _Requirements: 1.12, 2.1, 2.11, 3.10_

- [x] 8. Migrate Returns module to use `InventoryTransactionService`

  - [x] 8.1 Replace direct `UPDATE inventory` in `returns.service.createReturn`
    - Remove inline `UPDATE inventory SET quantity = quantity + $1, version = version + 1` block
    - Call `inventoryTransactionService.stockIn({ bookId, locationId, quantity: line.quantity, referenceType: 'pos_return', referenceId: returnId, staffCtx }, client)` for each return line
    - `inventory_history` is now written by the service — remove the manual `INSERT INTO inventory_history` that follows the UPDATE
    - Preserve all surrounding return logic (refund, store credit, loyalty reversal, audit log)
    - _Bug_Condition: isBugCondition(X) for returns.service.createReturn_
    - _Expected_Behavior: stock restored via centralized service with reference_type='pos_return'_
    - _Requirements: 1.13, 2.1, 2.10, 3.7, 3.9, 3.10_

- [x] 9. Migrate Exchanges module to use `InventoryTransactionService`

  - [x] 9.1 Replace direct `UPDATE inventory` in `exchanges.service.createExchange`
    - For incoming items: replace inline UPDATE + history insert with `inventoryTransactionService.stockIn({ ..., referenceType: 'exchange_in', referenceId: exchangeId, staffCtx }, client)`
    - For outgoing items: replace inline UPDATE + history insert with `inventoryTransactionService.stockOut({ ..., referenceType: 'exchange_out', referenceId: exchangeId, staffCtx }, client)`
    - Availability check for outgoing items now handled inside `stockOut` (reservation-aware)
    - _Bug_Condition: isBugCondition(X) for exchanges.service.createExchange_
    - _Requirements: 1.14, 2.1, 2.12, 2.13, 3.10_

  - [x] 9.2 Replace direct `UPDATE inventory` in `exchanges.service.settleExchange`
    - For `type='returned'` items with `condition='resellable'`: call `inventoryTransactionService.stockIn({ ..., referenceType: 'exchange_in', referenceId: exchangeId, staffCtx }, client)`
    - For `type='returned'` items with `condition='damaged'`: call `inventoryTransactionService.stockIn({ ..., referenceType: 'exchange_damaged', referenceId: exchangeId, staffCtx }, client)`
    - For `type='new'` (outgoing) items: call `inventoryTransactionService.stockOut({ ..., referenceType: 'exchange_out', referenceId: exchangeId, staffCtx }, client)`
    - _Bug_Condition: isBugCondition(X) for exchanges.service.settleExchange_
    - _Requirements: 1.14, 2.1, 2.12, 2.13, 3.10, 3.11_

- [x] 10. Fix `inventory.service.ts` — strengthen `stockOut`, `adjustStock`, `transferStock`

  - [x] 10.1 Fix `stockOut` to use reservation-aware availability check
    - Replace pre-check `SELECT quantity FROM inventory` with `getAvailableStock(bookId, locationId)` from `inventoryTransactionService`
    - `available = quantity - SUM(active_reservations)` must be used for the insufficient-stock guard
    - The actual `UPDATE inventory` can remain in `stockOut` (it has its own `SELECT FOR UPDATE`) OR delegate to the centralized service — pick delegation for consistency
    - External API contract (`InventoryRow` response, version check, same auth requirements) must remain unchanged
    - _Bug_Condition: 1.16 — stockOut reads raw quantity, ignoring reservations_
    - _Requirements: 2.19, 2.20, 3.5, 3.14_

  - [x] 10.2 Fix `adjustStock` to accept and persist `referenceType` / `referenceId`
    - Add optional `referenceType?: string` and `referenceId?: number` parameters to `adjustStock` opts
    - Pass them through to the `INSERT INTO inventory_history` call
    - Default both to `null` for backward compatibility (existing callers without these fields continue to work)
    - _Bug_Condition: 1.18 — adjustStock always writes reference_type=NULL_
    - _Requirements: 2.21, 3.15_

  - [x] 10.3 Fix `transferStock` reservation check and history fields
    - Before deducting source: call `getAvailableStock(bookId, fromLocationId, client)` and reject if `available < quantity`
    - Generate a transfer batch ID (e.g., `crypto.randomUUID()`) and pass as `reference_id` to both history rows
    - Set `reference_type = 'transfer'` on both the `transfer_out` and `transfer_in` history rows
    - _Bug_Condition: 1.19 — transferStock ignores reservations at source and omits reference fields_
    - _Requirements: 2.22, 3.16_

- [x] 11. Fix order lifecycle — reservation status transitions

  - [x] 11.1 Ensure `inventory_reservations` rows are created on CONFIRMED and transitioned on FULFILLED / CANCELLED
    - CONFIRMED: `INSERT INTO inventory_reservations (order_id, book_id, location_id, quantity, status) VALUES (..., 'reserved')` — already present, verify it runs inside the service call transaction
    - FULFILLED: `UPDATE inventory_reservations SET status = 'deducted' WHERE order_id = $1 AND status = 'reserved'` — already present, verify it remains correct
    - CANCELLED (confirmed orders): delete or transition reservation rows to `'released'` within the same transaction as `stockIn`
    - Write `inventory_history` for each transition per requirement 2.5f, 2.6, 2.7
    - _Requirements: 2.5, 2.6, 2.7_

- [ ] 12. Book search per-location stock breakdown

  - [x] 12.1 Add `getBookStockBreakdown(bookId, branchId?)` to `inventory.service.ts`
    - Returns per-location rows: `{ locationId, locationName, quantity, reserved, damaged, available, sellable }`
    - `reserved = SUM(inventory_reservations.quantity WHERE status='reserved' AND book_id = $1 AND location_id = loc.id)`
    - `damaged = inventory.damaged_quantity` (if column exists, else 0)
    - `available = quantity - reserved`
    - `sellable = GREATEST(0, quantity - reserved - damaged)`
    - _Requirements: 2.15_

  - [ ] 12.2 Expose the breakdown via an inventory route
    - Add `GET /api/inventory/book/:bookId/breakdown` endpoint to `inventory.routes.ts`
    - Protected by `authenticate`; no role restriction beyond authentication
    - Response: `{ items: LocationStockBreakdown[] }`
    - _Requirements: 2.15_

- [x] 13. Dashboard KPIs — use live inventory + reservations data

  - [x] 13.1 Locate dashboard KPI query and update Available Stock / Reserved Stock tiles
    - Find the dashboard service or query that computes KPI values
    - Replace any stale aggregate queries for "Available Stock" with `SUM(i.quantity) - SUM(COALESCE(r.reserved, 0))` joined against `inventory_reservations`
    - Replace "Reserved Stock" KPI with `SUM(ir.quantity) WHERE ir.status = 'reserved'` from live `inventory_reservations`
    - Total Stock Value: `SUM(i.quantity * b.default_price)` from live `inventory`
    - Other KPI tiles (Sales, Returns, Refunds, Gross Profit, Net Profit) are not inventory-driven — leave unchanged
    - _Requirements: 2.16_

- [x] 14. Excel inventory report — add missing columns

  - [x] 14.1 Fix the inventory report export to include all required columns
    - Opening Stock: earliest `inventory_history` cumulative qty at period start (or `qty_before` of the earliest delta)
    - Stock In: `SUM(delta) WHERE delta > 0` from `inventory_history` within the report period
    - Stock Out: `ABS(SUM(delta)) WHERE delta < 0` from `inventory_history` within the report period
    - Reserved: `SUM(ir.quantity) WHERE ir.status = 'reserved'` at report-generation time
    - Returned: `SUM(delta) WHERE reference_type = 'pos_return'` from `inventory_history`
    - Damaged: `inventory.damaged_quantity` (or 0 if column not present)
    - Closing Stock: `inventory.quantity` at report-generation time
    - _Requirements: 2.17_

- [x] 15. Verify bug condition exploration test now passes
  - **Property 1: Expected Behavior** - All Inventory Mutations Route Through Centralized Service
  - **IMPORTANT**: Re-run the SAME test from task 1 — do NOT write a new test
  - The test from task 1 encodes the expected behavior (all callers use `InventoryTransactionService`, `stockOut` checks reservations, history rows are complete)
  - When this test passes, it confirms the centralized service is in place and all modules delegate to it
  - Run bug condition exploration test from task 1
  - **EXPECTED OUTCOME**: Test PASSES (confirms bugs are fixed)
  - _Requirements: 2.1, 2.2, 2.3, 2.14, 2.18, 2.19, 2.20, 2.21, 2.22_

- [x] 16. Verify preservation tests still pass
  - **Property 2: Preservation** - Non-Inventory Behaviors Unchanged
  - **IMPORTANT**: Re-run the SAME tests from task 2 — do NOT write new tests
  - Run preservation property tests from task 2
  - **EXPECTED OUTCOME**: All tests PASS (confirms no regressions in POS payment flow, DRAFT order behavior, fulfilled-order cancellation guard, optimistic locking, negative-stock policy, credit sales, return rejection, outbox event emission)
  - Confirm all tests still pass after fix (no regressions)

- [x] 17. Automated consistency scenario tests

  - [x] 17.1 Scenario 1 — POS sell deducts correct location stock
    - Arrange: book at location A qty=5, no active reservations
    - Act: `createTransaction` for qty=2 at location A
    - Assert: location A qty=3; `inventory_history` row exists with `movement_type='stock_out'`, `reference_type='sale'`, all fields populated
    - Assert: location B (different location, same branch) qty unchanged
    - _Requirements: 2.1, 2.4, 2.14, 3.3_

  - [x] 17.2 Scenario 2 — Reservation blocks POS oversell
    - Arrange: book at location A qty=3; active `inventory_reservations` row qty=3 for a confirmed order
    - Act: `createTransaction` for qty=1 at location A
    - Assert: `BusinessError('INSUFFICIENT_STOCK')` is thrown (available = 3 - 3 = 0)
    - Assert: `inventory.quantity` unchanged; no `inventory_history` row written
    - _Requirements: 1.2, 2.2, 2.3, 2.4_

  - [x] 17.3 Scenario 3 — Order cancel before fulfillment restores stock
    - Arrange: create and confirm an order (qty=2); verify `inventory.quantity` decremented by 2
    - Act: cancel the confirmed order
    - Assert: `inventory.quantity` restored by 2
    - Assert: `inventory_history` row with `movement_type='stock_in'`, `reference_type='order_cancelled'`
    - Assert: `inventory_reservations` row released/deleted
    - _Requirements: 2.7, 2.5, 3.2_

  - [x] 17.4 Scenario 4 — Order fulfill then cancel (fulfilled orders cannot be cancelled)
    - Arrange: confirm and fulfill an order
    - Act: attempt to cancel the fulfilled order
    - Assert: `BusinessError('ORDER_ALREADY_FULFILLED')` is thrown
    - Assert: `inventory.quantity` unchanged from post-fulfill state
    - _Requirements: 2.6, 3.2_

  - [x] 17.5 Scenario 5 — Return increases stock at correct location
    - Arrange: completed POS transaction at location A for qty=1
    - Act: `createReturn` for that line item
    - Assert: `inventory.quantity` at location A increased by 1
    - Assert: `inventory_history` row with `movement_type='stock_in'`, `reference_type='pos_return'`, all required fields present
    - _Requirements: 2.10, 2.14, 3.7_

- [x] 18. Checkpoint — Ensure all tests pass
  - Run the full test suite: `npm test --run` (or equivalent project test command) in `apps/api`
  - Confirm zero failures across exploration tests, preservation tests, and scenario tests
  - Confirm no TypeScript compile errors: `npx tsc --noEmit`
  - Ensure all tests pass; ask the user if any questions arise.
