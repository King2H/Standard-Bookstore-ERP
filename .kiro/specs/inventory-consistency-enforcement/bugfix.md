# Bugfix Requirements Document

## Introduction

The bookstore ERP system suffers from systemic inventory inconsistency across all modules
(POS, Orders, Procurement, Returns, Exchanges, Inventory, Dashboard, and Reports). Each
module currently modifies `inventory.quantity` using its own ad-hoc logic, with no shared
accounting pipeline. The result is a fragmented system where the inventory count visible in
one module can silently diverge from counts shown in another, overselling is possible both
through the POS and the Orders module, location boundaries are not strictly enforced at the
point of deduction, reservation logic is incomplete or bypassed, audit records are missing
for several movement types, and dashboards and reports can display stale or incorrect totals.

This document captures what is currently broken, what the correct behavior must be, and
what existing correct behavior must not be disturbed. The fix must be fully transactional,
enforce a strict single source of truth across every consumer of inventory data, prevent
negative stock, scope every movement to the correct location, and maintain a complete audit
trail via `inventory_history`.

---

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN any module (POS, Orders, Procurement, Returns, Exchanges) needs to update stock
    THEN each module executes its own `UPDATE inventory SET quantity = ...` directly,
    with no shared service or consistent pre-/post-condition checks, making it impossible
    to enforce uniform rules across all inventory movements.

1.2 WHEN the POS module sells books and `isNegativeStockAllowed()` returns false
    THEN the stock check reads `inventory.quantity` without accounting for active soft
    reservations from pending orders, allowing the POS to sell stock that is already
    reserved for a confirmed order at the same location.

1.3 WHEN the Orders module confirms an order and stock is insufficient for any line item
    THEN the system previously marked lines `is_backordered = true` and still confirmed
    the order (the bug has since been partially fixed, but no shared pipeline validates
    the same constraint for POS and other modules consistently).

1.4 WHEN a POS transaction is processed for a book at one location (e.g., Main Shop with
    quantity = 5) while another location (e.g., Main Store) holds additional stock
    THEN the system does not enforce location-level isolation — historical paths existed
    where cross-location totals were used for availability checks instead of the
    specific `location_id` that the cashier is working from.

1.5 WHEN an order moves through its lifecycle (DRAFT → CONFIRMED → FULFILLED → CANCELLED)
    THEN the inventory impact is inconsistent:
    — DRAFT creation has no inventory impact (correct)
    — CONFIRMED deducts stock (recently fixed), but no centralized service enforces this
    — FULFILLED previously double-deducted stock (recently fixed), but only in the orders path
    — CANCELLED after CONFIRMED restores stock via a direct UPDATE, not a shared service

1.6 WHEN the Orders module confirms an order for a book at a location
    THEN the reservation check computes `available = quantity - SUM(reserved)` but does
    NOT prevent a simultaneous POS sale from spending the same units before the reservation
    is recorded, because the POS module's stock check ignores `inventory_reservations`.

1.7 WHEN `inventory_reservations` is queried to compute available stock for an order
    THEN only `status = 'reserved'` rows are considered, but the POS path reads raw
    `inventory.quantity` without subtracting any active reservations, creating a window
    where POS and Orders can both consume the same units.

1.8 WHEN any inventory movement occurs (POS sale, order confirmation, order cancellation,
    procurement receipt, return, exchange)
    THEN the `inventory_history` record written (if any) uses inconsistent field values:
    — some paths omit `reference_type` entirely
    — `movement_type` values do not match across modules for semantically identical actions
    — `staff_id` is sometimes omitted or defaulted incorrectly

1.9 WHEN a user searches for a book
    THEN the system does not display per-location breakdown of Available Quantity,
    Reserved Quantity, Damaged Quantity, and Sellable Quantity; only raw `quantity` is
    exposed, making it impossible for staff to know the true sellable stock at their
    location.

1.10 WHEN the Dashboard loads KPI tiles (Total Stock Value, Available Stock, Reserved
     Stock, Low Stock, Sales, Returns, Refunds, Gross Profit, Net Profit)
     THEN the values are computed from stale or partial data, because modules update
     inventory directly without broadcasting changes that the dashboard can observe
     consistently; Reserved Stock KPI does not account for all active reservations.

1.11 WHEN an Excel inventory report is generated (Book, Location, Opening Stock, Stock In,
     Stock Out, Reserved, Returned, Damaged, Closing Stock columns)
     THEN the `Reserved` and `Damaged` columns are missing or incorrect because
     `inventory_reservations` and `inventory.damaged_quantity` are not consistently
     populated by all modules.

