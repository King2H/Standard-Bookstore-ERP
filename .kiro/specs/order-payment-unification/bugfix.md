# Bugfix Requirements Document

## Introduction

The Orders module (v1.0.1) has a fundamentally incomplete payment workflow that diverges from both the POS module and ERP best practices across five distinct defects. Orders lack a `sale_type` distinction (cash vs. credit), have no automatic receivable creation for unpaid balances, expose a duplicate "Take Payment" path that only transitions status without recording a payment, do not reuse the shared `lib/discount.ts` engine, and leave `discount_pct / discount_type / discount_mode` columns on `order_line_items` permanently unpopulated despite the schema being ready since migration 35.

The net effect is that credit-sale orders are invisible to the receivables system, the Finance → Payments module cannot age or collect outstanding order balances, and the discount model in Orders is a partial implementation inconsistent with POS.

---

## Bug Analysis

### Current Behavior (Defect)

**Defect 1 — Duplicate payment collection paths**

1.1 WHEN staff clicks "Take Payment" on a confirmed order in `OrdersPage` THEN the system calls `POST /orders/:id/pay` which only transitions `status` from `CONFIRMED` to `PAID` and does NOT record a payment row in `order_payments` or update `payment_status`

1.2 WHEN `POST /orders/:id/pay` is called THEN the system returns the updated order with `payment_status` still reflecting the old value (`unpaid`), misleading the caller into believing the payment was collected

**Defect 2 — No sale_type on Orders (cash vs. credit)**

2.1 WHEN an order is created THEN the system does not store a `sale_type` (`cash_sale` | `credit_sale`), treating all orders as implicitly cash with no enforcement

2.2 WHEN a credit-sale order has `payment_status = 'unpaid'` indefinitely THEN the system does not create a receivable record, making the outstanding balance invisible to the receivables and aging subsystem

2.3 WHEN a credit-sale order requires a customer THEN the system does not validate that a customer is linked, allowing anonymous credit orders that can never be collected

**Defect 3 — Discount engine not reused in Orders**

3.1 WHEN `orders.service.create()` is called with line items THEN the system accepts only a raw `discountAmount` per line item and does not validate or process `discountType`, `discountMode`, or `discountPct`

3.2 WHEN discount fields are passed THEN the system does not invoke `lib/discount.ts` functions (`resolveDiscountFields`, `enforceDiscountCap`, `getMaxLineDiscountPct`), bypassing all discount validation and cap enforcement

3.3 WHEN an order is created THEN the system writes `discount_pct = 0`, `discount_type = 'Normal'`, `discount_mode = 'Percentage'` (DB defaults) to `order_line_items` regardless of the actual discount applied, leaving the columns from migration 35 permanently unpopulated with real values

**Defect 4 — Receivables never created for unpaid/partial Orders**

4.1 WHEN an order is confirmed with `payment_status = 'unpaid'` THEN the system does not create a receivable record, so `PaymentsPage.listUnpaidOrders()` shows the order in the pending list but there is no row in `receivables` to track, age, or settle the outstanding balance

4.2 WHEN an order is confirmed with `payment_status = 'partial'` (payment recorded at confirmation time) THEN the system does not create a receivable for the remaining balance

4.3 WHEN Finance records a payment against an order via `POST /payments` and the order becomes fully paid THEN the system does not settle any corresponding receivable, leaving stale `Pending` receivable rows if they were ever created

4.4 WHEN a confirmed order is subsequently cancelled THEN the system does not settle (zero out) any outstanding receivable for that order

**Defect 5 — `orders.service.create()` does not accept discount mode/type**

5.1 WHEN `OrderLineInput` is provided with `discountPct`, `discountType`, or `discountMode` fields THEN the system ignores them because `OrderLineInput` only defines `discountAmount?: number`

5.2 WHEN the POS discount engine fields are absent from `OrderLineInput` THEN the system cannot enforce per-role max-discount caps for order line items as it does for POS transactions via `getMaxLineDiscountPct()`

---

### Expected Behavior (Correct)

**Defect 1 — Unified payment collection**

2.1 WHEN staff needs to collect payment for an order THEN the system SHALL route all payment collection exclusively through `Finance → Payments` (`POST /payments`), which records a row in `order_payments` and recomputes `payment_status`

2.2 WHEN `POST /orders/:id/pay` is called (legacy route) THEN the system SHALL either be removed or delegate to `payments.service.createPayment()` so no status-only transition is possible

**Defect 2 — Sale type on Orders**

2.3 WHEN an order is created THEN the system SHALL accept a `saleType` field with values `'cash_sale'` | `'credit_sale'` and persist it to `orders.sale_type`, defaulting to `'cash_sale'`

