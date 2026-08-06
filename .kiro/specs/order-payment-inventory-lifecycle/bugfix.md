# Bugfix Requirements Document

## Introduction

The bookstore ERP has three partially-complete specs that each fixed a slice of the
Order–Payment–Inventory lifecycle in isolation:

- `inventory-consistency-enforcement` — centralised all inventory mutations through
  `inventoryTransactions.service.ts` (tasks 1–11, 13–18 complete; task 12 partial).
- `order-inventory-sync` — fixed confirm/cancel inventory deduction and restoration
  (tasks 1–5 complete; task 6 tests mostly written).
- `order-payment-unification` — added `sale_type`, receivable creation at confirmation,
  and discount engine wiring (tasks 1–6 complete; task 5 payments-service hook and
  task 7 tests incomplete).

Despite those individual fixes, a **cross-cutting production blocker** remains: the
lifecycle table that governs how Order status, payment status, inventory reservation
state, and receivable state interact is wrong in two critical ways:

1. **PAID is treated as a prerequisite for FULFILLED** — the existing code blocks
   delivery unless the order is fully paid, which is a business-logic error. CREDIT
   and PARTIALLY_PAID orders must be deliverable; payment collection must be able
   to continue after fulfillment.

2. **No module consistently reads from `inventoryTransactions.service.ts` as its single
   source of truth** — several direct inventory mutations remain scattered across POS,
   Orders, Returns, Exchanges, Receivables, and Dashboard that must be removed.

This document captures the complete correct lifecycle, all defects that deviate from it,
and the behavior that must be preserved.

---

## Bug Analysis

### Current Behavior (Defect)

**Section 1 — Incorrect Lifecycle Gate: FULFILLED requires PAID**

1.1 WHEN an order has `payment_status = 'unpaid'` or `payment_status = 'partially_paid'`
    (i.e. a CREDIT or PARTIALLY_PAID order that has been confirmed)
    THEN the system blocks the FULFILL action, treating full payment as a prerequisite
    for delivery, which prevents CREDIT customers from receiving goods before full
    settlement.

1.2 WHEN an order is FULFILLED while `payment_status` is `'unpaid'` or `'partially_paid'`
    THEN the system incorrectly marks the receivable as settled or stops accepting
    further payment collections, even though the outstanding balance is still due.

1.3 WHEN a CREDIT order (`sale_type = 'credit_sale'`) has been FULFILLED and an
    outstanding balance remains
    THEN the Payment module does not display a "Collect" action for that order,
    preventing Finance from collecting the balance after delivery.

1.4 WHEN a CREDIT order has been FULFILLED and `outstanding_balance > 0`
    THEN `payments.service.createPayment()` rejects the payment with an error or
    silently does nothing, rather than recording the collection and reducing the
    receivable balance.

**Section 2 — Incorrect Fulfillment: Stock Restored on Fulfill (Regression Risk)**

2.1 WHEN the fulfill path executes
    THEN any remaining code path that calls `inventoryTransactions.service.stockIn` or
    issues a direct `UPDATE inventory SET quantity = quantity + N` during fulfillment
    MUST be removed; fulfillment MUST NOT restore stock under any conditions.

2.2 WHEN an order is FULFILLED
    THEN the system does not atomically: (a) release the reserved quantity, (b) mark
    it as fulfilled (transition `inventory_reservations.status` from `'reserved'` to
    `'deducted'`), (c) keep inventory permanently deducted, and (d) write a single
    authoritative `inventory_history` row — all via `inventoryTransactions.service.ts`.

**Section 3 — Incorrect Cancellation Guard**

3.1 WHEN a FULFILLED order's cancellation is attempted
    THEN the system does not consistently enforce the prohibition; some code paths allow
    the cancel to proceed, which would incorrectly restore stock on a delivered order.

3.2 WHEN a CONFIRMED, PARTIALLY_PAID, or PAID order is cancelled
    THEN the cancellation does not atomically: release the reservation, restore
    inventory, AND reverse any open receivable entries — all three must happen or none.