1.12 WHEN a procurement receipt is processed (PO → `receivePO`)
     THEN the stock-in is performed inline within `procurement.service.ts` rather than
     through a shared inventory transaction service, so no consistent post-receipt
     notification (low-stock clearance, dashboard refresh) is guaranteed.

1.13 WHEN a return is processed (`createReturn` in `returns.service.ts`)
     THEN the stock is restored directly via `UPDATE inventory SET quantity = quantity + $1`
     with no call to a shared service, bypassing any future cross-cutting concerns (e.g.,
     location validation, notification hooks).

1.14 WHEN an exchange is settled (`settleExchange`) and items are of type `returned` with
     condition `resellable`
     THEN the stock update is performed inline in `exchanges.service.ts` using direct SQL,
     not through a centralized service, so any new enforcement rule added to a central
     service would not cover exchange movements.

1.15 WHEN concurrent POS transactions attempt to sell the last unit of a book at the same
     location
     THEN the `FOR UPDATE` row lock is present in the POS path but the optimistic locking
     `version` field check is skipped (POS uses `GREATEST(0, quantity - N)` directly),
     allowing the version to advance without the caller ever seeing a `VERSION_CONFLICT`
     error — making the optimistic locking field unreliable as a concurrency indicator.

1.16 WHEN `stockOut` is called from the Inventory module (via `/inventory/stock-out` API)
     THEN the availability check reads raw `inventory.quantity` directly without calling
     `getAvailableStock()`, so it does NOT subtract active reservations from confirmed
     orders. This means `stockOut` can consume stock that is already reserved, creating
     the same overselling window as the POS path.

1.17 WHEN `stockIn` or `stockOut` is called, both functions require the caller to pass a
     `version` number and perform their own `SELECT FOR UPDATE` + `UPDATE inventory`
     inline, duplicating the locking and mutation logic that should live only in the
     centralized `InventoryTransactionService`. Any new cross-cutting enforcement added
     to the central service (e.g., reservation awareness) would not automatically apply
     to these paths.

1.18 WHEN `adjustStock` writes an `inventory_history` record
     THEN the `reference_type` and `reference_id` fields are always `null` because the
     function never accepts or passes those values — making adjustments untraceable when
     a downstream consumer (e.g., a report) needs to link an adjustment to a source
     document.

1.19 WHEN `transferStock` writes two `inventory_history` records (transfer_out /
     transfer_in)
     THEN both records omit `reference_type` and `reference_id` entirely, and the source
     location's available stock is computed from raw `quantity` without subtracting active
     reservations — so a transfer can move stock that is already soft-reserved for a
     confirmed order at the source location.

---

### Expected Behavior (Correct)

2.1 WHEN any module (POS, Orders, Procurement, Returns, Exchanges) needs to update
    `inventory.quantity`
    THEN the system SHALL route all mutations through a single centralized
    `InventoryTransactionService`, which is the only code path permitted to write
    `UPDATE inventory SET quantity = ...`. Direct updates from individual module
    services SHALL be replaced by calls to this service.

2.2 WHEN the centralized service is asked to deduct stock for any reason (POS sale,
    order confirmation, exchange outgoing item)
    THEN the system SHALL validate `available_quantity >= requested_quantity` with a
    row-level `SELECT FOR UPDATE` lock held, and SHALL reject the operation with
    `BusinessError('INSUFFICIENT_STOCK', 'Insufficient stock for book X at location Y.
    Available: A Requested: B')` when the condition is not met.

2.3 WHEN available stock is computed for any deduction check
    THEN the system SHALL compute `available = inventory.quantity - SUM(active reserved
    quantity from inventory_reservations WHERE status = 'reserved')` for that
    `(book_id, location_id)` pair, so that POS, Orders, and all other consumers
    see the same sellable quantity.

2.4 WHEN the POS module processes a sale at a given `location_id`
    THEN the system SHALL deduct inventory only for that specific `location_id`, using
    `available = quantity - active_reservations` at that location, and SHALL NOT use
    stock from any other location or branch to satisfy the transaction.

2.5 WHEN an order transitions DRAFT → CONFIRMED
    THEN the system SHALL (within one transaction): (a) acquire `SELECT FOR UPDATE` on
    each inventory row, (b) compute `available = quantity - active_reservations`, (c)
    reject the entire confirmation with `INSUFFICIENT_STOCK` if any line is short,
    (d) deduct `inventory.quantity` for each line, (e) insert an `inventory_reservations`
    row with `status = 'reserved'`, (f) write an `inventory_history` record with
    `movement_type = 'stock_out'` and `reference_type = 'order_confirmed'`.

