# Bugfix Requirements Document

## Introduction

This document captures requirements for eight production stability fixes in the Bookstore ERP system. The bugs span financial recognition accuracy, order payment lifecycle correctness, cancelled-order financial isolation, real-time KPI propagation, missing pagination, CSV export integrity, and dashboard KPI card navigation. No general ledger redesign or new accounting abstractions are introduced; each fix is scoped strictly to the defective behaviour described below.

---

## Bug Analysis

### Current Behavior (Defect)

**Bug 1 — Financial Recognition: Unpaid Credit Excluded from Profit/Revenue**

1.1 WHEN an order with `sale_type = 'credit_sale'` reaches FULFILLED/COMPLETED status with `payment_status = 'unpaid'` THEN the system includes the full `order.total` in Gross Profit and Net Profit calculations

1.2 WHEN an order with `sale_type = 'credit_sale'` reaches FULFILLED/COMPLETED status with `payment_status = 'partial'` THEN the system includes the full `order.total` (not just the collected portion `order.total − receivable.outstanding_amount`) in Gross Profit and Net Profit calculations

1.3 WHEN a POS transaction with `transactions.payment_status = 'credit'` is completed with no payment collected THEN the system includes the full `grand_total` in revenue and profit figures instead of zero

---

**Bug 2 — Cash Order: Confirm Must Auto-Pay and Hide Collect Action**

1.4 WHEN a cash_sale order is confirmed THEN the system may not atomically set `payment_status = 'paid'` within the same database transaction

1.5 WHEN the Payments module lists collectible orders THEN the system shows a "Collect" action for cash_sale orders

1.6 WHEN the Receivables list is displayed THEN the system may include cash_sale orders in the receivables list

---

**Bug 3 — Credit Order: Confirm Keeps Unpaid; Collect Action Available**

1.7 WHEN a credit_sale order is confirmed THEN the system may set `payment_status` to a value other than 'unpaid', or fail to create a receivable

1.8 WHEN a credit_sale order is in CONFIRMED, FULFILLED, or COMPLETED status with outstanding balance > 0 THEN the system may not display a "Collect" action in the Payments module

1.9 WHEN a partial payment is collected on a credit_sale order THEN the system may not update `payment_status` to 'partial' or may not reduce `receivable.outstanding_amount`

---

**Bug 4 — Cancelled Order: Freeze Financial Lifecycle**

1.10 WHEN an order is CANCELLED and a payment collection is attempted against it THEN the system may accept the payment instead of rejecting it

1.11 WHEN an order is CANCELLED THEN the system may still display a "Collect" action for that order in the Payments module

1.12 WHEN an order is CANCELLED THEN the system may still allow updates to its associated receivable record

1.13 WHEN an order is CANCELLED THEN the system does not write an audit log entry noting the financial freeze

---

**Bug 5 — Partial Payments: Real-Time KPI and Receivable Updates**

1.14 WHEN a partial payment is collected on a credit_sale order THEN the system may not immediately update `receivable.outstanding_amount`

1.15 WHEN a partial payment is collected THEN the system may not reflect the change in the dashboard KPI for outstanding credit within the next refresh cycle (≤ 30 seconds)

1.16 WHEN computing profit, the system may double-count a previously collected payment amount in subsequent profit calculations

---

**Bug 6 — Pagination Missing on List Pages**

1.17 WHEN any list page (Orders, Customers, Suppliers, Procurement, Returns, Exchanges, Payments, Receivables, Audit Logs) is loaded THEN the system loads all matching records in a single response with no page controls

---

**Bug 7 — CSV Export: Incomplete Columns and Stale Data**

1.18 WHEN the Sales CSV export is triggered THEN the system returns aggregated/period-grouped rows instead of one row per order/transaction, and several required columns are missing or incorrectly formatted

1.19 WHEN the Inventory CSV export is triggered THEN the system throws an error and returns no data

1.20 WHEN any CSV export is triggered THEN the system may return cached or stale data rather than querying the live database at export time

1.21 WHEN monetary values are written to a CSV export THEN the system may include currency symbols (e.g., "ETB") in the numeric fields

1.22 WHEN date fields are written to a CSV export THEN the system may use locale-specific date formats instead of ISO 8601

---

**Bug 8 — Dashboard KPI Card Navigation**

1.23 WHEN a clickable KPI card on the dashboard is clicked THEN the system may navigate to the target page without carrying the current branch filter, date range, or status filter

1.24 WHEN the "Monthly Sales" KPI card is clicked THEN the system may navigate to POS/Orders without filtering by the current month

1.25 WHEN the "Pending Orders" KPI card is clicked THEN the system may navigate to Orders without filtering by `status = pending/confirmed`

1.26 WHEN the "Outstanding Credit" KPI card is clicked THEN the system may navigate to Receivables without filtering by `status = unpaid/partial`

1.27 WHEN the "Low Stock" KPI card is clicked THEN the system may navigate to Inventory without the `low_stock_only = true` filter