**Section 4 — Payment Module Does Not Read Authoritative State**

4.1 WHEN the Payment module renders the list of orders with outstanding balances
    THEN it maintains its own independent query of order states rather than reading
    `order.status`, `payment_status`, and `outstanding_balance` from the authoritative
    data source, causing CASH orders to appear in the Pending Payments list.

4.2 WHEN `payment_status = 'paid'` is set on an order
    THEN the Payment module displays "Void Payment" even after the order is FULFILLED,
    which must be blocked (voiding is only valid before fulfillment).

4.3 WHEN an order has `sale_type = 'cash_sale'`
    THEN the Payment module must not show a "Collect" action or list this order as
    pending payment, but currently it may appear due to incorrect filtering.

**Section 5 — Return Workflow Does Not Adjust Receivables for CREDIT Orders**

5.1 WHEN a return is processed for a CREDIT order after fulfillment
    THEN `returns.service.createReturn` increases inventory via
    `inventoryTransactions.service.ts` but does NOT update the receivable balance,
    leaving the outstanding amount higher than the net amount owed.

**Section 6 — Exchange Workflow Not Executed as a Single Transaction**

6.1 WHEN an exchange is processed
    THEN the return sub-transaction, new sale sub-transaction, and receivable adjustment
    are not guaranteed to execute inside a single database transaction, risking partial
    state if any step fails mid-way.

**Section 7 — Remaining Direct Inventory Mutations**

7.1 WHEN Orders, POS, Returns, Exchanges, Receivables, or Dashboard modules need to
    read or write inventory quantities
    THEN some of these modules still perform direct `SELECT` or `UPDATE` on the
    `inventory` table outside of `inventoryTransactions.service.ts`, violating the
    single-source-of-truth rule.

7.2 WHEN Dashboard KPI tiles (Available Stock, Reserved Stock, Total Stock Value)
    or inventory reports are generated
    THEN the values may be computed from stale or partial data because not all modules
    broadcast changes through `inventoryTransactions.service.ts`, resulting in
    inconsistent stock figures across Inventory, POS, Orders, and Dashboard.

**Section 8 — Hard Consistency Constraints Currently Violated**

8.1 WHEN concurrent order confirmations, POS sales, or stock adjustments execute
    simultaneously on the same `(book_id, location_id)` pair
    THEN the system does not consistently use `SELECT ... FOR UPDATE` within a
    database transaction for all of: confirm, fulfill, cancel, payment collection,
    return, exchange, and transfer — leaving windows where negative stock or negative
    available stock can occur.

8.2 WHEN a DRAFT order is present
    THEN the Payment module may allow a "Collect" action for that order, which must
    be prevented — payment collection on DRAFT orders is forbidden.

**Section 9 — CASH Payment Mode Incorrectly Creates Receivables**

9.1 WHEN an order is created with `sale_type = 'cash_sale'`
    THEN the system currently sets `payment_status = 'unpaid'` and creates a receivable
    for the full order total, incorrectly treating a cash sale as a credit transaction.
    CASH orders must be paid immediately at confirmation — `payment_status = 'paid'` with
    NO receivable created.

9.2 WHEN `computeOrderAllowedActions()` evaluates whether FULFILL is an allowed action
    THEN the system currently gates fulfillment on `payment_status = 'paid'`, blocking
    delivery for CREDIT and PARTIALLY_PAID orders. This check MUST be removed — the
    allowed statuses for the FULFILL action are CONFIRMED, PARTIALLY_PAID, and PAID.

---

### Expected Behavior (Correct)

**Section 2 — Correct Lifecycle per Order Status**

2.1 WHEN an order is in DRAFT status
    THEN the system SHALL leave inventory unchanged, SHALL NOT create a reservation,
    SHALL NOT create a receivable, and SHALL NOT allow delivery.