2.4 WHEN a credit-sale order is confirmed THEN the system SHALL set `payment_status = 'unpaid'` and automatically create a receivable with `source_type = 'order_credit_sale'`, `sourceEntityId = orderId`, `sourceRefId = orderNumber`

2.5 WHEN a cash-sale order is confirmed with no payment THEN the system SHALL set `payment_status = 'unpaid'` and create a receivable for the full total so Finance can collect later

2.6 WHEN a cash-sale order is confirmed with a partial upfront payment THEN the system SHALL set `payment_status = 'partial'` and create a receivable for the remaining outstanding balance only

2.7 WHEN a cash-sale order is confirmed and immediately fully paid at confirmation time THEN the system SHALL set `payment_status = 'paid'` and SHALL NOT create a receivable

2.8 WHEN an order has `saleType = 'credit_sale'` THEN the system SHALL require a `customerId` to be present and SHALL reject the order with a validation error if no customer is linked

**Defect 3 — Discount engine reused in Orders**

3.1 WHEN `orders.service.create()` is called THEN the system SHALL accept `discountPct`, `discountType`, and `discountMode` fields on each `OrderLineInput` alongside the existing `discountAmount`

3.2 WHEN discount fields are provided THEN the system SHALL invoke `resolveDiscountFields()` from `lib/discount.ts` to compute and validate the canonical `discountAmount` and `discountPct` pair

3.3 WHEN discount fields are provided THEN the system SHALL call `getMaxLineDiscountPct()` and enforce the cap via `enforceDiscountCap()`, rejecting the order with `DISCOUNT_EXCEEDS_LIMIT` if the discount exceeds the allowed maximum for the staff role

3.4 WHEN an order line item is persisted THEN the system SHALL write the resolved `discount_pct`, `discount_type`, and `discount_mode` values to `order_line_items`, fully populating the columns added in migration 35

**Defect 4 — Receivables created for unpaid/partial Orders**

4.1 WHEN Finance records a payment via `POST /payments` and the order becomes fully paid THEN the system SHALL call `updateReceivableOnPayment()` with `isFullySettled = true` to settle any `order_credit_sale` receivable for that order

4.2 WHEN Finance records a partial payment via `POST /payments` THEN the system SHALL call `updateReceivableOnPayment()` with the new outstanding amount so the receivable transitions to `PartiallyPaid`

4.3 WHEN a confirmed order is cancelled THEN the system SHALL settle (set `outstanding_amount = 0`, `status = 'Settled'`) any associated receivable so the receivables system is not left with phantom debts

**Defect 5 — Full discount input on Orders**

5.1 WHEN `OrderLineInput` is defined THEN the system SHALL include optional fields `discountPct?: number`, `discountType?: DiscountType`, and `discountMode?: DiscountMode` mirroring the POS `LineItemInput` interface

5.2 WHEN an order is created by a staff member THEN the system SHALL enforce the same per-role max-discount cap as POS using `getMaxLineDiscountPct(branchId, staffRole)`, rejecting oversized discounts before any order row is written

---

### Unchanged Behavior (Regression Prevention)

3.1 WHEN the POS module processes any transaction type THEN the system SHALL CONTINUE TO operate exactly as before — `pos.service.ts` is not modified

3.2 WHEN `payments.service.createPayment()` is called for existing orders that have no associated receivable THEN the system SHALL CONTINUE TO record the payment and update `payment_status` without error

3.3 WHEN the Exchange module creates a receivable for `exchange_difference` THEN the system SHALL CONTINUE TO use the existing `createReceivable()` / `updateReceivableOnPayment()` flow unchanged

3.4 WHEN `PaymentsPage.listUnpaidOrders()` is called THEN the system SHALL CONTINUE TO return both POS credit sales (joined via `receivables` with `source_type = 'pos_credit_sale'`) and Orders (filtered by `payment_status IN ('unpaid', 'partial')`)

3.5 WHEN an order transitions through `confirm → fulfill → complete` or `confirm → cancel` THEN the system SHALL CONTINUE TO deduct and restore inventory as currently implemented in `orders.service.ts`

3.6 WHEN `orders.service.confirm()` is called THEN the system SHALL CONTINUE TO enforce hard stock rejection (`INSUFFICIENT_STOCK`) for any line item with insufficient available inventory

3.7 WHEN an order is created without discount fields THEN the system SHALL CONTINUE TO accept `discountAmount` as a plain override (backward-compatible), defaulting `discountType = 'Normal'` and `discountMode = 'Amount'`

3.8 WHEN `POST /payments` is called with `store_credit` or `loyalty_points` method THEN the system SHALL CONTINUE TO validate and deduct customer balances as currently implemented

---

## Bug Condition Functions and Properties

### Defect 1 — Duplicate Payment Path