1.28 WHEN the "Procurement Expense" KPI card is clicked THEN the system may navigate to Procurement without filtering by the current month

---

### Expected Behavior (Correct)

**Bug 1 — Financial Recognition**

2.1 WHEN an order with `sale_type = 'cash_sale'` is confirmed THEN the system SHALL recognize the full `order.total` as revenue immediately, regardless of fulfillment status

2.2 WHEN an order with `sale_type = 'credit_sale'` has `payment_status = 'unpaid'` THEN the system SHALL exclude that order's `total` from recognized revenue and profit; `profit.service.ts` Q1 SHALL filter `AND (o.sale_type != 'credit_sale' OR o.payment_status != 'unpaid')` before summing

2.3 WHEN an order with `sale_type = 'credit_sale'` has `payment_status = 'partial'` THEN the system SHALL recognize only the collected portion as revenue; collected portion is computed as `o.total − r.outstanding_amount` where `r` is the matching row in `receivables` with `source_type = 'order_credit_sale' AND source_entity_id = o.id`

2.4 WHEN a POS transaction has `transactions.payment_status = 'credit'` THEN the system SHALL exclude that transaction's `grand_total` from recognized revenue and profit; `profit.service.ts` Q7 SHALL filter `AND t.payment_status != 'credit'` when summing POS revenue

2.5 WHEN a credit sale payment is collected (full or partial) THEN the system SHALL recognize the newly collected amount (`r.original_amount − r.outstanding_amount`) as revenue in the next KPI refresh; no separate payment-amount sum from `order_payments` is needed — the receivable's collected portion is the single source

---

**Bug 2 — Cash Order**

2.6 WHEN a cash_sale order transitions to CONFIRMED THEN the system SHALL atomically set `payment_status = 'paid'` in the same database transaction as the status update — no receivable SHALL be created

2.7 WHEN the Payments module renders the list of collectible orders THEN the system SHALL never display a "Collect" action for any order with `sale_type = 'cash_sale'`

2.8 WHEN the Receivables list is queried THEN the system SHALL never include orders with `sale_type = 'cash_sale'`

---

**Bug 3 — Credit Order**

2.9 WHEN a credit_sale order transitions to CONFIRMED THEN the system SHALL set `payment_status = 'unpaid'` and create exactly one receivable record with `outstanding_amount = order.total`

2.10 WHEN a credit_sale order is in CONFIRMED, FULFILLED, or COMPLETED status AND `payment_status IN ('unpaid', 'partial')` THEN the system SHALL display a "Collect" action in the Payments module

2.11 WHEN a partial payment is collected on a credit_sale order THEN the system SHALL update `payment_status = 'partial'` AND reduce `receivable.outstanding_amount` by the collected amount within the same transaction

---

**Bug 4 — Cancelled Order**

2.12 WHEN a payment collection is attempted against a CANCELLED order THEN the system SHALL reject the request with HTTP 422 and error code `ORDER_CANCELLED`

2.13 WHEN the Payments module renders collectible orders THEN the system SHALL hide the "Collect" action for any order with status CANCELLED

2.14 WHEN an order is CANCELLED THEN the system SHALL prevent any further updates to `receivable.outstanding_amount` or receivable status for that order

2.15 WHEN an order transitions to CANCELLED THEN the system SHALL write an audit log entry with `action = 'CANCEL'` and a meta note indicating the financial lifecycle is frozen

---

**Bug 5 — Partial Payments Real-Time Updates**

2.16 WHEN any payment (full or partial) is collected on an order THEN the system SHALL immediately (within the same transaction) update `receivable.outstanding_amount` to `order.total − total_collected`

2.17 WHEN any payment (full or partial) is collected on an order THEN the system SHALL immediately update `order.payment_status` to 'partial' or 'paid' as appropriate within the same transaction

2.18 WHEN any payment is collected THEN the system SHALL update the realized revenue used in profit calculations so the next KPI refresh (≤ 30 s) reflects the new collected amount

2.19 WHEN computing profit for an order with multiple payment records THEN the system SHALL include each payment amount exactly once — previously collected amounts SHALL NOT be re-included in subsequent calculations

---

**Bug 6 — Pagination**

2.20 WHEN a list page endpoint is called without `page` or `pageSize` query parameters THEN the system SHALL return the first 25 records and include `{ total, page, totalPages }` in the response envelope

2.21 WHEN a list page endpoint is called with `page` and `pageSize` query parameters THEN the system SHALL return only the records for the requested page slice using server-side LIMIT/OFFSET

2.22 WHEN a list page is rendered in the frontend THEN the system SHALL display page navigation controls showing the current page number and total record count

---

**Bug 7 — CSV Export**

2.23 WHEN the Sales CSV export is triggered THEN the system SHALL return exactly one row per order/transaction with all 15 columns: `order_reference, date, customer_name, sale_type, fulfillment_status, subtotal, discount_normal, discount_merchant, discount_special, total_discount, purchase_cost, net_profit, payment_status, collected_amount, outstanding_amount`

