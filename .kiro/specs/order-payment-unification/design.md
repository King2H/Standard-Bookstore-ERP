# Order Payment Unification — Bugfix Design

## Overview

The Orders module has five interlocking defects that together prevent correct payment tracking,
receivable creation, and discount handling. This design formalises a targeted, minimal fix that:

1. Removes the duplicate `POST /orders/:id/pay` path from the UI and routes all payment
   collection through `Finance → Payments`.
2. Adds a `sale_type` column to `orders` and creates a receivable at confirmation time for any
   unpaid or partially-paid order.
3. Extends `OrderLineInput` with the full discount schema and wires it to `lib/discount.ts`
   (`resolveDiscountFields`, `enforceDiscountCap`, `getMaxLineDiscountPct`).
4. Hooks `payments.service.createPayment()` to call `updateReceivableOnPayment()` when an
   `order_credit_sale` receivable exists for the order.
5. Hooks `orders.service.cancel()` to settle any open `order_credit_sale` receivable.

No existing POS, Exchange, or receivables flows are modified.

---

## Glossary

- **Bug_Condition (C)**: The set of inputs/states that trigger one of the five defects.
- **Property (P)**: The desired correct behavior for those inputs after the fix.
- **Preservation**: Existing behavior (POS, Exchange, unrelated Orders actions) that must remain
  byte-for-byte unchanged.
- **`order_credit_sale`**: New `source_type` value added to `receivables` to track outstanding
  balances on confirmed orders.
- **`sale_type`**: New column on `orders` — `'cash_sale'` (default) | `'credit_sale'`.
- **`resolveDiscountFields()`**: Pure function in `lib/discount.ts` that converts (mode, value,
  type) → `{ discountPct, discountAmount, discountType, discountMode }`.
- **`enforceDiscountCap()`**: Throws `BusinessError('DISCOUNT_EXCEEDS_LIMIT')` when
  `discountPct > maxPct`.
- **`getMaxLineDiscountPct(branchId, role)`**: Returns per-role max discount from
  `config.service.ts`.
- **`updateReceivableOnPayment()`**: Hook in `receivables.service.ts` that updates
  `outstanding_amount` / `status` on a receivable within an active DB transaction.

---

## Bug Details

### Bug Condition

The five bug conditions share a common trigger: the Orders module is missing the glue between
the payment/receivables system and the discount system.

**Formal Specification:**

```
FUNCTION isBugCondition(X)
  INPUT: X — an order-related event (create, confirm, pay, cancel) or an API request body
  OUTPUT: boolean

  RETURN (
    -- D1: Legacy pay route still active in UI
    (X.action = 'POST /orders/:id/pay' AND X.intent = 'collect_payment')

    OR

    -- D2: No sale_type column; no receivable at confirmation
    (X.action = 'confirm'
      AND (X.paymentStatus IN ('unpaid', 'partial'))
      AND NOT EXISTS receivable WHERE source_type='order_credit_sale'
                                  AND source_entity_id = X.orderId)

    OR

    -- D3 + D5: Discount engine not wired; extended fields silently dropped
    (X.action IN ('create', 'POST /orders')
      AND (X.item.discountPct IS NOT NULL
        OR X.item.discountType IS NOT NULL
        OR X.item.discountMode IS NOT NULL))

    OR

    -- D4a: Payment recorded but receivable not updated
    (X.action = 'POST /payments'
      AND EXISTS receivable WHERE source_type='order_credit_sale'
                               AND source_entity_id = X.orderId
                               AND status != 'Settled')

    OR

    -- D4b: Order cancelled but receivable not settled
    (X.action = 'cancel'
      AND EXISTS receivable WHERE source_type='order_credit_sale'
                               AND source_entity_id = X.orderId
                               AND status != 'Settled')
  )
END FUNCTION
```

### Examples

- **D1**: Staff clicks "Take Payment" on a CONFIRMED order → `POST /orders/42/pay` transitions
  status to PAID but `order_payments` table gets no new row.
- **D2**: Order ORD-20250101-0001 confirmed with `payment_status = 'unpaid'` → no row in
  `receivables`, so Finance → Payments aging tab shows `$0` outstanding for this order.
- **D3/D5**: `POST /orders` with `items: [{ bookId: 1, quantity: 1, discountPct: 10, discountMode: 'Percentage' }]`
  → `discountPct` ignored; DB stores `discount_pct = 0`, `discount_type = 'Normal'`,
  `discount_mode = 'Percentage'` (schema defaults, not the input values).
- **D4a**: `POST /payments { orderId: 42, amount: 500 }` makes order fully paid → receivable row
  for order 42 stays at `status = 'Pending'`, `outstanding_amount = 1000`.
