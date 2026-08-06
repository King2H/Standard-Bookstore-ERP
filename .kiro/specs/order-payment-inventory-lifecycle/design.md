
# Order–Payment–Inventory Lifecycle Bugfix Design

## Overview

Three partially-complete specs (`inventory-consistency-enforcement`, `order-inventory-sync`,
`order-payment-unification`) each resolved an isolated slice of the lifecycle. Despite that
work, a **cross-cutting production blocker** remains: the system incorrectly gates the
FULFILL action on `payment_status = 'paid'`, preventing delivery of CREDIT and PARTIALLY_PAID
orders; post-fulfillment payment collection for CREDIT orders is silently blocked; fulfilled
orders can be cancelled in some code paths; return dispositions are undifferentiated; and
exchange atomicity is not guaranteed.

This design formalises the complete correct lifecycle state machine, documents what is already
done (and must be preserved), and specifies exactly what must be built to close the remaining
gaps. The central architectural constraint is unchanged: **`inventoryTransactions.service.ts`
is the only permitted writer of `UPDATE inventory SET quantity = ...`**.

---

## Glossary

- **Bug_Condition (C)**: Any of the five conditions C1–C5 that cause the lifecycle to
  deviate from the correct state machine (see Bug Details).
- **Property (P)**: The desired correct behavior for inputs where C holds.
- **Preservation**: All behaviors — POS, procurement, adjustments, optimistic locking,
  returns, exchanges, loyalty, store credit, receivables — that must remain byte-for-byte
  identical after the fix.
- **`inventoryTransactions.service.ts`**: The single source of truth for all
  `inventory.quantity` mutations. Located at
  `apps/api/src/modules/inventory/inventoryTransaction.service.ts`.
- **`fulfillReservation()`**: New method to be added to `inventoryTransactions.service.ts`
  that atomically transitions `inventory_reservations.status` from `'reserved'` to
  `'deducted'` and writes an `inventory_history` row with
  `reference_type = 'order_fulfilled'`. Does NOT change `inventory.quantity` (stock was
  already deducted at `confirm()`).
- **`computeOrderAllowedActions()`**: Pure function in `orders.service.ts` that returns the
  list of permitted actions for a given order state. Currently gates `fulfill` on
  `payment_status = 'paid'` for cash sales; this gate must be removed (see C1 below).
- **`sale_type`**: Column on `orders` — `'cash_sale'` | `'credit_sale'`. Already exists
  via migration 1700000038.
- **`order_credit_sale`**: Receivable `source_type` for confirmed CREDIT orders. Already
  exists in the receivables constraint.
- **`disposition`**: New flag on return line items — `'SELLABLE'` | `'DAMAGED'`. Controls
  whether returned stock is added back to sellable quantity or tracked under
  `inventory.damaged_quantity`.
- **CASH order**: `sale_type = 'cash_sale'`. Payment collected at confirmation;
  `payment_status = 'paid'` immediately. No receivable created.
- **CREDIT order**: `sale_type = 'credit_sale'`. Receivable created at confirmation;
  `payment_status = 'unpaid'`. Payment collected later, including after fulfillment.
- **PARTIAL order**: A CREDIT order that has received an upfront partial payment at
  confirmation. `payment_status = 'partially_paid'`. Receivable for remaining balance.
- **`available`**: The formula `inventory.quantity - SUM(inventory_reservations.quantity
  WHERE status = 'reserved')`, as already implemented in `getAvailableStock()`.

---

## Bug Details

### Bug Condition

Five distinct bug conditions share the common root: the lifecycle state machine is
inconsistently implemented across `orders.service.ts`, `payments.service.ts`,
`returns.service.ts`, `exchanges.service.ts`, and the frontend pages.

**Formal Specification:**

```
FUNCTION isBugCondition(X)
  INPUT: X of type OrderLifecycleAction
  OUTPUT: boolean

  // C1: Fulfillment blocked by payment status
  IF X.action = 'fulfill'
     AND X.order.status IN ('CONFIRMED', 'PARTIALLY_PAID')
     AND X.order.saleType = 'cash_sale'
     AND X.order.paymentStatus != 'paid'
  THEN RETURN true

  // C2: Post-fulfillment payment collection rejected for CREDIT orders
  IF X.action = 'collect_payment'
     AND X.order.status IN ('FULFILLED', 'COMPLETED')
     AND X.order.saleType = 'credit_sale'
     AND X.order.outstanding_balance > 0
     AND system rejects or does not show Collect button
  THEN RETURN true

  // C3: Cancellation of FULFILLED order not consistently blocked
  IF X.action = 'cancel'
     AND X.order.status IN ('FULFILLED', 'COMPLETED')
     AND system allows the cancellation
  THEN RETURN true

  // C4: Pre-fulfillment cancellation not fully atomic
  IF X.action = 'cancel'
     AND X.order.status IN ('CONFIRMED', 'PARTIALLY_PAID', 'PAID')
     AND NOT (inventoryRestored AND reservationReleased AND receivableReversed)
  THEN RETURN true

  // C5: Return disposition undifferentiated / CREDIT receivable not adjusted
  IF X.action = 'return'
     AND (disposition flag absent
          OR (X.order.saleType = 'credit_sale'
              AND receivable.outstanding_amount NOT reduced by returned value))
  THEN RETURN true

  RETURN false
END FUNCTION
```