2.6 WHEN an order transitions CONFIRMED → FULFILLED
    THEN the system SHALL NOT deduct `inventory.quantity` again (stock was already
    deducted at confirmation), SHALL update `qty_fulfilled` on line items, and SHALL
    transition `inventory_reservations.status` from `'reserved'` to `'deducted'`.

2.7 WHEN a CONFIRMED (or PAID) order is cancelled
    THEN the system SHALL restore `inventory.quantity` for each line item where
    `qty_reserved > 0` within one transaction, and SHALL write an `inventory_history`
    record with `movement_type = 'stock_in'` and `reference_type = 'order_cancelled'`.

2.8 WHEN a DRAFT order is cancelled
    THEN the system SHALL leave `inventory.quantity` unchanged and SHALL NOT write any
    `inventory_history` record for inventory (no stock was deducted).

2.9 WHEN a POS sale is voided
    THEN the system SHALL restore `inventory.quantity` at the correct `location_id` via
    the centralized service, and SHALL write an `inventory_history` record with
    `movement_type = 'stock_in'` and `reference_type = 'void'`.

2.10 WHEN a return is processed (`createReturn`)
     THEN the system SHALL increase `inventory.quantity` at the transaction's
     `location_id` via the centralized service, and SHALL write an `inventory_history`
     record with `movement_type = 'stock_in'` and `reference_type = 'pos_return'`.

2.11 WHEN a procurement receipt is processed (`receivePO`)
     THEN the system SHALL increase `inventory.quantity` at the receiving `location_id`
     via the centralized service, and SHALL write an `inventory_history` record with
     `movement_type = 'stock_in'` and `reference_type = 'purchase_order'`.

2.12 WHEN an exchange settlement processes returned items with condition `resellable`
     THEN the system SHALL increase `inventory.quantity` at the exchange's `location_id`
     via the centralized service with `reference_type = 'exchange_in'`.

2.13 WHEN an exchange settlement processes outgoing (new) items
     THEN the system SHALL decrease `inventory.quantity` at the exchange's `location_id`
     via the centralized service, using the same availability check as other deductions,
     with `reference_type = 'exchange_out'`.

2.14 WHEN any inventory movement is recorded
     THEN the system SHALL persist an `inventory_history` row with fields: `book_id`,
     `location_id`, `qty_before`, `qty_after`, `delta`, `movement_type`, `reason_code`,
     `reference_type`, `reference_id`, and `staff_id` — none of these fields SHALL be
     null except where the DB schema permits it.

2.15 WHEN a user searches for a book (catalog or inventory search)
     THEN the system SHALL return per-location stock breakdown showing: Available
     Quantity (`quantity - active_reservations`), Reserved Quantity
     (`SUM(active_reservations)`), Damaged Quantity (`damaged_quantity`), and Sellable
     Quantity (`quantity - active_reservations - damaged_quantity`, floored at 0).

2.16 WHEN the Dashboard loads KPI tiles
     THEN Total Stock Value, Available Stock, and Reserved Stock SHALL be computed from
     live `inventory` and `inventory_reservations` data; all other KPI tiles (Sales,
     Returns, Refunds, Gross Profit, Net Profit) SHALL reflect committed transactions
     and SHALL update immediately after any relevant inventory or financial event.

2.17 WHEN an Excel inventory report is generated
     THEN every row SHALL include accurate values for: Book, Location, Opening Stock
     (from earliest `inventory_history` delta for the period), Stock In (sum of positive
     `inventory_history` deltas), Stock Out (sum of negative deltas), Reserved
     (`SUM(active inventory_reservations)` at report time), Returned (sum of
     `inventory_history` rows with `reference_type = 'pos_return'`), Damaged
     (`inventory.damaged_quantity`), and Closing Stock (`inventory.quantity`).

2.18 WHEN the centralized service processes a deduction and the `version` field
     would advance without the caller's optimistic lock token matching
     THEN the system SHALL throw `ConflictError('VERSION_CONFLICT', ...)` so that callers
     that pass a version can detect concurrent modifications; callers that do not pass a
     version (POS, Orders — internal service-to-service calls) SHALL use `SELECT FOR
     UPDATE` as the sole concurrency control mechanism.