- **D4b**: Staff cancels CONFIRMED order 42 → receivable row for order 42 stays at
  `status = 'Pending'`, `outstanding_amount = 1000` (phantom debt).

---

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- `pos.service.ts` — not touched. All POS transaction, credit-sale, and payment flows remain
  exactly as before.
- `exchanges.service.ts` — not touched. `exchange_difference` receivables continue to use the
  existing `createReceivable` / `updateReceivableOnPayment` hooks.
- `payments.service.createPayment()` — for orders that have **no** associated
  `order_credit_sale` receivable (e.g. orders created before this fix), the payment is recorded
  and `payment_status` updated exactly as before; the new receivable-update code is guarded by
  an existence check.
- `orders.service.confirm()` inventory logic — stock deduction, reservations, and
  `INSUFFICIENT_STOCK` rejection are untouched.
- `orders.service.cancel()` inventory restore logic — the new receivable-settle call is appended
  **after** the existing inventory restoration so it cannot affect that path.
- `PaymentsPage.listUnpaidOrders()` — already queries orders by `payment_status IN
  ('unpaid','partial')`, so no changes needed; the new `sale_type` column is invisible to this
  query.
- Backward-compatible discount: if a line item is submitted with only `discountAmount`, defaults
  `discountType = 'Normal'`, `discountMode = 'Amount'`, and the existing totals math is
  preserved.

**Scope:**
All code paths that do NOT involve creating/confirming/cancelling an order, or recording a
payment against an order, are completely unaffected.

---

## Hypothesized Root Cause

1. **D1 — Legacy pay route**: `orders.routes.ts` still registers `POST /orders/:id/pay` which
   calls `ordersService.pay()`, and `computeOrderAllowedActions()` still returns `'pay'` in
   `CONFIRMED` state. The UI's pay modal calls `POST /orders/:id/pay` directly instead of
   routing through `POST /payments`.

2. **D2 — Missing `sale_type` column**: Migration 25 never added `sale_type`; migration 35
   added `discount_total` but not `sale_type`. No migration has been written to add it.
   `orders.service.confirm()` has no code to call `createReceivable()`.

3. **D3/D5 — Discount engine not wired**: `OrderLineInput` only has `discountAmount?: number`.
   The `create()` function computes `discountAmount = item.discountAmount ?? 0` without calling
   `resolveDiscountFields()` or `enforceDiscountCap()`. The columns `discount_pct`,
   `discount_type`, `discount_mode` added in migration 35 are never populated with real values
   from the input.

4. **D4 — No receivable hooks in payments/cancel**: `payments.service.createPayment()` computes
   `newPaymentStatus` and updates `orders.payment_status` but has no subsequent call to
   `updateReceivableOnPayment()`. `orders.service.cancel()` restores inventory but has no call
   to settle any receivable.

---

## Correctness Properties

Property 1: Bug Condition D1 — Payment Collection Routes Through Finance

_For any_ order action where `POST /orders/:id/pay` is called as the payment-collection path,
the fixed system SHALL NOT expose a "Take Payment" button in `OrdersPage` that calls this route.
All payment collection SHALL go through `POST /payments`, which records a row in `order_payments`
and recomputes `payment_status`.

**Validates: Requirements 2.1, 2.2**

Property 2: Bug Condition D2 — Receivable Created at Confirmation

_For any_ order that is confirmed with `payment_status IN ('unpaid', 'partial')`, the fixed
`confirm()` function SHALL insert a row into `receivables` with `source_type = 'order_credit_sale'`,
`source_entity_id = orderId`, `outstanding_amount = orderTotal - totalAlreadyPaid`.

_For any_ order that is confirmed with `payment_status = 'paid'`, the fixed `confirm()` function
SHALL NOT insert any receivable row.

**Validates: Requirements 2.4, 2.5, 2.6, 2.7**

Property 3: Bug Condition D2 — Credit Sale Requires Customer

_For any_ order created with `saleType = 'credit_sale'`, the fixed `create()` function SHALL
reject the request with `CREDIT_REQUIRES_CUSTOMER` when no `customerId` is provided.

**Validates: Requirement 2.8**

Property 4: Bug Condition D3/D5 — Discount Engine Wired

_For any_ order line item submitted with `discountPct`, `discountType`, or `discountMode`, the
fixed `create()` function SHALL invoke `resolveDiscountFields()` and persist the resolved
`discount_pct`, `discount_type`, `discount_mode` to `order_line_items`. The computed
`discountAmount` SHALL equal `round(unitPrice × quantity × discountPct / 100, 2)` in Percentage
mode, and SHALL equal the provided `discountAmount` in Amount mode (with `discountPct`
back-calculated).

**Validates: Requirements 3.1, 3.2, 3.4**