### Examples

- **C1 — Confirm+Partial blocks deliver**: ORD-001 is `sale_type = 'credit_sale'`,
  `status = 'CONFIRMED'`, `payment_status = 'unpaid'`. Staff clicks Fulfill. Under the
  current `computeOrderAllowedActions()` CONFIRMED branch, `fulfill` is only returned for
  `isCreditSale` — so CASH CONFIRMED orders with `paymentStatus != 'paid'` have no
  `fulfill` action, and even the payment gate that exists for CASH is fragile. The
  `fulfill()` function itself also has a `cash_sale && !effectivelyPaid` guard that blocks
  delivery for cash orders not yet paid — correct for cash, but the `PARTIALLY_PAID` status
  is missing from the allowed set.

- **C2 — Post-fulfillment collect blocked**: ORD-002 is `sale_type = 'credit_sale'`,
  fulfilled. `payments.service.createPayment()` has an `EXCEEDS_ORDER_TOTAL` guard that
  checks `alreadyPaid + amount > orderTotal + 0.01`; for a fully-delivered unpaid order
  this guard passes correctly, but the order status check `if (order.status === 'Cancelled')`
  does not prevent payment — however the `listUnpaidOrders()` query only returns orders
  where `status != 'Cancelled'` and `payment_status IN ('unpaid','partial')`. After FULFILLED
  (which auto-transitions to COMPLETED in the current `fulfill()`) the order falls out of
  the unpaid-orders list because `status = 'COMPLETED'`. The "Collect" button therefore
  disappears even though the balance is still outstanding.

- **C3 — FULFILLED cancel sometimes proceeds**: `cancel()` blocks `['FULFILLED','COMPLETED']`
  with `ORDER_ALREADY_FULFILLED` — this guard is correct. However the `fulfill()` function
  currently auto-transitions to COMPLETED at the end, so orders that were fulfilled but not
  yet updated to COMPLETED in a race condition could slip through. More critically, the
  current design doc for `order-inventory-sync` describes fulfill as NOT deducting stock —
  but the actual `fulfill()` code does call `invTxSvc.stockOut()`. This means if `cancel()`
  were somehow reached after partial fulfillment it would restore stock that was legitimately
  deducted.

- **C4 — Cancellation not fully atomic**: The current `cancel()` in `orders.service.ts`
  only releases the `inventory_reservations` row (sets `status = 'released'`) but does NOT
  call `invTxSvc.stockIn()` to restore `inventory.quantity`. The comment says "stock was
  never deducted" — but that is the `order-inventory-sync` model where deduction happens at
  fulfillment. The **lifecycle decision for this spec** is that deduction happens at
  `confirm()`. The current `cancel()` therefore leaves inventory permanently deducted for
  cancelled confirmed orders.

- **C5 — Return without disposition**: `returns.service.createReturn()` always calls
  `invTxSvc.stockIn()` unconditionally, regardless of item condition. Damaged items
  incorrectly replenish sellable stock. For CREDIT orders the receivable balance is never
  reduced on return.

---

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors (must not be broken by this fix):**

- `confirm()` stock deduction via `invTxSvc.stockOut()` with `reference_type = 'order_confirmed'`
  and `SELECT ... FOR UPDATE` row lock — already working, must remain intact.
- `cancel()` receivable settlement via `updateReceivableOnPayment()` — already present as a
  savepoint-guarded block, must remain intact.
- POS `createTransaction()` — routes all inventory mutations through `invTxSvc`, loyalty
  accrual, store credit deduction, receivable creation for `pos_credit_sale` — must remain
  byte-for-byte identical.
- `payments.service.createPayment()` for non-fulfilled orders — payment recording,
  `payment_status` recomputation, auto-fulfill trigger for CASH orders, receivable sync —
  all existing paths must remain unchanged.
- `exchanges.service.ts` — `createExchange()`, `initiateExchange()`, `settleExchange()`,
  `approveExchange()`, `reviewExchange()`, `cancelExchange()` — all existing paths unaffected
  except the atomicity guarantee added to `settleExchange()` (same-transaction wrapping).
- `inventoryTransactions.service.ts` — `stockIn`, `stockOut`, `adjust`, `transfer`,
  `getAvailableStock`, `getStockQuantities`, `getBookAvailability` — all public APIs
  unchanged; only a new `fulfillReservation()` method is added.
- Optimistic locking (`version` field on `inventory`) — all existing callers continue to
  work.
- Graceful degradation when `inventory_reservations` table is absent — preserved throughout.
- `isNegativeStockAllowed()` config flag — respected by all deduction paths as before.
- Outbox events (`order.confirmed`, `order.cancelled`, `order.fulfilled`, `order.completed`,
  `inventory.low_stock`, `inventory.out_of_stock`) — must continue to be emitted on the
  same triggers as before.
- `computeOrderAllowedActions()` DRAFT, FULFILLED, COMPLETED, CANCELLED branches — no change.
- `orders.service.cancel()` block on FULFILLED/COMPLETED with `ORDER_ALREADY_FULFILLED` — preserved.
- `payments.service.listUnpaidOrders()` — must be updated (not just preserved) to include
  FULFILLED CREDIT orders with outstanding balance; existing POS credit sale rows continue
  to appear.
