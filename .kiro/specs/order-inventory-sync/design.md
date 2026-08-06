# Order Inventory Sync Bugfix Design

## Overview

The `confirm()` function in `orders.service.ts` creates soft reservations in
`inventory_reservations` and sets `qty_reserved` on line items but never deducts
`inventory.quantity`. Stock deduction only happens in `fulfill()`. This means
confirmed orders leave stock apparently available, enabling concurrent oversell, and
cancelling a confirmed order silently does nothing to inventory. No `inventory_history`
records are written for order-driven movements at confirmation or cancellation time.

The fix is surgical: modify only `confirm()`, `cancel()`, and `fulfill()` in
`orders.service.ts`, add one migration to extend the `inventory_history` reference_type
CHECK constraint to allow `'order_confirmed'` and `'order_cancelled'`, and invalidate
TanStack Query caches after confirm/cancel in the frontend.

---

## Glossary

- **Bug_Condition (C)**: An order transition where `fromStatus = 'DRAFT'` and
  `toStatus = 'CONFIRMED'`. Under the bug, `inventory.quantity` is NOT deducted despite
  the order being approved.
- **Property (P)**: For any confirmation where C holds, after `confirm'()` completes
  `inventory.quantity` MUST equal `quantityBefore − requestedQty`, be ≥ 0, and an
  `inventory_history` record with `reference_type = 'order_confirmed'` MUST exist.
- **Preservation**: All behaviors unrelated to order confirmation/cancellation inventory
  deduction must remain identical — draft creation, draft cancellation, POS sales,
  procurement, stock adjustments/transfers, fulfilled/completed order guards, and the
  `inventory_reservations` graceful-degradation path.
- **`confirm()`**: Function in `apps/api/src/modules/orders/orders.service.ts` that
  transitions an order from `DRAFT → CONFIRMED`. Currently creates soft reservations
  but does not deduct `inventory.quantity`.
- **`cancel()`**: Function in the same file that cancels an order. For CONFIRMED orders
  it currently releases soft reservations but does not restore `inventory.quantity`.
- **`fulfill()`**: Function that transitions `CONFIRMED/PAID → FULFILLED`. Currently
  deducts `inventory.quantity` using `item.qtyReserved`. After the fix, inventory is
  already deducted at confirmation, so fulfillment must NOT deduct again.
- **`inventory_reservations`**: Soft-reservation table added in migration 33. Its
  existence is checked at runtime; the code degrades gracefully when absent.
- **`inventory_history`**: Partitioned audit table. A CHECK constraint on `reference_type`
  currently does not include `'order_confirmed'` or `'order_cancelled'`. A new migration
  must extend it.

---

## Bug Details

### Bug Condition

The bug manifests when a DRAFT order is confirmed. The `confirm()` function checks
available stock and creates soft reservations correctly, but never issues an
`UPDATE inventory SET quantity = quantity - N …` statement, so real stock counts
are unchanged until fulfillment (if it ever happens).

**Formal Specification:**

```
FUNCTION isBugCondition(X)
  INPUT: X of type OrderTransition
  OUTPUT: boolean

  RETURN X.fromStatus = 'DRAFT'
     AND X.toStatus   = 'CONFIRMED'
END FUNCTION
```

### Examples

- **Oversell**: 3 units of Book A in stock. Two concurrent requests confirm orders for
  3 units each. Both pass the available-stock check (soft reservations are read, but no
  lock is held on `inventory`), both succeed, and stock appears as 3 throughout.
  Expected: second confirmation should fail with `INSUFFICIENT_STOCK`.
- **Silent cancel**: An order for 2 units is confirmed (stock still shows 5). The order
  is then cancelled — `inventory_reservations` row is released, but stock still shows 5.
  Expected: 5 (no deduction occurred, so no restoration needed, which is actually correct
  post-fix — but pre-fix confirmation never deducted, so post-fix cancellation must
  restore the 2 units that WILL now be deducted).
- **Double-deduct at fulfillment**: Post-fix, if `fulfill()` is not updated it would
  deduct `qtyReserved` again even though confirmation already deducted. Expected:
  fulfillment must skip the inventory deduction step (stock was already moved).
