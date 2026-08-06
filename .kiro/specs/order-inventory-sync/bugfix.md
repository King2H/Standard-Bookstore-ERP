# Bugfix Requirements Document

## Introduction

The Order module does not correctly synchronize inventory when orders are approved (confirmed).
When an order transitions from `DRAFT` to `CONFIRMED`, the system creates a soft reservation
in `inventory_reservations` but does **not** deduct the actual quantity from the `inventory`
table. Inventory is only deducted later during fulfillment (`FULFILLED` status), which means
a `CONFIRMED` order that is never fulfilled leaves stock apparently available — and concurrent
approvals can oversell the same units. Symmetrically, cancelling a `CONFIRMED` order releases
the soft reservation but restores no actual stock (because none was deducted). This causes
inconsistencies across inventory, orders, dashboard, reporting, procurement, and future profit
calculations. The fix must be fully transactional, enforce no-negative-stock, provide a
complete audit trail, and handle concurrent approvals safely.

---

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN an order transitions from `DRAFT` to `CONFIRMED` (`POST /orders/:id/confirm`)
    THEN the system records a soft reservation in `inventory_reservations` but does NOT
    deduct `inventory.quantity`, leaving stock counts unchanged.

1.2 WHEN an order is `CONFIRMED` and the approval loop encounters a book whose
    requested quantity exceeds available stock
    THEN the system marks the line as backordered (`is_backordered = true`) but still
    confirms the order without rejecting it or preventing approval.

1.3 WHEN a `CONFIRMED` order is cancelled (`POST /orders/:id/cancel`)
    THEN the system releases the soft reservation (`inventory_reservations.status = 'released'`)
    but does NOT restore `inventory.quantity`, because no deduction ever occurred —
    creating a silent no-op that gives the appearance of a restoration without one.

1.4 WHEN two concurrent requests attempt to confirm orders for the same book at the same
    location simultaneously
    THEN the system performs no row-level locking on `inventory` during the confirm step,
    allowing both approvals to succeed even when combined demand exceeds available stock.

1.5 WHEN any single inventory update in a multi-item order approval fails mid-loop
    THEN the system may partially deduct inventory for some line items while leaving
    others unchanged, resulting in an inconsistent inventory state.

1.6 WHEN an order is confirmed or cancelled
    THEN the system does NOT write a corresponding record to `inventory_history`, so
    no audit trail exists for inventory movements caused by orders.

### Expected Behavior (Correct)

2.1 WHEN an order transitions from `DRAFT` to `CONFIRMED`
    THEN the system SHALL immediately deduct `inventory.quantity` for every non-backordered
    line item within the same database transaction, using `SELECT … FOR UPDATE` row-locking
    to prevent concurrent oversell.

2.2 WHEN an order is being confirmed and the requested quantity for any line item exceeds
    available stock (with row-level lock held)
    THEN the system SHALL reject the entire confirmation with a meaningful error
    (`INSUFFICIENT_STOCK`) identifying the book and available quantity, and SHALL NOT
    modify inventory or order status.

2.3 WHEN a `CONFIRMED` order is cancelled
    THEN the system SHALL restore `inventory.quantity` for every previously-deducted line
    item within the same database transaction, and the cancellation SHALL fail (rollback)
    if any inventory restoration update fails.

2.4 WHEN two concurrent requests attempt to confirm orders for the same book at the same
    location simultaneously
    THEN the system SHALL use `SELECT … FOR UPDATE` (or equivalent row locking) inside
    the transaction so that only one approval proceeds; the other SHALL receive a
    conflict or insufficient-stock error rather than succeeding silently.

2.5 WHEN any single inventory update in a multi-item order approval or cancellation fails
    THEN the system SHALL roll back the entire transaction so that inventory, order status,
    line items, and audit records are all left unchanged (atomicity guarantee).

2.6 WHEN inventory is deducted on order confirmation or restored on order cancellation
    THEN the system SHALL insert a corresponding `inventory_history` record containing:
    timestamp, staff ID, branch ID, order number, book ID, quantity delta, quantity before,
    quantity after, and action type (`order_confirmed` / `order_cancelled`).

### Unchanged Behavior (Regression Prevention)

3.1 WHEN an order is in `DRAFT` status and has not been confirmed
    THEN the system SHALL CONTINUE TO leave `inventory.quantity` unchanged (draft orders
    must not affect inventory).

3.2 WHEN a `DRAFT` order is cancelled (before confirmation)
    THEN the system SHALL CONTINUE TO leave `inventory.quantity` unchanged (no stock was
    deducted, so no restoration is needed).

3.3 WHEN a `FULFILLED` or `COMPLETED` order is cancelled
    THEN the system SHALL CONTINUE TO reject the cancellation with `ORDER_ALREADY_FULFILLED`
    (no change to this guard).

3.4 WHEN an order is fulfilled (`POST /orders/:id/fulfill`)
    THEN the system SHALL CONTINUE TO deduct `inventory.quantity` only for the
    `qty_reserved` portion of each line item as it currently does, since deduction will
    now have already occurred at confirmation time (fulfillment deducts the reservation,
    not the full quantity again).

3.5 WHEN stock is adjusted, transferred, or received via procurement
    THEN the system SHALL CONTINUE TO use the existing `adjustStock`, `transferStock`,
    and `stockIn` / `stockOut` functions unchanged.

3.6 WHEN the `inventory_reservations` table does not exist (migration 33 not yet applied)
    THEN the system SHALL CONTINUE TO degrade gracefully, applying inventory deductions
    directly without reservation records.

3.7 WHEN a POS sale is processed
    THEN the system SHALL CONTINUE TO follow the existing POS inventory deduction path
    unchanged.

3.8 WHEN `inventory.quantity` would become negative as a result of an order confirmation
    THEN the system SHALL CONTINUE TO enforce the `inventory_quantity_nonneg` DB constraint
    and the application-level `INSUFFICIENT_STOCK` check, preventing negative stock.

---

## Bug Condition (Formal)

### Bug Condition Function

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type OrderTransition
  OUTPUT: boolean

  // Bug fires when an order moves to CONFIRMED status
  RETURN X.toStatus = 'CONFIRMED'
     AND X.fromStatus = 'DRAFT'
END FUNCTION
```

### Fix Checking Property

```pascal
// Property: Inventory Deducted on Confirmation
FOR ALL X WHERE isBugCondition(X) DO
  inventoryBefore ← getInventoryQuantity(X.bookId, X.locationId)
  confirm'(X.orderId)
  inventoryAfter  ← getInventoryQuantity(X.bookId, X.locationId)
  ASSERT inventoryAfter = inventoryBefore - X.requestedQuantity
  ASSERT inventoryAfter >= 0
  ASSERT inventoryHistoryRecordExists(X.orderId, 'order_confirmed')
END FOR
```

### Preservation Checking Property

```pascal
// Property: Draft and Fulfilled Orders Unchanged
FOR ALL X WHERE NOT isBugCondition(X) DO
  inventoryBefore ← getInventoryQuantity(X.bookId, X.locationId)
  performAction'(X)
  inventoryAfter  ← getInventoryQuantity(X.bookId, X.locationId)
  // For DRAFT creation, DRAFT cancellation: no change
  IF X.toStatus IN ('DRAFT', 'CANCELLED_FROM_DRAFT') THEN
    ASSERT inventoryAfter = inventoryBefore
  END IF
END FOR
```