Property 5: Bug Condition D3/D5 — Discount Cap Enforced

_For any_ order line item where the resolved `discountPct > getMaxLineDiscountPct(branchId, role)`,
the fixed `create()` function SHALL throw `BusinessError('DISCOUNT_EXCEEDS_LIMIT')` before any
DB write occurs.

**Validates: Requirement 3.3**

Property 6: Bug Condition D4 — Receivable Updated on Payment

_For any_ call to `createPayment()` where an `order_credit_sale` receivable exists for
`data.orderId`, the fixed function SHALL call `updateReceivableOnPayment()` with
`newOutstandingAmount = max(0, orderTotal - newTotalPaid)` and `isFullySettled = (newPaymentStatus === 'paid')`.

**Validates: Requirements 4.1, 4.2**

Property 7: Bug Condition D4 — Receivable Settled on Cancellation

_For any_ call to `cancel()` where an `order_credit_sale` receivable exists for `orderId` and
its `status != 'Settled'`, the fixed function SHALL call `updateReceivableOnPayment()` with
`newOutstandingAmount = 0, isFullySettled = true`.

**Validates: Requirement 4.3**

Property 8: Preservation — POS and Exchange Flows Unaffected

_For any_ input that is NOT an order create/confirm/cancel or an order payment, the fixed code
SHALL produce exactly the same behavior as the original code.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8**

---

## Fix Implementation

### Changes Required

**Migration: `apps/api/src/db/migrations/1700000038_order_sale_type.cjs`**

1. Add `sale_type TEXT NOT NULL DEFAULT 'cash_sale' CHECK (sale_type IN ('cash_sale','credit_sale'))` to `orders`.
2. Extend `receivables.source_type` CHECK constraint to include `'order_credit_sale'`.

**File: `apps/api/src/modules/receivables/receivables.service.ts`**

1. Add `'order_credit_sale'` to the `ReceivableSourceType` union type so TypeScript accepts it.

**File: `apps/api/src/modules/orders/orders.service.ts`**

1. Extend `OrderLineInput` with optional `discountPct`, `discountType`, `discountMode` fields.
2. Extend `OrderRow` with `saleType: 'cash_sale' | 'credit_sale'` and `discountTotal: number`.
3. Update `mapOrderRow()` to read `sale_type` and `discount_total` from the DB row.
4. Update `create()`:
   - Accept `saleType?: 'cash_sale' | 'credit_sale'` (default `'cash_sale'`).
   - Validate that `credit_sale` requires `customerId`.
   - For each line item: call `resolveDiscountFields()` if discount fields present; fall back to
     legacy `discountAmount` with `Normal/Amount` defaults.
   - Call `enforceDiscountCap()` against `getMaxLineDiscountPct()` for every item.
   - Persist `discount_pct`, `discount_type`, `discount_mode` to `order_line_items`.
   - Persist `sale_type` and `discount_total` to the `orders` INSERT.
5. Update `confirm()`:
   - After updating order status to CONFIRMED, query `SUM(amount)` from `order_payments` for
     this order (the upfront payment, if any).
   - Compute `outstandingAmount = order.total - totalAlreadyPaid`.
   - If `outstandingAmount > 0` and no receivable already exists: call `createReceivable()`.
   - Use a savepoint so a receivable failure is non-fatal (mirroring the POS pattern).
6. Update `cancel()`:
   - After the existing inventory-restoration block: query for any `order_credit_sale`
     receivable with `status != 'Settled'`.
   - If found: call `updateReceivableOnPayment({ ..., newOutstandingAmount: 0, isFullySettled: true }, client)`.
   - Use a savepoint so a receivable failure is non-fatal.
7. Update `computeOrderAllowedActions()`:
   - Remove `'pay'` from all status branches (CONFIRMED, Confirmed, In_Progress legacy).

**File: `apps/api/src/modules/orders/orders.routes.ts`**

1. Keep the `POST /orders/:id/pay` route registration for backward compatibility but have it
   return HTTP 410 Gone (or delegate to `payments.service.createPayment`) to avoid breaking
   existing integrations.
   > Chosen approach: keep the route but immediately return a `410 Gone` response with a
   > message directing the caller to `POST /payments`.

**File: `apps/api/src/modules/payments/payments.service.ts`**

1. After the existing `updatePaymentStatus` block in `createPayment()`, check for an
   `order_credit_sale` receivable using the shared client.
2. If found, compute `newOutstanding = max(0, orderTotal - newTotalPaid)` and call
   `updateReceivableOnPayment()`.
3. Wrap in a savepoint so a receivable failure is non-fatal.

**File: `apps/web/src/pages/OrdersPage.tsx`**

1. Remove the `'pay'` branch from the `allowedActions` render loop (the "Take Payment" modal
   and button).