- **History gap**: After confirmation, `inventory_history` contains no row for the
  movement. Expected: a row with `reference_type = 'order_confirmed'` and correct
  delta, qty_before, qty_after, staff_id.

---

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- `DRAFT` order creation MUST NOT touch `inventory.quantity`.
- Cancelling a `DRAFT` order (before confirmation) MUST NOT touch `inventory.quantity`.
- Cancelling a `FULFILLED` or `COMPLETED` order MUST continue to reject with
  `ORDER_ALREADY_FULFILLED`.
- POS sales MUST continue to use the existing `pos.service.ts` deduction path,
  unaffected by this change.
- Procurement (stock-in, adjustments, transfers) MUST continue to use existing
  `inventory.service.ts` functions unchanged.
- The `inventory_reservations` graceful-degradation path (table may not exist) MUST
  continue to work — the fix must also guard the new `inventory_reservations` status
  updates with the same try/catch pattern already used.
- `inventory.quantity` MUST never go below 0 (the DB CHECK constraint
  `inventory_quantity_nonneg` enforces this; the application must also enforce it
  before the update to return a human-readable `INSUFFICIENT_STOCK` error).

**Scope of change:**
All inputs where `isBugCondition` returns false are completely unaffected. This includes:
- Any action on a DRAFT order other than confirmation
- Fulfill, pay, progress, complete transitions
- POS, procurement, exchange, returns flows

---

## Hypothesized Root Cause

1. **Missing `UPDATE inventory` in `confirm()`**: The existing loop checks available
   stock, sets `qty_reserved` on line items, and inserts into `inventory_reservations`,
   but has no `UPDATE inventory SET quantity = quantity - N …` statement. This is the
   direct cause.

2. **Missing row-lock before stock check**: The available-stock query in `confirm()`
   does not use `SELECT … FOR UPDATE` on `inventory`, so two concurrent confirmations
   for the same book can both pass the stock check before either deducts.

3. **`cancel()` does not restore inventory**: Because no deduction happens at
   confirmation under the current code, there is nothing to restore. Post-fix, when
   confirmation does deduct, `cancel()` must be updated to restore the stock.

4. **`fulfill()` double-deducts post-fix**: `fulfill()` deducts `item.qtyReserved`.
   After the fix, that deduction already happened at confirmation, so `fulfill()` must
   be changed to skip the inventory deduction (it can still update `qty_fulfilled` and
   manage reservation status).

5. **Missing `inventory_history` records**: Neither `confirm()` nor `cancel()` write
   to `inventory_history`. The CHECK constraint on `reference_type` also doesn't yet
   include the new reason codes needed.

---

## Correctness Properties

Property 1: Bug Condition — Inventory Deducted on Confirmation

_For any_ order transition where `isBugCondition(X)` is true (DRAFT → CONFIRMED), the
fixed `confirm()` function SHALL:
- Deduct `inventory.quantity` by the requested quantity for every non-backordered
  line item, atomically within a single transaction.
- Use `SELECT … FOR UPDATE` to prevent concurrent oversell.
- Reject the entire confirmation with `INSUFFICIENT_STOCK` if any line item's quantity
  exceeds available stock (with the lock held).
- Write one `inventory_history` record per deducted line item with
  `reference_type = 'order_confirmed'`.
- Leave `inventory.quantity ≥ 0` after the transaction.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6**

Property 2: Preservation — Non-Confirmation Paths Unchanged

_For any_ action where `isBugCondition(X)` is false (draft creation, draft cancellation,
fulfill, pay, progress, POS, procurement, adjustments, etc.), the fixed code SHALL
produce exactly the same result as the original code, with no change to `inventory.quantity`
beyond what was already happening in those paths.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8**

---

## Fix Implementation

### Changes Required

#### File: `apps/api/src/db/migrations/1700000037_order_inventory_history_reason.cjs`  *(new)*

Extend the `inventory_history.reference_type` CHECK constraint to include
`'order_confirmed'` and `'order_cancelled'`. The current constraint (from migration 33)
allows: `purchase_order`, `return`, `adjustment`, `manual`, `initial_stock`, `sale`,
`void`, `pos_return`, `order`, `exchange_in`, `exchange_out`, `exchange_damaged`.