2.24 WHEN the Inventory CSV export is triggered THEN the system SHALL return one row per book-location combination with 11 columns: `book_id, isbn, title, location_id, location_name, opening_stock, stock_in, stock_out, reserved, returned, closing_stock` — with no errors

2.25 WHEN the Procurement CSV export is triggered THEN the system SHALL return one row per PO line item with 11 columns: `po_reference, date, supplier_name, book_title, isbn, quantity_ordered, quantity_received, unit_cost, line_total, status, notes`

2.26 WHEN the Receivables CSV export is triggered THEN the system SHALL return one row per receivable with 9 columns: `receivable_reference, customer_name, order_reference, original_amount, collected_amount, outstanding_amount, status, due_date, created_at`

2.27 WHEN any CSV export is triggered THEN the system SHALL query the live database at export time — no cached or previously computed result sets SHALL be used

2.28 WHEN any CSV export is triggered THEN the system SHALL write all monetary values as plain numerics without currency symbols, all dates in ISO 8601 format (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ssZ), and encode the file as UTF-8 with BOM

---

**Bug 8 — Dashboard KPI Card Navigation**

2.29 WHEN the "Monthly Sales" KPI card is clicked THEN the system SHALL navigate to the POS/Orders page pre-filtered with `dateFrom = first day of current month`, `dateTo = today`, and the current `branchId`

2.30 WHEN the "Pending Orders" KPI card is clicked THEN the system SHALL navigate to the Orders page pre-filtered with `status = pending,confirmed` and the current `branchId`

2.31 WHEN the "Outstanding Credit" KPI card is clicked THEN the system SHALL navigate to the Receivables page pre-filtered with `status = unpaid,partial` and the current `branchId`

2.32 WHEN the "Low Stock" KPI card is clicked THEN the system SHALL navigate to the Inventory page pre-filtered with `low_stock_only = true` and the current `branchId`

2.33 WHEN the "Procurement Expense" KPI card is clicked THEN the system SHALL navigate to the Procurement page pre-filtered with `dateFrom = first day of current month`, `dateTo = today`, and the current `branchId`

2.34 WHEN any non-aggregate KPI card (Gross Profit, Today's Net Profit, Monthly Net Profit, Discount Total) is rendered THEN the system SHALL render it without an `onClick` handler — it SHALL NOT be navigable

---

### Unchanged Behavior (Regression Prevention)

3.1 WHEN an order has `sale_type = 'cash_sale'` THEN the system SHALL CONTINUE TO count it as fully recognized revenue and profit immediately upon confirmation

3.2 WHEN a POS transaction has `payment_type = 'cash'` THEN the system SHALL CONTINUE TO count it as fully recognized revenue immediately upon completion

3.3 WHEN a credit sale receivable is fully settled THEN the system SHALL CONTINUE TO reflect the full order total in recognized revenue

3.4 WHEN a cash_sale order is confirmed THEN the system SHALL CONTINUE TO reserve inventory and decrement stock atomically as part of confirmation

3.5 WHEN a cash_sale order is confirmed and paid THEN the system SHALL CONTINUE TO allow fulfillment to proceed to COMPLETED

3.6 WHEN a credit_sale order reaches CONFIRMED status THEN the system SHALL CONTINUE TO reserve and decrement inventory stock

3.7 WHEN a credit_sale order is fully paid THEN the system SHALL CONTINUE TO set `payment_status = 'paid'` and mark the receivable as Settled

3.8 WHEN an order in DRAFT status is cancelled THEN the system SHALL CONTINUE TO release any inventory reservations made for that order

3.9 WHEN a non-cancelled order is paid THEN the system SHALL CONTINUE TO allow payment collection without error

3.10 WHEN a cash_sale order is confirmed THEN the system SHALL CONTINUE TO reflect the full order total as immediately recognized revenue

3.11 WHEN a full payment is collected on a credit_sale order THEN the system SHALL CONTINUE TO mark the receivable as Settled and set `payment_status = 'paid'`

3.12 WHEN a list endpoint is called with filter parameters (branchId, status, dateFrom, dateTo) THEN the system SHALL CONTINUE TO apply those filters before paginating

3.13 WHEN a list endpoint is called with `pageSize > 100` THEN the system SHALL CONTINUE TO cap the result set at 100 records per page

3.14 WHEN a CSV export is triggered with `branchId` or date-range filters THEN the system SHALL CONTINUE TO apply those filters before generating the export

3.15 WHEN a CSV export is triggered by a user without the appropriate role THEN the system SHALL CONTINUE TO return HTTP 403

3.16 WHEN the "Today's Sales" KPI card is clicked THEN the system SHALL CONTINUE TO navigate to the POS/Orders page

3.17 WHEN dashboard filter values (branchId, dateFrom, dateTo) are changed by the user THEN the system SHALL CONTINUE TO pass the updated filter values to all card navigation targets