2. Remove the `payModal` / `payAmount` / `payMethod` state and the payment modal JSX.
3. Add a `saleType` radio toggle ("Cash Sale" / "Credit Sale") in the New Order form.
4. Add discount UI per line item: type selector, mode toggle (% / amount), value input.
5. Update `orderItems` state type and `submitOrder()` to pass `saleType` and discount fields.
6. Show a `saleType` badge on the orders list table.

---

## Testing Strategy

### Validation Approach

Tests run on the **fixed code** (no unfixed-code exploration needed, since all five bugs have
clear root causes confirmed by code review). Tests are grouped into: unit tests for service
logic, integration tests for DB interactions, and backward-compatibility tests.

### Exploratory Bug Condition Checking

**Goal**: Confirm all five defects are reproducible before the fix lands so we know which tests
must fail first (then pass after the fix).

**Test Plan**: Write tests that exercise each bug condition against the unfixed service functions
and assert that the defect manifests as expected.

**Test Cases**:
1. **D1 Exploration**: Call `ordersService.pay()` on a CONFIRMED order → assert no row is
   inserted into `order_payments` (will pass pre-fix, exposing the defect).
2. **D2 Exploration**: Call `ordersService.confirm()` on an unpaid order → assert no row in
   `receivables` (will pass pre-fix).
3. **D3 Exploration**: Call `ordersService.create()` with `discountPct=10, discountMode='Percentage'`
   → assert `discount_pct = 0` in DB (will pass pre-fix).
4. **D4 Exploration**: Call `paymentsService.createPayment()` when a receivable exists → assert
   receivable status unchanged (will pass pre-fix).
5. **D5 Exploration**: Same as D3 from the API request body perspective.

### Fix Checking

**Goal**: For all inputs where the bug condition holds, the fixed function produces the expected
behavior.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := fixedFunction(input)
  ASSERT expectedBehavior(result)
END FOR
```

**Test Cases**:
1. Creating a `credit_sale` order without a customer → `CREDIT_REQUIRES_CUSTOMER` error.
2. Confirming an unpaid order → receivable created with correct `outstanding_amount`.
3. Confirming a cash-sale order with full upfront payment → no receivable created.
4. `POST /payments` fully pays an order with a receivable → receivable settled.
5. `POST /payments` partially pays an order with a receivable → receivable `PartiallyPaid`.
6. Cancel a confirmed order with receivable → receivable settled.
7. Order line with `discountPct=10, discountMode='Percentage'` → DB stores correct values.
8. Order line with `discountMode='Amount', discountAmount=50` → `discountPct` back-calculated.
9. Discount exceeds cap → `DISCOUNT_EXCEEDS_LIMIT` thrown, no DB write.
10. `computeOrderAllowedActions('CONFIRMED', ...)` does NOT return `'pay'`.

### Preservation Checking

**Goal**: For all inputs where the bug condition does NOT hold, the fixed function behaves
identically to before.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT originalFunction(input) = fixedFunction(input)
END FOR
```

**Test Cases**:
1. Creating an order with only `discountAmount` (legacy) → `discountType='Normal'`, `discountMode='Amount'`.
2. `createPayment()` on an order with no receivable → payment recorded, no error.
3. `confirm()` on an already-fully-paid order → no receivable created.
4. POS credit-sale receivable unaffected when an order payment is recorded.
5. Exchange difference receivable unaffected when an order is cancelled.

### Unit Tests

- `computeOrderAllowedActions()` — CONFIRMED state no longer returns `'pay'`.
- `resolveDiscountFields()` called correctly in percentage and amount modes.
- `enforceDiscountCap()` throws when discount exceeds limit.
- Backward-compat: `discountAmount`-only path defaults `type/mode` correctly.

### Property-Based Tests

- Generate random `(discountPct, discountMode)` combinations → verify `resolveDiscountFields`
  output satisfies invariant `discountAmount = round(unitPrice * qty * pct/100, 2)`.
- Generate random `outstandingAmount` values → verify `updateReceivableOnPayment` always sets
  `outstanding_amount >= 0`.
- Generate random payment sequences → verify that after all payments the receivable
  `outstanding_amount` equals `max(0, orderTotal - sum(payments))`.

### Integration Tests

- Full flow: create credit-sale order → confirm → verify receivable created →
  Finance records partial payment → verify receivable `PartiallyPaid` →
  Finance records full payment → verify receivable `Settled`.
- Full flow: create cash-sale order → confirm (unpaid) → cancel → verify receivable `Settled`.
- Full flow: create cash-sale order (fully paid upfront) → confirm → verify no receivable.
- Discount integration: create order with `discountPct=15, discountMode='Percentage'` →
  verify all three discount columns populated in `order_line_items`.