2.19 WHEN `stockOut` is called via the Inventory module API
     THEN the system SHALL compute available stock using
     `available = inventory.quantity - SUM(active_reservations)` (the same formula used
     by the centralized service), so that manual stock-out operations cannot consume
     stock already reserved by confirmed orders.

2.20 WHEN `stockIn`, `stockOut`, `adjustStock`, and `transferStock` in the Inventory
     module need to mutate `inventory.quantity`
     THEN they SHALL delegate the actual `UPDATE inventory SET quantity = ...` to the
     centralized `InventoryTransactionService` rather than executing it inline, so that
     all cross-cutting enforcement (reservation checks, history field completeness,
     notification hooks) is applied consistently regardless of call path.

2.21 WHEN `adjustStock` writes an `inventory_history` record
     THEN the system SHALL accept an optional `referenceType` and `referenceId` in its
     input and persist them to `inventory_history`, so that adjustments triggered by
     external events (e.g., damage during procurement) can be traced back to a source.

2.22 WHEN `transferStock` is called
     THEN the system SHALL validate that
     `source_available = inventory.quantity - SUM(active_reservations at source location)`
     is >= the requested transfer quantity before deducting from the source, and SHALL
     reject with `INSUFFICIENT_STOCK` if reserved stock would be transferred away.
     Both `transfer_out` and `transfer_in` history records SHALL include `reference_type`
     (e.g., `'transfer'`) and a shared `reference_id` (e.g., a generated transfer batch
     ID) so the paired movements are traceable.

---

### Unchanged Behavior (Regression Prevention)

3.1 WHEN a DRAFT order is created
    THEN the system SHALL CONTINUE TO leave `inventory.quantity` unchanged (draft orders
    must have zero inventory impact).

3.2 WHEN an order's `status` is `FULFILLED` or `COMPLETED` and a cancellation is
    attempted
    THEN the system SHALL CONTINUE TO reject the request with `ORDER_ALREADY_FULFILLED`.

3.3 WHEN a POS transaction is created with a valid payment sum matching the grand total
    THEN the system SHALL CONTINUE TO complete the sale atomically, recording the
    transaction, line items, payments, inventory deduction, and audit log in one
    database transaction.

3.4 WHEN `adjustStock` or `transferStock` is called from the Inventory module
    THEN the system SHALL CONTINUE TO use optimistic locking (version check), enforce
    negative-stock policy, write history records, and emit outbox events exactly as
    before — these functions are not replaced by the centralized service but may be
    delegated to it internally.

3.5 WHEN `stockIn` or `stockOut` is called directly via the `/inventory/stock-in` or
    `/inventory/stock-out` API endpoints
    THEN the system SHALL CONTINUE TO accept the same request shape and return the same
    `InventoryRow` response, with the same authorization requirements, unchanged.

3.6 WHEN the `inventory_reservations` table does not exist (migration 33 not yet applied
    to a given environment)
    THEN the system SHALL CONTINUE TO degrade gracefully by omitting reservation-aware
    availability checks and falling back to raw `inventory.quantity` for the availability
    check.

3.7 WHEN a return is rejected via `rejectReturn`
    THEN the system SHALL CONTINUE TO leave `inventory.quantity` unchanged (rejected
    returns do not modify stock).

3.8 WHEN `isNegativeStockAllowed()` returns `true` (system config)
    THEN the system SHALL CONTINUE TO allow stock to go to 0 (clamped at 0 in the DB)
    without rejecting the transaction, maintaining existing negative-stock policy
    override behavior for environments that have enabled it.

3.9 WHEN a POS credit sale or partial-payment sale is completed
    THEN the system SHALL CONTINUE TO create the receivable record, update
    `store_credit_accounts`, emit loyalty accrual events, and record `audit_logs`
    exactly as before — the inventory change must not affect payment flow.

3.10 WHEN procurement, returns, or exchanges write to `inventory_history`
     THEN the `reference_type` values used (`purchase_order`, `pos_return`,
     `exchange_in`, `exchange_out`, `exchange_damaged`) SHALL CONTINUE TO be accepted
     by the existing DB CHECK constraint (no migration is needed for these values —
     they are already whitelisted in migration 1700000037).

3.11 WHEN an exchange is cancelled before settlement
     THEN the system SHALL CONTINUE TO reject the cancellation with `ALREADY_COMPLETED`
     or `EXCHANGE_NOT_CANCELLABLE` for exchanges in terminal lifecycle states, and
     SHALL NOT attempt to reverse any inventory that was not yet modified.