2.2 WHEN an order transitions to CONFIRMED
    THEN the system SHALL (via `inventoryTransactions.service.ts`, inside one DB
    transaction): (a) deduct `inventory.quantity` for each line item, (b) insert
    `inventory_reservations` rows with `status = 'reserved'`, (c) write
    `inventory_history` records with `reference_type = 'order_confirmed'`, and (d)
    create a receivable only for CREDIT orders — CASH orders do NOT create a receivable
    because payment is collected immediately at point of sale.

2.3 WHEN an order is CONFIRMED with `sale_type = 'cash_sale'`
    THEN `payment_status` SHALL be `'paid'` immediately (payment collected at
    confirmation), NO receivable SHALL be created, and the order SHALL be deliverable.
    CASH orders MUST NEVER appear in the Pending Payments list.

2.4 WHEN an order is CONFIRMED with `sale_type = 'credit_sale'`
    THEN `payment_status` SHALL be `'unpaid'`, a receivable SHALL be created for the
    full order total, and the order SHALL be deliverable (delivery is NOT blocked by
    payment status — fulfillment is a logistics event, not a payment event).

2.5 WHEN an order has `payment_status = 'partially_paid'`
    THEN the reservation SHALL remain active, inventory SHALL remain reduced, the
    receivable SHALL remain active with the remaining balance, and delivery SHALL be
    allowed.

2.6 WHEN an order has `payment_status = 'paid'`
    THEN the reservation SHALL remain active, inventory SHALL remain reduced, the
    receivable SHALL be settled, and delivery SHALL be allowed.

2.7 WHEN an order transitions to FULFILLED (allowed from CONFIRMED, PARTIALLY_PAID, or
    PAID status — fulfillment is a logistics event and MUST NOT be gated on payment status)
    THEN the system SHALL call `inventoryTransactions.service.ts` to: (a) release the
    reserved quantity, (b) transition `inventory_reservations.status` from `'reserved'`
    to `'deducted'`, (c) keep inventory permanently deducted (no stock restoration),
    and (d) write an `inventory_history` row with `reference_type = 'order_fulfilled'`
    (this value MUST be added to the DB CHECK constraint via migration).
    The system SHALL NOT restore stock at any point during fulfillment.

2.8 WHEN a CASH order is FULFILLED
    THEN there SHALL be no receivable (CASH orders never create receivables — payment
    was collected at confirmation time, `payment_status = 'paid'`).

2.9 WHEN a CREDIT order is FULFILLED and outstanding balance > 0
    THEN the receivable SHALL remain active with the outstanding balance, and the
    Payment module SHALL allow further payment collection until the balance reaches 0.
    Fulfillment MUST NOT settle or modify the receivable.

2.10 WHEN a PARTIALLY_PAID order (CREDIT order with partial upfront payment) is
     FULFILLED and outstanding balance > 0
     THEN the receivable SHALL remain active with the remaining balance, and the
     Payment module SHALL continue to allow payment collection until the balance
     reaches 0. Fulfillment MUST NOT settle or modify the receivable.

2.11 WHEN a CANCELLED order was previously in CONFIRMED, PARTIALLY_PAID, or PAID status
     THEN the system SHALL atomically (inside one DB transaction with
     `SELECT ... FOR UPDATE`): (a) release the reservation (delete or mark `'released'`
     in `inventory_reservations`), (b) restore `inventory.quantity` via
     `inventoryTransactions.service.ts` with `reference_type = 'order_cancelled'`, and
     (c) reverse any open receivable entries (set `outstanding_amount = 0`, `status =
     'Settled'`). If any of the three steps fails, the entire cancellation SHALL roll
     back.

2.12 WHEN a FULFILLED order's cancellation is attempted
     THEN the system SHALL reject it with `ORDER_ALREADY_FULFILLED`. Cancellation after
     fulfillment is forbidden; the Return workflow must be used instead.

2.13 WHEN a DRAFT order is cancelled
     THEN the system SHALL leave inventory, reservations, and receivables unchanged.

