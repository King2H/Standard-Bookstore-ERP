# Order Inventory Sync — Implementation Tasks

## Tasks

- [x] 1. Add migration to extend `inventory_history.reference_type` constraint
  - [x] 1.1 Create `apps/api/src/db/migrations/1700000037_order_inventory_history_reason.cjs` that drops and re-adds the `inventory_history_reference_type_check` constraint, adding `'order_confirmed'` and `'order_cancelled'` to the allowed values list alongside all existing values.
  - [x] 1.2 Include a `down` function that reverts the constraint to the previous allowed values.

- [x] 2. Fix `confirm()` in `orders.service.ts` — deduct inventory atomically
  - [x] 2.1 Add `SELECT … FOR UPDATE` on each `inventory` row per line item (inside the open transaction) before the available-stock check, replacing the current non-locking read.
  - [x] 2.2 Replace the backorder-on-low-stock path with a hard `BusinessError('INSUFFICIENT_STOCK', …)` rejection so the entire transaction rolls back when any line item has insufficient stock.
  - [x] 2.3 Add `UPDATE inventory SET quantity = quantity - $qty … WHERE book_id = $id AND location_id = $loc` for each line item inside the transaction, after the stock check passes.
  - [x] 2.4 Insert an `inventory_history` record per deducted line item with `movement_type = 'stock_out'`, `reference_type = 'order_confirmed'`, `reference_id = orderId`, correct `delta`, `qty_before`, `qty_after`, and `staff_id`.
  - [x] 2.5 Keep the existing `inventory_reservations` insertion unchanged (status `'reserved'`).

- [x] 3. Fix `cancel()` in `orders.service.ts` — restore inventory for CONFIRMED orders
  - [x] 3.1 After confirming the order was in a CONFIRMED-family status, resolve `locationId` using `resolveLocationId()` (same helper used in `confirm()`).
  - [x] 3.2 For each line item where `qtyReserved > 0`, issue `UPDATE inventory SET quantity = quantity + $qty WHERE book_id = $id AND location_id = $loc` inside the same cancellation transaction.
  - [x] 3.3 Insert an `inventory_history` record per restored line item with `movement_type = 'stock_in'`, `reference_type = 'order_cancelled'`, `reference_id = orderId`, correct `delta`, `qty_before`, `qty_after`, and `staff_id`.
  - [x] 3.4 If any inventory restoration UPDATE affects 0 rows, throw a `ConflictError` so the transaction rolls back (fail-safe).
  - [x] 3.5 Keep the existing `inventory_reservations` status update (`'released'`) unchanged, guarded with the same try/catch for graceful degradation.

- [x] 4. Fix `fulfill()` in `orders.service.ts` — prevent double-deduction
  - [x] 4.1 Remove (or skip) the `UPDATE inventory SET quantity = $qtyAfter …` statement from the fulfillment loop — stock was already deducted at confirmation.
  - [x] 4.2 Remove (or skip) the `inventory_history` insert from the fulfillment loop that recorded the `stock_out` movement — that movement is now recorded at confirmation.
  - [x] 4.3 Keep the `UPDATE order_line_items SET qty_fulfilled = qty_fulfilled + $1, qty_reserved = 0` statement unchanged.
  - [x] 4.4 Keep the `inventory_reservations` status transition to `'deducted'` unchanged.

- [x] 5. Frontend cache invalidation in `OrdersPage.tsx`
  - [x] 5.1 In `actionMut.onSuccess`, add `qc.invalidateQueries({ queryKey: ['inventory'] })` so the inventory page refreshes after confirm/cancel actions.

- [ ] 6. Write automated tests
  - [x] 6.1 Set up test file at `apps/api/src/modules/orders/__tests__/orders-inventory.test.ts` with a mock `db` pool/client.
  - [x] 6.2 Test: DRAFT order creation does not change `inventory.quantity`.
  - [x] 6.3 Test: Confirming an order deducts `inventory.quantity` by the requested quantity.
  - [x] 6.4 Test: Confirming an order writes `inventory_history` records with `reference_type = 'order_confirmed'`.
  - [x] 6.5 Test: Confirming an order where stock is insufficient (any item) rejects with `INSUFFICIENT_STOCK` and leaves inventory unchanged (atomicity).
  - [x] 6.6 Test: Cancelling a CONFIRMED order restores `inventory.quantity` and writes `inventory_history` records with `reference_type = 'order_cancelled'`.
  - [x] 6.7 Test: Cancelling a DRAFT order does not change `inventory.quantity`.
  - [x] 6.8 Test: Cancelling a FULFILLED order still raises `ORDER_ALREADY_FULFILLED`.
  - [x] 6.9 Test: Fulfilling a CONFIRMED order does NOT deduct `inventory.quantity` again (no double-deduct).
  - [x] 6.10 Test: Multi-item order — all items deducted on confirmation; if one fails the whole transaction rolls back.
  - [x] 6.11 Test: Concurrent confirmations for the same book/location — only the first succeeds; the second receives `INSUFFICIENT_STOCK`.
  - [x] 6.12 Test: `inventory.quantity` never goes below 0 (negative stock prevention).
  - [x] 6.13 Test: Cross-branch isolation — confirming an order in branch A does not affect inventory in branch B.