Add `'order_confirmed'` and `'order_cancelled'` to that list.

#### File: `apps/api/src/modules/orders/orders.service.ts`

**Function `confirm()` — specific changes:**

1. **Add `SELECT … FOR UPDATE` per line item inside the transaction** — lock each
   `inventory` row before reading available stock. This prevents concurrent confirmations
   from both passing the stock check.

2. **Replace backorder-on-low-stock with hard rejection** — instead of marking a line
   `is_backordered = true` and continuing, throw `BusinessError('INSUFFICIENT_STOCK', …)`
   so the transaction rolls back and the entire confirmation fails.

3. **Add `UPDATE inventory SET quantity = quantity - $qty WHERE book_id = $id AND location_id = $loc`**
   for each non-backordered (sufficient stock) line item, inside the same transaction.

4. **Write `inventory_history` record per line** with:
   - `movement_type = 'stock_out'`
   - `reference_type = 'order_confirmed'`
   - `reference_id = orderId`
   - `delta = -item.quantity`
   - `qty_before`, `qty_after`
   - `staff_id` from `staffCtx`

5. **Keep the `inventory_reservations` insertion** — the soft reservation record is
   still written; its status will transition from `'reserved'` to `'deducted'` at
   fulfillment time (no change needed there).

**Function `cancel()` — specific changes:**

1. **Restore `inventory.quantity` for CONFIRMED orders** — for each line item where
   `qtyReserved > 0` AND the order was in a confirmed state, issue:
   `UPDATE inventory SET quantity = quantity + $qty WHERE book_id = $id AND location_id = $loc`
   inside the same transaction.

2. **Write `inventory_history` record per restored line** with:
   - `movement_type = 'stock_in'`
   - `reference_type = 'order_cancelled'`
   - `reference_id = orderId`
   - `delta = +item.qtyReserved`
   - `qty_before`, `qty_after`

3. **Fail the cancellation if any restoration UPDATE affects 0 rows** — throw a
   `ConflictError` and let the transaction roll back.

4. **Resolve `locationId` the same way `confirm()` does** — use `resolveLocationId()`.

**Function `fulfill()` — specific changes:**

1. **Skip the `UPDATE inventory` deduction step** — since stock was already deducted at
   confirmation, `fulfill()` must NOT deduct again. Remove (or skip with a guard) the
   `UPDATE inventory SET quantity = $qtyAfter …` statement inside the fulfillment loop.

2. **Keep the `inventory_history` insert** — fulfillment still writes a history record
   (with `reference_type = 'order'` as before), but with `delta = 0` or, better, simply
   remove the deduction and keep the `qty_fulfilled` update and reservation-status update.
   Alternatively, write the history record referencing the fulfillment event without
   changing stock. The simplest approach: skip the history write too, since the movement
   was already recorded at confirmation. Either way, `qty_fulfilled` update and
   reservation `'deducted'` status update remain.

   **Decision**: Keep the `UPDATE order_line_items SET qty_fulfilled = qty_fulfilled + $1`
   and `inventory_reservations` status update. Remove the `inventory` quantity deduction
   and its accompanying `inventory_history` insert from the fulfillment loop, since the
   stock was already moved at confirmation and the history record was written there.

#### File: `apps/web/src/pages/OrdersPage.tsx`

In `actionMut.onSuccess`, additionally invalidate the `'inventory'` query cache key so
that the inventory page reflects the updated stock counts after confirm/cancel:

```ts
onSuccess: () => {
  qc.invalidateQueries({ queryKey: ['orders-list'] });
  qc.invalidateQueries({ queryKey: ['inventory'] });
  showToast('Order updated', 'success');
  setCancelingId(null);
  setCancelReason('');
},
```

---

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, write exploratory tests against
the **unfixed** code to surface the bug, then verify fix correctness and preservation.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix.
Confirm the root cause: missing `UPDATE inventory` and missing row-lock in `confirm()`.

**Test Plan**: Mock the database client, simulate DRAFT→CONFIRMED transitions, and
assert that `inventory.quantity` is lower after confirmation. Run on unfixed code to
see the assertion fail (stock unchanged).

**Test Cases**:

1. **Basic deduction test**: Order 2 units of Book 1 (stock = 5). Confirm the order.
   Assert `inventory.quantity = 3`. (fails on unfixed code — stock stays 5)
2. **Concurrent oversell test**: Stock = 3. Two concurrent confirmations each for
   3 units. Assert that exactly one succeeds and the other gets `INSUFFICIENT_STOCK`.
   (fails on unfixed code — both succeed)
3. **History record test**: Confirm an order. Assert `inventory_history` row exists with
   `reference_type = 'order_confirmed'`. (fails on unfixed code — no row)
4. **Cancel restoration test**: Confirm then cancel. Assert stock is back to original.
   (fails on unfixed code — stock never changed)

**Expected Counterexamples**:
- `inventory.quantity` is unchanged after confirmation (missing UPDATE).
- Both concurrent confirmations succeed despite combined quantity exceeding stock.

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function
produces the expected behavior.

**Pseudocode:**

```
FOR ALL X WHERE isBugCondition(X) DO
  qtyBefore := getInventory(X.bookId, X.locationId).quantity
  confirm'(X.orderId)
  qtyAfter  := getInventory(X.bookId, X.locationId).quantity
  ASSERT qtyAfter = qtyBefore - X.requestedQuantity
  ASSERT qtyAfter >= 0
  ASSERT inventoryHistoryExists(X.orderId, 'order_confirmed')
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed
functions produce the same results as before.

**Pseudocode:**

```
FOR ALL X WHERE NOT isBugCondition(X) DO
  qtyBefore := getInventory(X.bookId, X.locationId).quantity
  performAction'(X)
  qtyAfter  := getInventory(X.bookId, X.locationId).quantity
  IF X.action IN ('create_draft', 'cancel_draft') THEN
    ASSERT qtyAfter = qtyBefore   // no inventory change for draft paths
  END IF
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation because it
generates many random order/inventory configurations automatically and ensures no
edge case slips through.

**Test Cases**:

1. **Draft creation preservation**: Create order in DRAFT — stock unchanged.
2. **Draft cancellation preservation**: Cancel DRAFT order — stock unchanged.
3. **Fulfill-after-confirm no double deduct**: Confirm then fulfill — stock deducted
   exactly once (at confirmation), fulfillment does NOT deduct again.
4. **POS path preservation**: POS service tests continue to pass unmodified.
5. **FULFILLED/COMPLETED cancel guard**: Cancelling a fulfilled order still returns
   `ORDER_ALREADY_FULFILLED`.

### Unit Tests

- `confirm()` deducts stock atomically for single-item and multi-item orders.
- `confirm()` rejects entire order with `INSUFFICIENT_STOCK` if any item has
  insufficient stock (no partial deduction).
- `confirm()` writes `inventory_history` records with `reference_type = 'order_confirmed'`.
- `cancel()` (CONFIRMED) restores stock for every previously-deducted line item.
- `cancel()` (DRAFT) does not touch inventory.
- `cancel()` (FULFILLED) still raises `ORDER_ALREADY_FULFILLED`.
- `fulfill()` does NOT double-deduct inventory.
- Concurrent confirmations for the same book/location: only one succeeds.
- `inventory.quantity` never goes below 0.
- Multi-item orders: all items deducted or none (atomicity on failure).
- Cross-branch: deduction is scoped to the correct branch/location.

### Property-Based Tests

- For any order with N items each of quantity Q_i, after confirmation
  `inventory.quantity` decreases by exactly Q_i for each item.
- For any confirmed-then-cancelled order, net change to `inventory.quantity` is 0.
- For any non-DRAFT-to-CONFIRMED transition, `inventory.quantity` is unchanged
  compared to the same transition on unfixed code (preservation property).

### Integration Tests

- Full lifecycle: create → confirm (inventory deducted) → fulfill (no double deduct)
  → completed.
- Create → confirm → cancel: inventory restored to pre-confirm level.
- Concurrent confirm race: only the first wins when stock is exactly equal to one
  order's demand.
- `inventory_history` audit trail is complete after each step.
- Frontend TanStack Query cache invalidation: after confirm/cancel, inventory query
  is re-fetched.