3.12 WHEN the low-stock notification outbox events (`inventory.low_stock`,
     `inventory.out_of_stock`) are triggered after an inventory deduction
     THEN the system SHALL CONTINUE TO emit these events non-fatally (failure of the
     notification path must never roll back the inventory transaction).

3.13 WHEN `stockIn` is called via the `/inventory/stock-in` API endpoint with a
     `version` parameter
     THEN the system SHALL CONTINUE TO require the caller to provide the current version
     and SHALL throw `VERSION_CONFLICT` if the version has changed, maintaining the
     existing optimistic-locking contract for direct API callers.

3.14 WHEN `stockOut` is called via the `/inventory/stock-out` API endpoint
     THEN the system SHALL CONTINUE TO accept the same request shape, enforce the
     negative-stock policy, and return the same `InventoryRow` response — only the
     internal availability check is strengthened to include reservations.

3.15 WHEN `adjustStock` is called with `reasonCode` values (`damage`, `loss`, `return`,
     `correction`) and a valid `version`
     THEN the system SHALL CONTINUE TO enforce optimistic locking, validate the reason
     code, reject zero-delta requests, and write an `inventory_history` record with
     `movement_type = 'adjustment'` — the addition of optional `referenceType` /
     `referenceId` fields SHALL be backward-compatible (both default to null).

3.16 WHEN `transferStock` is called with both locations in the same branch
     THEN the system SHALL CONTINUE TO enforce same-branch validation, use deadlock-safe
     lock ordering (lower location_id first), write paired history rows for the source
     and destination, and emit the `inventory.transfer_completed` outbox event
     non-fatally.

---

## Bug Condition (Formal)

### Bug Condition Function

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type InventoryMutation
  OUTPUT: boolean

  // Bug fires when any module mutates inventory.quantity directly
  // instead of going through the centralized InventoryTransactionService
  RETURN X.caller IN (
    'pos.service.createTransaction',
    'orders.service.confirm',
    'orders.service.cancel',
    'orders.service.fulfill',
    'procurement.service.receivePO',
    'returns.service.createReturn',
    'exchanges.service.createExchange',
    'exchanges.service.settleExchange'
  )
  AND X.usedCentralizedService = false
END FUNCTION
```

### Fix Checking Property

```pascal
// Property: All Mutations Route Through Centralized Service
FOR ALL X WHERE isBugCondition(X) DO
  inventoryBefore ← getInventoryQuantity(X.bookId, X.locationId)
  performAction'(X)    // fixed version with centralized service
  inventoryAfter  ← getInventoryQuantity(X.bookId, X.locationId)

  // Stock deduction rules
  IF X.mutationType = 'deduction' THEN
    ASSERT inventoryAfter = inventoryBefore - X.requestedQuantity
    ASSERT inventoryAfter >= 0
    ASSERT inventoryHistoryRecordExists(X.referenceId, X.referenceType)
  END IF

  // Stock increase rules
  IF X.mutationType = 'addition' THEN
    ASSERT inventoryAfter = inventoryBefore + X.quantity
    ASSERT inventoryHistoryRecordExists(X.referenceId, X.referenceType)
  END IF

  // Availability check uses reservation-aware quantity
  IF X.mutationType = 'deduction' THEN
    available ← inventoryBefore - getActiveReservations(X.bookId, X.locationId)
    ASSERT available >= X.requestedQuantity  // otherwise INSUFFICIENT_STOCK was thrown
  END IF
END FOR
```

### Preservation Checking Property

```pascal
// Property: Non-Inventory Behaviors Unchanged
FOR ALL X WHERE NOT isBugCondition(X) DO
  stateBefore ← captureSystemState(X)
  performAction'(X)
  stateAfter  ← captureSystemState(X)

  // DRAFT orders have no inventory impact
  IF X.orderStatus = 'DRAFT' THEN
    ASSERT stateAfter.inventoryQuantity = stateBefore.inventoryQuantity
  END IF

  // Payment flow unaffected
  IF X.action = 'pos_sale' THEN
    ASSERT stateAfter.transactionRecord EXISTS
    ASSERT stateAfter.paymentRecord EXISTS
    ASSERT stateAfter.auditLog EXISTS
  END IF

  // Optimistic locking unchanged for direct inventory API calls
  IF X.action IN ('adjustStock', 'transferStock') THEN
    ASSERT F(X) = F'(X)   // same result as before
  END IF
END FOR
```