**Section 3 — Payment Mode Rules**

3.1 WHEN an order is created with `sale_type = 'cash_sale'`
    THEN payment is collected immediately at confirmation. `payment_status` SHALL be
    `'paid'` from the moment the order is CONFIRMED. No receivable SHALL be created.
    CASH orders MUST NEVER appear in the Pending Payments list.

3.2 WHEN an order is created with `sale_type = 'credit_sale'`
    THEN no immediate payment is required. A receivable SHALL be created at
    confirmation. `payment_status` SHALL be `'unpaid'`. Outstanding balance SHALL
    equal the order total. The order SHALL be deliverable without any payment.

3.3 WHEN a partial payment is recorded against a CREDIT order
    THEN the receivable balance SHALL be updated, `payment_status` SHALL become
    `'partially_paid'`, and the order SHALL remain deliverable.

3.4 WHEN the final payment is recorded against any CREDIT order
    THEN `payment_status` SHALL transition to `'paid'` and the receivable SHALL be
    settled (`outstanding_amount = 0`, `status = 'Settled'`).

**Section 4 — Payment Module Correct Behavior**

4.1 WHEN the Payment module lists orders with outstanding balances
    THEN it SHALL read `order.status`, `payment_status`, and `outstanding_balance`
    exclusively from the authoritative data source and SHALL NOT maintain any
    independent order state.

4.2 WHEN the Payment module renders action buttons for an order
    THEN the "Collect" button SHALL appear only for CREDIT orders where
    `outstanding_balance > 0` (including FULFILLED CREDIT orders with outstanding
    balance).

4.3 WHEN the Payment module renders action buttons for an order
    THEN "Void Payment" SHALL appear only before the order is FULFILLED.

4.4 WHEN the Payment module lists pending orders
    THEN CASH orders (`sale_type = 'cash_sale'`) SHALL NOT appear in the pending
    payments list.

4.5 WHEN a DRAFT order is present
    THEN the Payment module SHALL NOT allow payment collection on it.

4.6 WHEN `payments.service.createPayment()` is called for a CREDIT order that has been
    FULFILLED and has `outstanding_balance > 0`
    THEN the system SHALL accept the payment, reduce the receivable balance, and if
    the balance reaches 0, set `payment_status = 'paid'`.

**Section 5 — Return Workflow**

5.1 WHEN a return is processed after fulfillment
    THEN the system SHALL route all stock restoration through
    `inventoryTransactions.service.ts`. The disposition flag determines the outcome:
    - `disposition = 'SELLABLE'`: call `stockIn` with `reference_type = 'pos_return'`
      or `'order_return'` as appropriate — stock is restored to sellable quantity.
    - `disposition = 'DAMAGED'`: call `stockIn` with `reference_type = 'pos_return'`
      or `'order_return'` and set `movement_type = 'stock_in'`; the item is tracked
      under `inventory.damaged_quantity` and NOT added back to sellable stock.

5.2 WHEN a return is processed for a CREDIT order after fulfillment
    THEN the system SHALL also adjust the receivable balance to reflect the returned
    amount: reduce `outstanding_amount` if still unpaid, or issue a refund/store credit
    if the order is already fully paid.

5.3 WHEN a return is processed
    THEN a refund or customer credit SHALL be created according to the original payment
    mode: cash refund for CASH orders, store credit or receivable reduction for CREDIT
    orders.

**Section 6 — Exchange Workflow**

6.1 WHEN an exchange is processed
    THEN the return sub-transaction, new sale sub-transaction, and receivable adjustment
    SHALL all execute inside a single database transaction so that partial failure leaves
    no inconsistent state.

**Section 7 — Single Source of Truth**

7.1 WHEN any module (Orders, POS, Returns, Exchanges, Receivables, Dashboard) needs to
    read available stock or calculate reserved quantities
    THEN it SHALL use `inventoryTransactions.service.ts` as the sole authority; no
    module SHALL issue direct `UPDATE inventory SET quantity = ...` statements.