```pascal
FUNCTION isBugCondition_D1(X)
  INPUT: X of type OrderAction
  OUTPUT: boolean

  // Bug fires when "Take Payment" button is clicked in OrdersPage,
  // triggering POST /orders/:id/pay instead of POST /payments
  RETURN X.route = 'POST /orders/:id/pay'
    AND X.intent = 'collect_payment'
END FUNCTION

// Property: Fix Checking — D1
FOR ALL X WHERE isBugCondition_D1(X) DO
  result ← handleOrderAction'(X)
  ASSERT result.paymentRecorded = true               // a row exists in order_payments
    AND result.paymentStatus IN ('partial', 'paid')   // status reflects actual money received
    AND result.orderPaymentsCount > previousCount     // new payment row was inserted
END FOR

// Property: Preservation Checking — D1
FOR ALL X WHERE NOT isBugCondition_D1(X) DO
  ASSERT handleOrderAction(X) = handleOrderAction'(X)
END FOR
```

### Defect 2 — Missing Sale Type and Receivable Creation at Confirmation

```pascal
FUNCTION isBugCondition_D2(X)
  INPUT: X of type OrderConfirmation
  OUTPUT: boolean

  // Bug fires when an order is confirmed with unpaid/partial payment AND
  // there is no sale_type column or no receivable created
  RETURN (X.saleType = 'credit_sale' OR X.paymentStatus IN ('unpaid', 'partial'))
    AND NOT EXISTS receivable WHERE source_type = 'order_credit_sale'
                                AND source_entity_id = X.orderId
END FUNCTION

// Property: Fix Checking — D2 (Credit Sale)
FOR ALL X WHERE X.saleType = 'credit_sale' DO
  result ← confirmOrder'(X)
  ASSERT result.order.saleType = 'credit_sale'
    AND result.order.paymentStatus = 'unpaid'
    AND EXISTS receivable WHERE source_type = 'order_credit_sale'
                             AND source_entity_id = result.order.id
                             AND outstanding_amount = result.order.total
    AND (X.customerId IS NOT NULL)  // credit sale must have a customer
END FOR

// Property: Fix Checking — D2 (Cash Sale, Unpaid)
FOR ALL X WHERE X.saleType = 'cash_sale' AND X.upfrontPayment = 0 DO
  result ← confirmOrder'(X)
  ASSERT result.order.paymentStatus = 'unpaid'
    AND EXISTS receivable WHERE source_type = 'order_credit_sale'
                             AND source_entity_id = result.order.id
                             AND outstanding_amount = result.order.total
END FOR

// Property: Fix Checking — D2 (Cash Sale, Partial)
FOR ALL X WHERE X.saleType = 'cash_sale'
             AND X.upfrontPayment > 0
             AND X.upfrontPayment < X.orderTotal DO
  result ← confirmOrder'(X)
  ASSERT result.order.paymentStatus = 'partial'
    AND EXISTS receivable WHERE source_type = 'order_credit_sale'
                             AND source_entity_id = result.order.id
                             AND outstanding_amount = X.orderTotal - X.upfrontPayment
END FOR

// Property: Fix Checking — D2 (Cash Sale, Fully Paid at Confirmation)
FOR ALL X WHERE X.saleType = 'cash_sale'
             AND X.upfrontPayment >= X.orderTotal DO
  result ← confirmOrder'(X)
  ASSERT result.order.paymentStatus = 'paid'
    AND NOT EXISTS receivable WHERE source_type = 'order_credit_sale'
                                AND source_entity_id = result.order.id
END FOR

// Property: Preservation Checking — D2
FOR ALL X WHERE NOT isBugCondition_D2(X) DO
  ASSERT confirmOrder(X) = confirmOrder'(X)
END FOR
```

### Defect 3 — Discount Engine Not Reused