- `returns.service.rejectReturn()` — no inventory impact, unchanged.
- Migration constraint values `'order_confirmed'`, `'order_cancelled'`, `'transfer'`,
  `'exchange_in'`, `'exchange_out'` etc. — all existing allowed values remain in the
  constraint after migration 1700000039 adds `'order_fulfilled'`.

**Scope:**
All inputs where `isBugCondition(X) = false` — DRAFT creation, DRAFT cancellation, POS
flows, procurement, stock adjustments, transfers, non-CREDIT-order returns, exchanges that
do not involve CREDIT receivable adjustment — produce identical results before and after
this fix.

---

## Hypothesized Root Cause

### C1 — Fulfillment gated on payment status

In `computeOrderAllowedActions()`:
- The `'CONFIRMED'` branch returns `fulfill` only when `isCreditSale` is true, OR when
  `!isCreditSale && paymentStatus === 'paid'`. This means CASH CONFIRMED orders without
  payment show no fulfill button.
- The `'PARTIALLY_PAID'` status is not handled at all — it falls to the `default: []` branch,
  so no actions are available for partially-paid orders.
- In `fulfill()` itself, the `cash_sale && !effectivelyPaid` guard is correct but
  over-broad: it should only block CASH orders where payment has not been collected. CREDIT
  and PARTIALLY_PAID orders must always be fulfillable.

### C2 — Post-fulfillment collect missing

`fulfill()` auto-transitions to `COMPLETED` at the end. `listUnpaidOrders()` queries
`WHERE o.payment_status IN ('unpaid','partial') AND o.status != 'Cancelled'` — COMPLETED
orders satisfy the payment_status condition but the data shows them as COMPLETED, so
Finance can no longer find them. The fix requires including FULFILLED/COMPLETED orders
with outstanding balance in this query, and allowing `createPayment()` to accept orders
in those statuses.

### C3 — FULFILLED cancel guard

The guard exists but the `fulfill()` → `COMPLETED` auto-transition introduces a short
window. The fix ensures the guard covers both `FULFILLED` and `COMPLETED` (it already does
via `['FULFILLED','COMPLETED'].includes(ns)`), and adds the `'order_fulfilled'`
reference_type to the CHECK constraint via migration so `fulfillReservation()` can write
to `inventory_history`.

### C4 — Cancel not restoring inventory

The `cancel()` function releases the soft reservation but does NOT call `invTxSvc.stockIn()`
to restore `inventory.quantity`. The comment in the code says deduction happens at
`fulfill()` — but this is the old `order-inventory-sync` model. The **authoritative
decision** from the bugfix.md requirements (§2.2, §2.7, §2.11) and the lifecycle table is
that inventory is deducted at `confirm()` and restored at `cancel()`. The current `confirm()`
does call `invTxSvc.stockOut()`, so cancel must call `invTxSvc.stockIn()` with
`reference_type = 'order_cancelled'` for all CONFIRMED/PARTIALLY_PAID/PAID orders.

### C5 — Returns and exchanges

`returns.service.createReturn()` was built for POS returns (`pos_return` reference type) and
does not differentiate disposition. Order returns need a `disposition` flag and, for CREDIT
orders, a receivable balance adjustment. `exchanges.service.settleExchange()` processes
inventory changes and potentially creates receivables but each of these happens in a separate
transaction segment — a failure mid-way leaves partial state.

---

## Correctness Properties

Property 1: Bug Condition C1 — Fulfill Allowed for CONFIRMED, PARTIALLY_PAID, and PAID

_For any_ order where `order.status IN ('CONFIRMED', 'PARTIALLY_PAID', 'PAID')`, the fixed
`computeOrderAllowedActions()` SHALL return `'fulfill'` as an allowed action (subject to
the `PROCESS_PAYMENT` permission), regardless of `payment_status`. The fixed `fulfill()`
function SHALL NOT throw `INVALID_STATE` for CREDIT orders in CONFIRMED or PARTIALLY_PAID
status. For CASH orders, the fulfill action SHALL only be blocked when `payment_status !=
'paid'` AND `order.status = 'DRAFT'`; CONFIRMED CASH orders with `payment_status != 'paid'`
SHALL be fulfillable (the auto-fulfill path in `payments.service` handles most cases, but
manual fulfill must also be available once payment is collected).

**Validates: Requirements 2.4, 2.5, 2.6, 2.7, 9.2**

Property 2: Bug Condition C1 — Fulfillment Transitions Reservation to 'deducted'

_For any_ order transition to FULFILLED, the fixed `fulfill()` function SHALL call
`invTxSvc.fulfillReservation()` which: (a) transitions `inventory_reservations.status`
from `'reserved'` to `'deducted'`, (b) writes one `inventory_history` row per line item
with `reference_type = 'order_fulfilled'`, (c) does NOT change `inventory.quantity`
(already deducted at confirm), and (d) does NOT settle or modify any receivable.

**Validates: Requirements 2.7, 2.8, 2.9, 2.10**

Property 3: Bug Condition C2 — Payment Collection Accepted After Fulfillment