7.2 WHEN Dashboard KPI tiles (Available Stock, Reserved Stock, Total Stock Value) or
    inventory reports are generated
    THEN all values SHALL be derived from `inventoryTransactions.service.ts` and the
    live `inventory` + `inventory_reservations` tables, producing identical figures
    across Inventory, POS, Orders, Dashboard, and Reports.

**Section 8 — Hard Consistency Constraints**

8.1 WHEN any of: confirm, fulfill, cancel, payment collection, return, exchange, or
    transfer executes
    THEN the system SHALL use a database transaction with `SELECT ... FOR UPDATE` on
    the affected `inventory` rows to prevent concurrent operations from producing
    negative stock or negative available stock.

8.2 WHEN any inventory deduction is attempted and `available_quantity < requested_quantity`
    THEN the system SHALL reject the operation with `INSUFFICIENT_STOCK` without
    modifying any row.

---

### Unchanged Behavior (Regression Prevention)

3.1 WHEN a DRAFT order is created
    THEN the system SHALL CONTINUE TO leave `inventory.quantity` unchanged.

3.2 WHEN an order's `status` is `FULFILLED` and a cancellation is attempted
    THEN the system SHALL CONTINUE TO reject it with `ORDER_ALREADY_FULFILLED`.

3.3 WHEN a POS transaction is completed with full payment
    THEN the system SHALL CONTINUE TO process the sale atomically, writing transaction,
    line items, payments, inventory deduction, and audit log in one DB transaction.

3.4 WHEN a POS credit sale is completed
    THEN the system SHALL CONTINUE TO create a receivable with
    `source_type = 'pos_credit_sale'`, update store credit accounts, and emit loyalty
    accrual events.

3.5 WHEN `adjustStock` or `transferStock` is called from the Inventory module API
    THEN the system SHALL CONTINUE TO use optimistic locking (version check), enforce
    the negative-stock policy, write history records, and emit outbox events exactly
    as currently implemented.

3.6 WHEN `stockIn` or `stockOut` is called via the `/inventory/stock-in` or
    `/inventory/stock-out` API endpoints
    THEN the system SHALL CONTINUE TO accept the same request shape and return the same
    `InventoryRow` response, with the same authorization requirements.

3.7 WHEN the `inventory_reservations` table does not exist (migration 33 not yet applied)
    THEN the system SHALL CONTINUE TO degrade gracefully by falling back to raw
    `inventory.quantity` for availability checks.

3.8 WHEN `isNegativeStockAllowed()` returns `true` (system config)
    THEN the system SHALL CONTINUE TO allow stock to go to 0 (clamped at 0 in the DB)
    without rejecting the transaction.

3.9 WHEN a return is rejected via `rejectReturn`
    THEN the system SHALL CONTINUE TO leave `inventory.quantity` unchanged.

3.10 WHEN procurement, returns, or exchanges write to `inventory_history`
     THEN the `reference_type` values (`purchase_order`, `pos_return`, `exchange_in`,
     `exchange_out`, `exchange_damaged`) SHALL CONTINUE TO be accepted by the existing
     DB CHECK constraint. The value `'order_fulfilled'` MUST be added to this constraint
     via a new migration (it is required by requirement 2.7 and is not currently present).

3.11 WHEN an exchange is cancelled before settlement
     THEN the system SHALL CONTINUE TO reject it with `ALREADY_COMPLETED` or
     `EXCHANGE_NOT_CANCELLABLE` for terminal lifecycle states.

3.12 WHEN inventory-related outbox events (`inventory.low_stock`, `inventory.out_of_stock`)
     are triggered after a deduction
     THEN the system SHALL CONTINUE TO emit them non-fatally (notification failure must
     not roll back the inventory transaction).

