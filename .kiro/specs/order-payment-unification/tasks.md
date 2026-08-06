# Order Payment Unification — Tasks

## Task List

- [x] 1. Database Migration
  - [x] 1.1 Create migration `1700000038_order_sale_type.cjs` — add `sale_type` to `orders` and extend `receivables.source_type` CHECK constraint to include `'order_credit_sale'`

- [x] 2. Backend — Receivables Service
  - [x] 2.1 Add `'order_credit_sale'` to `ReceivableSourceType` union type in `receivables.service.ts`

- [x] 3. Backend — Orders Service
  - [x] 3.1 Extend `OrderLineInput` with optional `discountPct`, `discountType`, `discountMode` fields
  - [x] 3.2 Extend `OrderRow` with `saleType` and `discountTotal` fields; update `mapOrderRow()`
  - [x] 3.3 Update `create()` — accept `saleType`, validate credit-sale requires customer, wire discount engine, persist new fields
  - [x] 3.4 Update `confirm()` — create receivable for unpaid/partial orders via savepoint
  - [x] 3.5 Update `cancel()` — settle any open `order_credit_sale` receivable via savepoint
  - [x] 3.6 Remove `'pay'` from `computeOrderAllowedActions()` — all status branches

- [x] 4. Backend — Orders Routes
  - [x] 4.1 Update `POST /orders` route to pass `saleType` from request body
  - [x] 4.2 Change `POST /orders/:id/pay` to return HTTP 410 Gone (deprecated)

- [ ] 5. Backend — Payments Service
  - [x] 5.1 Update `createPayment()` — after updating `payment_status`, query for `order_credit_sale` receivable and call `updateReceivableOnPayment()` inside the same transaction (savepoint-guarded)

- [ ] 6. Frontend — OrdersPage
  - [x] 6.1 Remove "Take Payment" button and pay modal from `OrdersPage`
  - [x] 6.2 Add `saleType` radio toggle (Cash Sale / Credit Sale) in New Order form
  - [x] 6.3 Add per-line-item discount UI (type, mode, value) in New Order form
  - [x] 6.4 Update `orderItems` state type and `submitOrder()` to include `saleType` and discount fields
  - [x] 6.5 Show `saleType` badge on the orders list table

- [ ] 7. Tests
  - [ ] 7.1 Write unit tests for `computeOrderAllowedActions()` — verify `'pay'` removed from CONFIRMED state
  - [ ] 7.2 Write unit tests for discount engine integration — percentage mode, amount mode, cap enforcement, backward-compat
  - [ ] 7.3 Write integration tests for receivable creation at `confirm()` — unpaid, partial, fully-paid, credit-sale
  - [ ] 7.4 Write integration tests for receivable update at `createPayment()` — full and partial payment
  - [ ] 7.5 Write integration tests for receivable settle at `cancel()` — confirmed order with receivable
  - [ ] 7.6 Write preservation tests — POS/Exchange unaffected, legacy discountAmount-only, payments on orders without receivable