_For any_ call to `createPayment()` where `order.sale_type = 'credit_sale'` and
`order.status IN ('FULFILLED', 'COMPLETED')` and `outstanding_balance > 0`, the fixed
function SHALL: (a) accept the payment without error, (b) reduce the receivable
`outstanding_amount` by `payment.amount`, (c) if `outstanding_amount` reaches 0, set
`payment_status = 'paid'` and `receivable.status = 'Settled'`, (d) if partial, set
`payment_status = 'partially_paid'`. The Payments UI SHALL display a "Collect" button for
these orders.

**Validates: Requirements 1.3, 1.4, 4.2, 4.6**

Property 4: Bug Condition C3 — Cancellation Forbidden After Fulfillment

_For any_ call to `cancel()` where `normaliseStatus(order.status) IN ('FULFILLED',
'COMPLETED')`, the fixed function SHALL throw `BusinessError('ORDER_ALREADY_FULFILLED')`
before modifying any row. `inventory.quantity` and `receivable.outstanding_amount` SHALL
remain unchanged.

**Validates: Requirements 2.12, 3.2**

Property 5: Bug Condition C4 — Cancellation is Fully Atomic

_For any_ call to `cancel()` where `normaliseStatus(order.status) IN ('CONFIRMED',
'PARTIALLY_PAID', 'PAID')`, the fixed function SHALL atomically (within one DB transaction
with `SELECT ... FOR UPDATE`): (a) call `invTxSvc.stockIn()` with
`reference_type = 'order_cancelled'` to restore `inventory.quantity` for each line item
with `qtyReserved > 0`, (b) set `inventory_reservations.status = 'released'`, (c) call
`updateReceivableOnPayment()` with `newOutstandingAmount = 0, isFullySettled = true` if an
open `order_credit_sale` receivable exists. If any step fails, the entire transaction SHALL
roll back.

**Validates: Requirements 2.11, 3.2**

Property 6: Bug Condition C5 — Return Disposition Flag

_For any_ return where `disposition = 'SELLABLE'`, the fixed `createReturn()` SHALL call
`invTxSvc.stockIn()` with the existing `pos_return` or `order_return` reference type,
restoring `inventory.quantity`. For `disposition = 'DAMAGED'`, the fixed function SHALL
NOT call `stockIn()` for sellable quantity; instead it SHALL update
`inventory.damaged_quantity` directly and write an `inventory_history` record. For CREDIT
orders, the fixed `createReturn()` SHALL additionally call `updateReceivableOnPayment()`
to reduce the receivable balance by the returned amount.

**Validates: Requirements 5.1, 5.2**

Property 7: Preservation — Non-Buggy Paths Unchanged

_For any_ input where `isBugCondition(X) = false` — DRAFT creation, DRAFT cancellation,
POS flows, procurement, stock adjustments, transfers, CASH order returns, POS returns,
non-CREDIT exchange settlement — the fixed code SHALL produce exactly the same result as
the original code: same HTTP response shape, same DB rows written for non-inventory tables,
same outbox events emitted, same error codes thrown.

**Validates: Requirements 3.1–3.16**

---

## Fix Implementation

### Architecture Decision: Deduction Model

**CONFIRMED = deduct inventory.** Based on the requirements in `bugfix.md` (§2.2, §2.11)
and the lifecycle table, the authoritative model is:

| Event        | `inventory.quantity` | `inventory_reservations` |
|--------------|---------------------|--------------------------|
| CONFIRMED    | Reduced (deducted)  | `status = 'reserved'`    |
| FULFILLED    | Unchanged           | `status = 'deducted'`    |
| CANCELLED    | Restored            | `status = 'released'`    |

The current `confirm()` already calls `invTxSvc.stockOut()`. The current `fulfill()`
incorrectly also calls `invTxSvc.stockOut()` (double-deduction). The current `cancel()`
only releases the reservation without restoring inventory. These must be fixed.

### Changes Required

---

#### Migration: `apps/api/src/db/migrations/1700000039_order_fulfilled_reference_type.cjs`

Extend the `inventory_history_reference_type_check` constraint to include `'order_fulfilled'`.
The current constraint (from migration 1700000037) allows:
`purchase_order`, `return`, `adjustment`, `manual`, `initial_stock`, `sale`, `void`,
`pos_return`, `order`, `exchange_in`, `exchange_out`, `exchange_damaged`,
`order_confirmed`, `order_cancelled`.

Add `'order_fulfilled'` to this list.

```sql
ALTER TABLE inventory_history
  DROP CONSTRAINT IF EXISTS inventory_history_reference_type_check;
ALTER TABLE inventory_history
  ADD CONSTRAINT inventory_history_reference_type_check
  CHECK (reference_type IS NULL OR reference_type IN (
    'purchase_order', 'return', 'adjustment', 'manual', 'initial_stock',
    'sale', 'void', 'pos_return', 'order',
    'exchange_in', 'exchange_out', 'exchange_damaged',
    'order_confirmed', 'order_cancelled',
    'order_fulfilled'
  ));
```

---

#### File: `apps/api/src/modules/inventory/inventoryTransaction.service.ts`

**Add `fulfillReservation()` method:**