```pascal
FUNCTION isBugCondition_D3(X)
  INPUT: X of type OrderLineInput
  OUTPUT: boolean

  // Bug fires when caller provides discount fields that the engine should process
  RETURN X.discountPct IS NOT NULL
      OR X.discountType IS NOT NULL
      OR X.discountMode IS NOT NULL
END FUNCTION

// Property: Fix Checking — D3 (Percentage Mode)
FOR ALL X WHERE isBugCondition_D3(X) AND X.discountMode = 'Percentage' DO
  result ← createOrderLine'(X)
  expectedDiscountAmount ← round(X.unitPrice * X.quantity * (X.discountPct / 100), 2)
  ASSERT result.discountAmount = expectedDiscountAmount
    AND result.discountPct = X.discountPct
    AND result.discountType = X.discountType
    AND result.discountMode = 'Percentage'
    AND result.discountPct <= getMaxLineDiscountPct(X.branchId, X.staffRole)
END FOR

// Property: Fix Checking — D3 (Amount Mode)
FOR ALL X WHERE isBugCondition_D3(X) AND X.discountMode = 'Amount' DO
  result ← createOrderLine'(X)
  ASSERT result.discountAmount = X.discountAmount
    AND result.discountMode = 'Amount'
    AND result.discountPct = round((X.discountAmount / (X.unitPrice * X.quantity)) * 100, 4)
    AND result.discountPct <= getMaxLineDiscountPct(X.branchId, X.staffRole)
END FOR

// Property: Fix Checking — D3 (Cap Enforcement)
FOR ALL X WHERE isBugCondition_D3(X)
             AND computePct(X) > getMaxLineDiscountPct(X.branchId, X.staffRole) DO
  ASSERT createOrderLine'(X) THROWS BusinessError('DISCOUNT_EXCEEDS_LIMIT')
END FOR

// Property: Preservation Checking — D3 (Backward Compatible discountAmount only)
FOR ALL X WHERE NOT isBugCondition_D3(X) AND X.discountAmount IS NOT NULL DO
  result ← createOrderLine'(X)
  ASSERT result.discountAmount = X.discountAmount
    AND result.discountType = 'Normal'  // default
    AND result.discountMode = 'Amount'  // inferred
END FOR
```

### Defect 4 — Receivables Not Updated on Payment / Cancellation

```pascal
FUNCTION isBugCondition_D4(X)
  INPUT: X of type PaymentOrCancellation
  OUTPUT: boolean

  // Bug fires when a payment is recorded or order cancelled but receivable
  // remains unchanged
  RETURN EXISTS receivable WHERE source_type = 'order_credit_sale'
                              AND source_entity_id = X.orderId
                              AND status != 'Settled'
    AND (X.action = 'payment_recorded' OR X.action = 'order_cancelled')
END FUNCTION

// Property: Fix Checking — D4 (Full Payment)
FOR ALL X WHERE X.action = 'payment_recorded'
             AND X.newPaymentStatus = 'paid' DO
  result ← createPayment'(X)
  ASSERT (SELECT status FROM receivables
          WHERE source_type = 'order_credit_sale'
            AND source_entity_id = X.orderId) = 'Settled'
    AND (SELECT outstanding_amount FROM receivables
         WHERE source_type = 'order_credit_sale'
           AND source_entity_id = X.orderId) = 0
END FOR

// Property: Fix Checking — D4 (Partial Payment)
FOR ALL X WHERE X.action = 'payment_recorded'
             AND X.newPaymentStatus = 'partial' DO
  result ← createPayment'(X)
  expectedOutstanding ← X.orderTotal - X.totalPaidAfter
  ASSERT (SELECT outstanding_amount FROM receivables
          WHERE source_type = 'order_credit_sale'
            AND source_entity_id = X.orderId) = expectedOutstanding
    AND (SELECT status FROM receivables
         WHERE source_type = 'order_credit_sale'
           AND source_entity_id = X.orderId) = 'PartiallyPaid'
END FOR

// Property: Fix Checking — D4 (Cancellation)
FOR ALL X WHERE X.action = 'order_cancelled' DO
  result ← cancelOrder'(X)
  ASSERT (SELECT status FROM receivables
          WHERE source_type = 'order_credit_sale'
            AND source_entity_id = X.orderId) = 'Settled'
END FOR

// Property: Preservation Checking — D4 (POS receivables unaffected)
FOR ALL X WHERE X.sourceType = 'pos_credit_sale' DO
  stateBefore ← getReceivable(X.receivableId)
  createPayment'(X)
  stateAfter ← getReceivable(X.receivableId)
  ASSERT stateAfter = stateBefore  // POS receivables updated by their own hook only
END FOR
```

### Defect 5 — Missing Discount Fields on OrderLineInput (same as D3 input schema)

```pascal
FUNCTION isBugCondition_D5(X)
  INPUT: X of type APIRequest to POST /orders
  OUTPUT: boolean

  // Bug fires when caller sends discount type/mode/pct fields that
  // OrderLineInput doesn't expose, causing silent field drops
  RETURN X.body.items[*].discountType IS NOT NULL
      OR X.body.items[*].discountMode IS NOT NULL
      OR X.body.items[*].discountPct  IS NOT NULL
END FUNCTION

// Property: Fix Checking — D5
FOR ALL X WHERE isBugCondition_D5(X) DO
  result ← POST_orders'(X)
  ASSERT result.lineItems[*].discountType  = X.body.items[*].discountType  // not dropped
    AND result.lineItems[*].discountMode = X.body.items[*].discountMode
    AND result.lineItems[*].discountPct  ≈ X.body.items[*].discountPct    // within 0.01
END FOR

// Property: Preservation Checking — D5 (no discount fields sent)
FOR ALL X WHERE NOT isBugCondition_D5(X) DO
  ASSERT POST_orders(X) = POST_orders'(X)
END FOR
```