3.13 WHEN `orders.service.confirm()` is called
     THEN the system SHALL CONTINUE TO enforce hard stock rejection (`INSUFFICIENT_STOCK`)
     for any line item with insufficient available inventory.

3.14 WHEN an order is created without discount fields
     THEN the system SHALL CONTINUE TO accept `discountAmount` as a plain override,
     defaulting `discountType = 'Normal'` and `discountMode = 'Amount'`.

3.15 WHEN `payments.service.createPayment()` is called for an order that has no
     associated `order_credit_sale` receivable
     THEN the system SHALL CONTINUE TO record the payment and update `payment_status`
     without error.

3.16 WHEN `computeOrderAllowedActions()` is called for an order
     THEN FULFILLED status SHALL be permitted for orders in CONFIRMED, PARTIALLY_PAID,
     and PAID status. The `fulfill` action MUST NOT be gated on `payment_status = 'paid'`.
     The Payment module's `computeAllowedActions()` MUST NOT show "Collect" for DRAFT
     orders or CASH orders, and MUST NOT show "Void Payment" for FULFILLED orders.

---

## Bug Condition (Formal)

### Bug Condition Function

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type OrderLifecycleAction
  OUTPUT: boolean

  // Bug fires under any of these five conditions:

  // C1: Fulfillment blocked by payment status (delivery not a payment event)
  IF X.action = 'fulfill'
    AND X.order.status IN ('CONFIRMED', 'PARTIALLY_PAID')
    AND system blocks fulfillment due to payment_status
  THEN RETURN true

  // C2: Payment collection blocked after fulfillment for CREDIT orders
  IF X.action = 'collect_payment'
    AND X.order.status = 'FULFILLED'
    AND X.order.outstanding_balance > 0
    AND system rejects or omits the collection
  THEN RETURN true

  // C3: Cancellation after fulfillment not blocked (must be forbidden)
  IF X.action = 'cancel'
    AND X.order.status = 'FULFILLED'
    AND system allows the cancellation
  THEN RETURN true

  // C4: Cancellation is not fully atomic (partial rollback leaves inventory or
  //     receivable in inconsistent state)
  IF X.action = 'cancel'
    AND X.order.status IN ('CONFIRMED', 'PARTIALLY_PAID', 'PAID')
    AND NOT (inventoryRestored AND reservationReleased AND receivableReversed)
  THEN RETURN true

  // C5: Any module mutates inventory.quantity outside inventoryTransactions.service.ts
  IF X.action IN ('fulfill', 'cancel', 'return', 'exchange', 'pos_sale', 'dashboard_read')
    AND X.usedCentralizedService = false
    AND X.mutatesInventory = true
  THEN RETURN true

  RETURN false
END FUNCTION
```

### Fix Checking Property — C1: Fulfill Allowed Without Full Payment

```pascal
// Property: CONFIRMED and PARTIALLY_PAID orders can be fulfilled
FOR ALL X WHERE X.action = 'fulfill'
             AND X.order.status IN ('CONFIRMED', 'PARTIALLY_PAID', 'PAID') DO
  result ← fulfill'(X.orderId)
  ASSERT result.order.status = 'FULFILLED'
  ASSERT inventoryTransactions.reservationStatus(X.orderId) = 'deducted'
  ASSERT inventory.quantity unchanged after fulfill (no second deduction)
  ASSERT result.receivable.status unchanged (outstanding balance preserved)
END FOR
```

### Fix Checking Property — C2: Payment Collection After Fulfillment

```pascal
// Property: CREDIT orders accept payment after FULFILLED
FOR ALL X WHERE X.action = 'collect_payment'
             AND X.order.status = 'FULFILLED'
             AND X.order.sale_type = 'credit_sale'
             AND X.order.outstanding_balance > 0 DO
  result ← createPayment'(X)
  newOutstanding ← X.order.outstanding_balance - X.payment.amount
  ASSERT result.receivable.outstanding_amount = MAX(0, newOutstanding)
  IF newOutstanding <= 0 THEN
    ASSERT result.order.payment_status = 'paid'
    ASSERT result.receivable.status = 'Settled'
  ELSE
    ASSERT result.order.payment_status = 'partially_paid'
  END IF