```typescript
export interface FulfillReservationParams {
  orderId: number | string;
  locationId: number;
  lineItems: Array<{ bookId: number; qtyReserved: number }>;
  staffCtx: StaffCtx;
}

export async function fulfillReservation(
  params: FulfillReservationParams,
  externalClient?: PoolClient,
): Promise<void>
```

Implementation:
1. For each line item where `qtyReserved > 0`:
   - Read `inventory.quantity` (no UPDATE — quantity was already deducted at confirm)
   - Insert `inventory_history` row:
     - `movement_type = 'stock_out'` (for audit continuity — the physical movement is now permanent)
     - `reference_type = 'order_fulfilled'`
     - `reference_id = orderId`
     - `qty_before = qty_after = inventory.quantity` (unchanged)
     - `delta = 0` (no physical change)
     - `staff_id` from `staffCtx`
2. Update `inventory_reservations SET status = 'deducted'` for the order.
3. Does NOT modify `inventory.quantity`.
4. Accepts an `externalClient` to participate in the caller's transaction.

---

#### File: `apps/api/src/modules/orders/orders.service.ts`

**`fulfill()` — specific changes:**

1. **Remove `invTxSvc.stockOut()` call.** Stock was already deducted at `confirm()`. Replace
   with `invTxSvc.fulfillReservation()`.

2. **Remove the `cash_sale && !effectivelyPaid` guard.** Fulfillment is a logistics event.
   Replace the two-branch sale_type gate with a single check:
   ```
   if (!['CONFIRMED', 'PARTIALLY_PAID', 'PAID', 'Confirmed', 'In_Progress'].includes(order.status) && ns !== 'CONFIRMED') {
     throw new BusinessError('INVALID_STATE', ...)
   }
   ```
   Accept CONFIRMED, PARTIALLY_PAID, and PAID regardless of `payment_status`.

3. **Keep `inventory_reservations` `'deducted'` transition** — this is now handled inside
   `fulfillReservation()`, so remove the direct `UPDATE inventory_reservations` from
   `fulfill()`.

4. **Keep the auto-transition to COMPLETED** — both sale types transition to COMPLETED at
   fulfillment. For CREDIT orders the receivable stays open.

5. **Do NOT settle or modify receivables in `fulfill()`.**

**`cancel()` — specific changes:**

1. **Add `invTxSvc.stockIn()` for CONFIRMED/PARTIALLY_PAID/PAID orders.** For each line
   item where `qtyReserved > 0`, call:
   ```typescript
   await invTxSvc.stockIn({
     bookId: item.bookId,
     locationId,
     quantity: item.qtyReserved,
     referenceType: 'order_cancelled',
     referenceId: orderId,
     reasonCode: 'return',
     notes: `Order cancellation – order ${String(orderId)}`,
     staffCtx,
   }, client);
   ```
   This must happen inside the existing transaction, before `ROLLBACK TO SAVEPOINT` for
   the receivable.

2. **Resolve `locationId`** using the existing `resolveLocationId()` helper (same as
   `confirm()` and `fulfill()`).

3. **Make cancellation fully atomic:** wrap the three steps (stockIn, reservation release,
   receivable settle) inside the same DB transaction. The receivable step already uses a
   savepoint — change it to a hard failure so the whole transaction rolls back if any step
   fails.

**`computeOrderAllowedActions()` — specific changes:**

1. **Add `'PARTIALLY_PAID'` branch** (currently falls through to `default: []`):
   ```typescript
   case 'PARTIALLY_PAID':
     return [
       ...(can('CREATE_SALE') ? ['cancel'] : []),
       ...(can('PROCESS_PAYMENT') ? ['fulfill'] : []),
     ];
   ```

2. **In `'CONFIRMED'` branch**, remove the `!isCreditSale && paymentStatus === 'paid'`
   condition. Return `fulfill` for all confirmed orders with `PROCESS_PAYMENT` permission:
   ```typescript
   case 'CONFIRMED':
     return [
       ...(can('CREATE_SALE') ? ['cancel'] : []),
       ...(can('PROCESS_PAYMENT') ? ['fulfill'] : []),
     ];
   ```
   This correctly allows both CASH and CREDIT confirmed orders to be fulfilled.

3. **`'FULFILLED'` branch** — return `['return']` only (no cancel, no pay):
   ```typescript
   case 'FULFILLED':
     return ['return'];
   ```

---

#### File: `apps/api/src/modules/payments/payments.service.ts`

**`createPayment()` — specific changes:**

1. **Remove the status guard that blocks FULFILLED/COMPLETED orders.** Currently only
   `status === 'Cancelled'` is blocked. No change needed for the hard block. But the
   `EXCEEDS_ORDER_TOTAL` check must remain (prevents overpayment).

2. **Allow post-fulfillment payments:** The function already checks for `order_credit_sale`
   receivable and calls `updateReceivableOnPayment()`. Ensure this block runs for
   FULFILLED/COMPLETED orders too (currently it does, since no status check precedes it).

**`listUnpaidOrders()` — specific changes:**

Update the CTE query to include FULFILLED/COMPLETED CREDIT orders with outstanding balance:

```sql
WHERE (
  (o.payment_status IN ('unpaid', 'partial') AND o.status != 'Cancelled')
  OR
  (o.sale_type = 'credit_sale'
   AND o.status IN ('FULFILLED', 'COMPLETED', 'Fulfilled')
   AND (
     SELECT COALESCE(SUM(amount),0) FROM order_payments
     WHERE order_id = o.id AND status IN ('success','partially_refunded','refunded')
   ) < o.total - 0.01)
)
AND o.status != 'Cancelled'
```

---

#### File: `apps/api/src/modules/returns/returns.service.ts`

**`createReturn()` — specific changes:**

1. **Add `disposition` field to input:**
   ```typescript
   export interface ReturnLineInput {
     transactionLineItemId?: number;  // POS returns
     orderLineItemId?: number;        // Order returns
     quantity: number;
     disposition?: 'SELLABLE' | 'DAMAGED';  // default 'SELLABLE'
   }
   ```

2. **Branch on `disposition` when calling inventory service:**
   ```typescript
   const disposition = line.disposition ?? 'SELLABLE';
   if (disposition === 'SELLABLE') {
     await invTxSvc.stockIn({ ..., referenceType: isOrderReturn ? 'order_return' : 'pos_return', ... }, client);
   } else {
     // DAMAGED: update damaged_quantity, write inventory_history, do NOT add to sellable
     await client.query(
       `UPDATE inventory SET damaged_quantity = damaged_quantity + $1, updated_at = now()
        WHERE book_id = $2 AND location_id = $3`,
       [line.quantity, line.bookId, locationId]
     );
     await client.query(
       `INSERT INTO inventory_history (book_id, location_id, qty_before, qty_after, delta,
          reason_code, movement_type, reference_type, reference_id, notes, staff_id)
        VALUES ($1,$2,$3,$3,0,'damage','stock_in',$4,$5,$6,$7)`,
       [line.bookId, locationId, currentQty, 'order_return', returnId,
        `Damaged return – ${line.quantity} unit(s)`, staffCtx.staffId]
     );
   }
   ```
   Note: `'order_return'` requires adding it to the migration 1700000039 constraint as well.

3. **For CREDIT orders, adjust receivable balance:**
   After all line processing, if the originating order has `sale_type = 'credit_sale'` and
   an open `order_credit_sale` receivable exists:
   ```typescript
   const newOutstanding = Math.max(0, receivable.outstanding_amount - totalRefundAmount);
   await updateReceivableOnPayment({
     sourceType: 'order_credit_sale',
     sourceEntityId: orderId,
     newOutstandingAmount: newOutstanding,
     isFullySettled: newOutstanding <= 0.01,
   }, client);
   ```

---

#### File: `apps/api/src/modules/exchanges/exchanges.service.ts`

**`settleExchange()` — specific changes:**

The function already opens a transaction (`await client.query('BEGIN')`). Ensure:
1. All inventory mutations (both `stockIn` for returned resellable items and `stockOut` for
   new items) happen inside the same client transaction as the `exchange_settlement_entries`
   insert and receivable creation.
2. The existing idempotency check (`SELECT id FROM exchange_settlement_entries`) remains.
3. For exchanges involving a CREDIT order (`original_order_id` present with
   `sale_type = 'credit_sale'`), call `updateReceivableOnPayment()` for the
   `order_credit_sale` receivable if `settlementType = 'Store_Refunds'` (credit issued to
   customer reduces receivable).
4. If any step throws, the outer `catch (err) { await client.query('ROLLBACK'); throw err; }`
   ensures full rollback — verify this is in place for all sub-steps.

---

#### File: `apps/web/src/pages/OrdersPage.tsx`

**`computeOrderAllowedActions()` is backend-driven** — the frontend renders buttons from
`order.allowedActions` returned by the API. No frontend logic change is needed for the
order lifecycle buttons.

**Fallback legacy block:** The `!order.allowedActions` legacy fallback renders Fulfill for
`['Confirmed','In_Progress']` — update this to also include `PARTIALLY_PAID` if needed.

---

#### File: `apps/web/src/pages/PaymentsPage.tsx`

**`listUnpaidOrders()` query (backend already updated above)** — the frontend will
automatically show FULFILLED CREDIT orders once the backend query includes them.

**Collect button visibility:** The Collect button renders for every row in the
`unpaid-orders` list. Since the backend query now includes FULFILLED CREDIT orders, no
frontend change is needed for the Collect button.

**Void/Refund button:** Currently renders `canRefund && status !== 'refunded' && status !== 'failed'`.
Add a guard to hide Refund for payments on FULFILLED orders:
```tsx
{canRefund(userRole, userPermissions)
  && pay.status !== 'failed'
  && pay.status !== 'refunded'
  && pay.sourceType !== 'pos'
  && !isFulfilledOrder(pay)   // new: hide Void for FULFILLED orders
  && ( ... )}
```
Where `isFulfilledOrder` checks the payment's associated order status — pass the status
through the `PaymentRow` type or fetch it lazily.

**DRAFT/CASH orders:** The backend `listUnpaidOrders()` only returns CREDIT orders and POS
credit sales, so DRAFT and CASH orders will not appear in the pending payments list after
the backend query is corrected. No additional frontend guard needed.

---

### Migration: `'order_return'` reference type

Migration 1700000039 must also add `'order_return'` to the CHECK constraint (required by
the returns disposition changes above):

```sql
CHECK (reference_type IS NULL OR reference_type IN (
  'purchase_order', 'return', 'adjustment', 'manual', 'initial_stock',
  'sale', 'void', 'pos_return', 'order',
  'exchange_in', 'exchange_out', 'exchange_damaged',
  'order_confirmed', 'order_cancelled',
  'order_fulfilled', 'order_return'
));
```

---

## Testing Strategy

### Validation Approach

The testing strategy follows the bug condition methodology:
1. **Exploratory** — run tests on unfixed code to surface counterexamples confirming the
   root causes.
2. **Fix Checking** — verify each of the five bug conditions is resolved.
3. **Preservation Checking** — verify non-buggy paths are byte-for-byte equivalent.

All tests are integration tests using a test database; the service functions are called
directly, not through HTTP, to maximize precision.

---

### Exploratory Bug Condition Checking

**Goal:** Surface counterexamples confirming each root cause before the fix is applied.
If a test does NOT fail on unfixed code, the hypothesis for that bug condition must be
re-evaluated.

**Test Cases:**

1. **C1 Exploration — PARTIALLY_PAID orders have no allowed actions:**
   Create a CREDIT order, confirm it, record a partial payment → `payment_status = 'partial'`.
   Call `computeOrderAllowedActions('PARTIALLY_PAID', ...)`. Assert result is empty `[]`.
   (Should FAIL post-fix when PARTIALLY_PAID returns `['cancel','fulfill']`.)

2. **C1 Exploration — fulfill() double-deducts stock:**
   Create an order, confirm it (stock deducted by N), fulfill it. Assert
   `inventory.quantity` decreased by `2N` instead of `N`.
   (Will fail on unfixed code — confirms double-deduction.)

3. **C2 Exploration — FULFILLED CREDIT order absent from listUnpaidOrders:**
   Create CREDIT order → confirm → fulfill. Assert order does NOT appear in
   `listUnpaidOrders()` result even though `payment_status = 'unpaid'`.
   (Will fail post-fix when FULFILLED orders appear in the list.)

4. **C4 Exploration — cancel() does not restore inventory:**
   Create order → confirm (stock deducted) → cancel. Assert `inventory.quantity` is
   lower than pre-confirm value. (Should fail post-fix when stockIn is called.)

5. **C5 Exploration — return always restores sellable stock:**
   Create a return with `disposition = 'DAMAGED'`. Assert `inventory.quantity` increased.
   (Will fail post-fix when damaged items do NOT add to sellable stock.)

**Expected Counterexamples:**
- `computeOrderAllowedActions('PARTIALLY_PAID', ...)` returns `[]`
- `inventory.quantity` decreases by `2N` after confirm + fulfill
- FULFILLED CREDIT order with outstanding balance absent from `listUnpaidOrders()`
- `inventory.quantity` not restored after cancel of confirmed order
- Damaged return incorrectly increases `inventory.quantity`

---

### Fix Checking

**Goal:** For all inputs where `isBugCondition(X) = true`, the fixed functions produce
the correct behavior.

**Pseudocode:**
```
FOR ALL X WHERE isBugCondition(X) DO
  result := fixedFunction(X)
  ASSERT expectedBehavior(result)
END FOR
```

**Test Cases (all 9 required scenarios from the spec):**

1. **CASH lifecycle — CONFIRMED → FULFILLED:**
   Create CASH order → confirm (check `payment_status = 'paid'` immediately, no receivable) →
   fulfill (no stock deduction, reservation moves to 'deducted', no receivable change) →
   order COMPLETED. Assert `inventory.quantity = preConfirm - qty`.

2. **CREDIT lifecycle — CONFIRMED → FULFILLED → post-fulfillment payment:**
   Create CREDIT order → confirm (receivable created, `payment_status = 'unpaid'`) →
   fulfill (receivable unchanged, order COMPLETED) → call `createPayment()` → assert
   receivable reduced → full payment → assert `payment_status = 'paid'`, receivable Settled.

3. **PARTIAL CREDIT — CONFIRMED → PARTIALLY_PAID → FULFILLED → post-fulfillment payment:**
   Create CREDIT order → confirm → record partial payment (`payment_status = 'partially_paid'`) →
   fulfill (allowed from PARTIALLY_PAID) → record remaining payment → assert receivable Settled.

4. **Cancellation before fulfillment — atomic rollback guarantee:**
   Create CREDIT order → confirm → cancel. Assert in one assertion block:
   (a) `inventory.quantity` restored to pre-confirm value,
   (b) `inventory_reservations` row has `status = 'released'`,
   (c) receivable `status = 'Settled'`, `outstanding_amount = 0`.
   Simulate DB failure mid-cancel: assert full rollback (inventory not restored, receivable
   not settled).

5. **FULFILLED order cancellation rejected:**
   Create CREDIT order → confirm → fulfill. Call `cancel()`. Assert throws
   `BusinessError('ORDER_ALREADY_FULFILLED')`. Assert `inventory.quantity` unchanged.

6. **Return SELLABLE disposition — stock restored:**
   Create order → confirm → fulfill → create return with `disposition = 'SELLABLE'`. Assert
   `inventory.quantity` increases by returned qty. Assert `inventory.damaged_quantity` unchanged.