END FOR
```

### Fix Checking Property — C3: Cancellation Forbidden After Fulfillment

```pascal
// Property: FULFILLED orders cannot be cancelled
FOR ALL X WHERE X.action = 'cancel'
             AND X.order.status = 'FULFILLED' DO
  ASSERT cancel'(X.orderId) THROWS BusinessError('ORDER_ALREADY_FULFILLED')
  ASSERT inventory.quantity unchanged
  ASSERT receivable.outstanding_amount unchanged
END FOR
```

### Fix Checking Property — C4: Atomic Cancellation

```pascal
// Property: Cancellation is fully atomic for pre-fulfillment orders
FOR ALL X WHERE X.action = 'cancel'
             AND X.order.status IN ('CONFIRMED', 'PARTIALLY_PAID', 'PAID') DO
  inventoryBefore ← getInventoryQuantity(X.bookId, X.locationId)
  cancel'(X.orderId)
  inventoryAfter ← getInventoryQuantity(X.bookId, X.locationId)
  ASSERT inventoryAfter = inventoryBefore + X.order.totalReservedQty
  ASSERT NOT EXISTS active reservation for X.orderId
  ASSERT receivable.outstanding_amount = 0 OR receivable does not exist
  ASSERT inventoryHistoryRecordExists(X.orderId, 'order_cancelled')
END FOR
```

### Fix Checking Property — C5: Single Source of Truth

```pascal
// Property: All inventory mutations route through inventoryTransactions.service.ts
FOR ALL X WHERE X.mutatesInventory = true DO
  ASSERT X.usedCentralizedService = true
  // Same as isBugCondition from inventory-consistency-enforcement spec
END FOR
```

### Preservation Checking Property

```pascal
// Property: Non-buggy paths produce identical results before and after the fix
FOR ALL X WHERE NOT isBugCondition(X) DO
  stateBefore ← captureSystemState(X)
  performAction'(X)
  stateAfter  ← captureSystemState(X)

  // DRAFT orders: no inventory impact
  IF X.order.status = 'DRAFT' THEN
    ASSERT stateAfter.inventoryQuantity = stateBefore.inventoryQuantity
  END IF

  // Fulfilled orders: inventory permanently deducted, no restoration
  IF X.action = 'fulfill' THEN
    ASSERT stateAfter.inventoryQuantity = stateBefore.inventoryQuantity  // no change at fulfill
    ASSERT stateAfter.reservationStatus = 'deducted'
  END IF

  // POS cash sales: transaction + payments + inventory all recorded atomically
  IF X.action = 'pos_cash_sale' THEN
    ASSERT stateAfter.transactionRecord EXISTS
    ASSERT stateAfter.paymentRecord EXISTS
    ASSERT stateAfter.inventoryDeducted = true
  END IF
END FOR
```

---

## Lifecycle Reference Table

| Order Status    | Reservation               | Inventory Available  | Receivable                                           | Delivery Allowed |
|-----------------|---------------------------|----------------------|------------------------------------------------------|------------------|
| DRAFT           | No                        | Unchanged            | No                                                   | No               |
| CONFIRMED       | Yes (`status='reserved'`) | Reduced              | CREDIT only (CASH = none, `payment_status = 'paid'`) | Yes              |
| PARTIALLY_PAID  | Yes (`status='reserved'`) | Reduced              | Active (remaining balance)                           | Yes              |
| PAID            | Yes (`status='reserved'`) | Reduced              | Settled                                              | Yes              |
| FULFILLED       | Released → `'deducted'`   | Permanently deducted | May remain for CREDIT / PARTIALLY_PAID outstanding   | Already delivered|
| CANCELLED       | Released (`'released'`)   | Restored             | Reversed if not yet fulfilled                        | No               |