7. **Return DAMAGED disposition — stock NOT added to sellable:**
   Same flow, `disposition = 'DAMAGED'`. Assert `inventory.quantity` unchanged. Assert
   `inventory.damaged_quantity` increased by returned qty.

8. **CREDIT return adjusts receivable:**
   CREDIT order → fulfill → return (SELLABLE). Assert `receivable.outstanding_amount`
   decreases by the returned line value.

9. **Concurrent confirmations — only one succeeds:**
   `inventory.quantity = 3` for book X. Two concurrent `confirm()` calls, each requesting
   3 units. Assert exactly one succeeds and the other throws `INSUFFICIENT_STOCK`. Assert
   `inventory.quantity = 0` after the winner.

---

### Preservation Checking

**Goal:** For all inputs where `isBugCondition(X) = false`, fixed functions produce
identical results to original functions.

**Pseudocode:**
```
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT fixedFunction(X) = originalFunction(X)
END FOR
```

**Test Cases:**

1. **POS cash sale flow unchanged:**
   Create POS transaction with full payment. Assert `inventory.quantity` decremented once,
   `inventory_history` row with `reference_type = 'sale'`, outbox `pos.sale_completed`
   emitted. Assert no `order_credit_sale` receivable created.

2. **DRAFT order zero inventory impact:**
   Create order in DRAFT. Assert `inventory.quantity` unchanged, no `inventory_history` rows
   for this order.

3. **DRAFT cancellation zero impact:**
   Cancel a DRAFT order. Assert `inventory.quantity` unchanged, no reservation changes.

4. **POS credit sale receivable unaffected by order payment:**
   Create a POS credit sale (creates `pos_credit_sale` receivable). Then create an
   unrelated order payment. Assert POS receivable unchanged.

5. **Existing exchange settlement preserved:**
   Run an exchange via `settleExchange()`. Assert all existing assertions pass: inventory
   changes for resellable items, `exchange_settlement_entries` rows created, outbox events
   emitted. Verify the existing idempotency check still works.

6. **`adjust` and `transfer` optimistic locking preserved:**
   Call `adjust()` with a stale `version` → `VERSION_CONFLICT`. Call with correct version →
   success. Assert `inventory_history` row has all non-null fields.

7. **POS and Orders show identical available stock:**
   After confirming an order for N units, call `getAvailableStock()` from both POS and Orders
   context. Assert both return `quantity - N` as available.

---

### Unit Tests

- `computeOrderAllowedActions('PARTIALLY_PAID', ...)` returns `['cancel', 'fulfill']`
- `computeOrderAllowedActions('CONFIRMED', ...)` returns `['cancel', 'fulfill']` regardless
  of `paymentStatus` or `saleType`
- `computeOrderAllowedActions('FULFILLED', ...)` returns `['return']`
- `fulfillReservation()` writes `inventory_history` with `delta = 0`, correct `reference_type`
- `fulfillReservation()` sets `inventory_reservations.status = 'deducted'`
- `fulfillReservation()` does NOT modify `inventory.quantity`
- `cancel()` on CONFIRMED order calls `invTxSvc.stockIn()`
- `cancel()` on DRAFT order does NOT call `invTxSvc.stockIn()`
- `cancel()` on FULFILLED order throws `ORDER_ALREADY_FULFILLED`
- `createReturn(disposition = 'SELLABLE')` calls `stockIn()`, does not touch `damaged_quantity`
- `createReturn(disposition = 'DAMAGED')` updates `damaged_quantity`, does not call `stockIn()`
- `createPayment()` accepts FULFILLED CREDIT orders with outstanding balance

---

### Property-Based Tests

- **Inventory accounting invariant:** For any sequence of `(confirm, fulfill, cancel)` on
  the same order, the net `inventory.quantity` change equals `-(totalConfirmedQty)` for
  FULFILLED orders and `0` for cancelled orders.
- **Reservation status machine:** For any order lifecycle, at every point the sum of
  `inventory_reservations.quantity WHERE status = 'reserved'` plus the quantity of fulfilled
  orders equals the total confirmed quantity — no units are lost or double-counted.
- **Receivable monotonicity for CREDIT orders:** For any sequence of payments on a CREDIT
  order, `receivable.outstanding_amount` is non-increasing and never drops below 0.
- **Return disposition invariant:** For any return with `disposition = 'DAMAGED'`,
  `inventory.quantity` (sellable) is unchanged; for `disposition = 'SELLABLE'`,
  `inventory.damaged_quantity` is unchanged.

---

### Integration Tests

Covering all 9 required scenarios (see Fix Checking above), plus:

- **POS and Orders available stock consistency:** Confirm an order at location L for book B.
  Query available stock from both `getAvailableStock(B, L)` and the POS book-availability
  endpoint. Assert both return the same `available` value using the formula
  `quantity - SUM(active reservations)`.

- **Migration 1700000039 idempotency:** Running the migration twice must not fail (uses
  `DROP CONSTRAINT IF EXISTS`).

- **Full exchange atomicity:** Start `settleExchange()`, inject a DB failure after inventory
  mutation but before `exchange_settlement_entries` insert. Assert the entire transaction
  rolled back — inventory unchanged, no settlement entries, receivable unmodified.
