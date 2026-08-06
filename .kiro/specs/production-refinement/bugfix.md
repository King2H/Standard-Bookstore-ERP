# Bugfix Requirements Document

## Introduction

This document captures the production refinement requirements for the Standard Bookstore ERP system. Six distinct bugs are addressed: (1) book search in procurement and other transactional modules is scoped to the current paginated page instead of the full catalog; (2) the dashboard KPI reports gross sales rather than real net profit, mixing unfulfilled and credit orders into the total; (3) the order lifecycle enforces transitions inconsistently — CASH and CREDIT orders follow different inventory deduction paths and the payment-before-fulfillment gate blocks valid credit flows; (4) there is no safe, scoped maintenance command to reset demo/test data without destroying seed records; (5) the inventory page is fragile under load, balance inconsistencies can accumulate silently, and critical lifecycle integration scenarios lack automated coverage; and (6) CSV export reports have incorrect or missing column definitions and produce spreadsheet-incompatible numeric and date formatting. All inventory mutations must continue to flow exclusively through `inventoryTransactions.service.ts`.

---

## Bug Analysis

### Current Behavior (Defect)

**Bug 1 — Unified Catalog Search**

1.1 WHEN a user types a search term in the Procurement PO line-item picker THEN the system searches only the books already loaded in the current paginated page, returning no results for books outside that page

1.2 WHEN a user searches for a book by barcode or publisher name in any transactional module (Procurement, Stock In, POS, Orders, Inventory, Returns, Exchanges) THEN the system returns no results because barcode and publisher are not included in the search predicate

1.3 WHEN a user types a search term in Procurement that matches a book on page 3 of the catalog THEN the system returns an empty result set because the search never reaches the server

**Bug 2 — Real Profit Calculation**

2.1 WHEN the dashboard KPI "Total Revenue" is displayed THEN the system shows gross sales totals that include unpaid credit orders, treating outstanding receivables as collected cash

2.2 WHEN a credit order is fulfilled but payment has not been collected THEN the system counts the full order value as revenue in dashboard KPIs and reports

2.3 WHEN discounts of type Normal, Merchant, or Special are applied to an order or POS transaction THEN the system does not subtract all discount types from the profit figure, overstating profit

2.4 WHEN the dashboard and the reports module compute profit THEN the system uses different calculation sources, producing inconsistent totals across screens

2.5 WHEN purchase cost is available from procurement records or inventory valuation THEN the system ignores purchase cost and reports revenue instead of net profit, overstating margin

**Bug 3 — Standard Strict Order Lifecycle**

3.1 WHEN a CASH order is confirmed THEN the system does not always set `payment_status = 'paid'` immediately, creating an inconsistent state where a paid sale appears unpaid

3.2 WHEN a CREDIT order is in CONFIRMED status with no payment THEN the system blocks fulfillment with a payment-status gate, preventing a valid credit workflow where goods are dispatched before payment is collected

3.3 WHEN the payment collection endpoint is called on a FULFILLED or COMPLETED credit order THEN the system rejects the request with a status error, making post-fulfillment payment collection impossible

3.4 WHEN an order is cancelled after CONFIRMED status THEN the system does not always restore inventory through `inventoryTransactions.service.ts`, leaving reserved stock permanently locked

3.5 WHEN fulfillment is attempted on a CANCELLED or DRAFT order THEN the system does not consistently reject the request, risking inventory corruption

3.6 WHEN order lifecycle state transitions occur THEN the API response does not document the allowed next actions, leaving the frontend to guess valid transitions

**Bug 4 — Clean Test and Duplicate Data Safely**

4.1 WHEN an administrator needs to remove test/demo data before go-live THEN the system provides no admin-only maintenance command, forcing dangerous manual SQL deletions

4.2 WHEN a developer runs a data reset THEN the system provides no dry-run mode, giving no visibility into what will be deleted before the operation executes

4.3 WHEN a data reset command is executed THEN the system does not distinguish between transactional data (orders, payments, inventory transactions) and core seed data (users, roles, catalog records, opening balances), risking loss of master data

4.4 WHEN a data reset is triggered without explicit confirmation THEN the system proceeds with deletion without a confirmation prompt, offering no last-chance safety net

**Bug 6 — CSV Export Reports**

6.1 WHEN a user requests a CSV export from any report screen THEN the system produces a file with incorrect or missing column headers, making the export unusable in spreadsheet tools

6.2 WHEN a Sales report is exported to CSV THEN the system omits key fields such as order reference, sale type (Cash/Credit), fulfillment status, discount amounts, and net profit per line

6.3 WHEN an Inventory report is exported THEN the system omits book code/SKU, current quantity, reserved quantity, and last movement date

6.4 WHEN a Procurement report is exported THEN the system omits PO reference, supplier name, received quantity, unit cost, and total cost

6.5 WHEN a Receivables report is exported THEN the system omits customer name, order reference, original amount, collected amount, outstanding amount, and due date

6.6 WHEN numeric fields (amounts, quantities) appear in CSV THEN the system exports them as formatted strings with currency symbols, preventing numeric operations in spreadsheet tools

**Bug 5 — Stability Checks**

5.1 WHEN the Inventory page is opened THEN the system occasionally fails to load with a 500 error and provides no retry mechanism, leaving the page permanently broken until a manual refresh

5.2 WHEN `inventory.quantity` drifts out of sync with `inventory_history` ledger entries THEN the system has no reconciliation path to detect or repair the inconsistency

5.3 WHEN the confirm → fulfill lifecycle is executed in an integration test environment THEN there are no automated tests verifying that stock is deducted exactly once (at confirm) and not again at fulfill

5.4 WHEN a credit order is fulfilled before any payment THEN there is no integration test verifying that fulfillment succeeds and the receivable remains open

5.5 WHEN payment is recorded after fulfillment on a credit order THEN there is no integration test verifying that the receivable balance is correctly reduced

5.6 WHEN the profit calculation is computed THEN there are no integration tests verifying the formula against a known dataset

5.7 WHEN a catalog search is executed for a term that matches books beyond the first page THEN there are no integration tests verifying that results are returned independently of pagination state

5.8 WHEN `resetDemoData()` is executed THEN there are no integration tests verifying that seed data is preserved after the reset

---

### Expected Behavior (Correct)

**Bug 1 — Unified Catalog Search**

2.1 WHEN a user types a search term of 2 or more characters in any transactional module (Procurement, Stock In, POS, Orders, Inventory, Returns, Exchanges) THEN the system SHALL execute a server-side full-text search against the entire catalog, independent of pagination state

2.2 WHEN a user searches by any of title, ISBN, barcode, author name, publisher name, or book code/SKU THEN the system SHALL return all matching catalog records (case-insensitive substring match) regardless of which page those records appear on in a non-search listing

2.3 WHEN the same search term is submitted from any two different transactional modules THEN the system SHALL return the same set of catalog records, confirming that a single shared search endpoint and predicate is used

2.4 WHEN a search term is entered in Procurement's PO line-item picker THEN the system SHALL return matching results from the full book catalog via a shared server-side search, not from the local in-memory page buffer

2.4a WHEN a search term produces no catalog matches THEN the system SHALL return an empty result set with HTTP 200 and an explicit `results: []` payload — not an error response

**Bug 2 — Real Profit Calculation**

2.5 WHEN the dashboard KPI "Net Profit" is displayed THEN the system SHALL calculate: Net Profit = Fulfilled Sales Revenue − Purchase Cost of Fulfilled Items − Discounts (Normal + Merchant + Special) − Returns ± Exchange Adjustments, using fulfilled quantities only

2.6 WHEN a credit order has been fulfilled but not yet paid THEN the system SHALL NOT include that order's value in the Net Profit or Cash Revenue KPI until payment is collected

2.7 WHEN the dashboard shows revenue breakdowns THEN the system SHALL separately display: Cash Sales Revenue, Credit Sales Revenue (fulfilled), Collected Credit Revenue, and Outstanding Receivables as distinct line items

2.8 WHEN the reports module computes profit THEN the system SHALL use the same calculation source and formula as the dashboard, producing consistent totals

2.9 WHEN purchase cost is available in procurement records or inventory valuation THEN the system SHALL use that cost as the cost-of-goods-sold component in the profit formula

**Bug 3 — Standard Strict Order Lifecycle**

2.10 WHEN a CASH order is confirmed THEN the system SHALL, within a single database transaction: set `payment_status = 'paid'`, write an `inventory_history` row with `reference_type = 'order_confirmed'`, and reduce `inventory.quantity` — if any step fails the entire transaction rolls back

2.11 WHEN a CREDIT order is confirmed THEN the system SHALL, within a single database transaction: create a `receivables` record with `outstanding_amount = order total`, write an `inventory_history` row with `reference_type = 'order_confirmed'`, reduce `inventory.quantity`, and set `payment_status = 'unpaid'` — no payment is required

2.12 WHEN fulfillment is requested for an order in CONFIRMED, PARTIALLY_PAID, or PAID status THEN the system SHALL write an `inventory_history` row with `reference_type = 'order_fulfilled'` and transition the reservation status to 'deducted' — `inventory.quantity` SHALL remain unchanged at this step

2.13 WHEN a payment collection request is made on a FULFILLED or COMPLETED CREDIT order with `receivables.outstanding_amount > 0` THEN the system SHALL reduce `receivables.outstanding_amount` by the payment amount; IF the resulting outstanding amount equals zero THEN `payment_status` SHALL be set to 'paid'; IF it is greater than zero THEN `payment_status` SHALL be set to 'partially_paid'

2.14 WHEN an order in CONFIRMED, PARTIALLY_PAID, or PAID status is cancelled THEN the system SHALL, within a single database transaction: write an `inventory_history` row with `reference_type = 'order_cancelled'`, increment `inventory.quantity` by the previously deducted amount, and release the reservation record — if any step fails the entire transaction rolls back

2.15 IF an order is in FULFILLED or COMPLETED status AND a cancellation request is received THEN the system SHALL reject the request with HTTP 422 and error code `ORDER_ALREADY_FULFILLED`, and the response body SHALL instruct the caller to use the Return workflow

2.16 WHEN any order lifecycle transition occurs THEN the API response SHALL include an `allowedActions` array; the array SHALL contain: `['pay','fulfill','cancel']` for CONFIRMED cash orders; `['fulfill','cancel']` for CONFIRMED credit orders; `['pay','fulfill']` for PARTIALLY_PAID orders; `['fulfill']` for PAID orders; `['return']` for FULFILLED orders; `[]` for CANCELLED orders

**Bug 4 — Clean Test and Duplicate Data Safely**

2.17 WHEN an administrator calls `resetDemoData()` THEN the system SHALL delete all rows from the following tables (in dependency order to respect FK constraints): `order_items`, `orders`, `payments`, `receivables`, `inventory_reservations`, `inventory_history`, `procurement_order_items`, `procurement_orders`, `return_items`, `returns`, `exchange_items`, `exchanges`, `pos_transactions`, `pos_transaction_items`, `customers`, `suppliers` (non-seeded) — and no other tables

2.18 WHEN `resetDemoData()` is called THEN the system SHALL leave the following tables fully intact: `staff`, `staff_branch_roles`, `roles`, `permissions`, `role_permissions`, `branches`, `locations`, `system_config`, `books`, `authors`, `categories`, `publishers`, `book_authors`, `book_categories`, `book_prices`, `inventory` (quantity reset to opening balance), and all lookup/reference tables; the command SHALL fail with a clear error if any of these tables would be affected

2.19 WHEN `resetDemoData()` is invoked with `--dry-run` THEN the system SHALL print to stdout the table name and row count that would be deleted for each affected table, then exit without executing any DELETE statement

2.20 WHEN `resetDemoData()` is run without `--dry-run` THEN the system SHALL print the affected table names and row counts, prompt "Type YES to confirm deletion:" and proceed only if the operator types exactly "YES"; any other input SHALL abort without deleting

2.20a WHEN any DELETE statement inside `resetDemoData()` fails THEN the system SHALL roll back the entire operation atomically and exit with a non-zero status code, leaving the database unchanged

**Bug 6 — CSV Export Reports**

2.29 WHEN a Sales report is exported to CSV THEN the system SHALL produce a file with the following columns in order: `order_reference`, `date`, `customer_name`, `sale_type` (Cash/Credit), `fulfillment_status`, `subtotal`, `discount_normal`, `discount_merchant`, `discount_special`, `total_discount`, `purchase_cost`, `net_profit`, `payment_status`, `collected_amount`, `outstanding_amount`

2.30 WHEN an Inventory report is exported to CSV THEN the system SHALL produce a file with the following columns: `book_code`, `isbn`, `title`, `author`, `category`, `publisher`, `quantity_on_hand`, `quantity_reserved`, `quantity_available`, `unit_cost`, `last_movement_date`

2.31 WHEN a Procurement report is exported to CSV THEN the system SHALL produce a file with the following columns: `po_reference`, `date`, `supplier_name`, `status`, `book_code`, `title`, `ordered_quantity`, `received_quantity`, `unit_cost`, `line_total`, `po_total`

2.32 WHEN a Receivables report is exported to CSV THEN the system SHALL produce a file with the following columns: `order_reference`, `date`, `customer_name`, `original_amount`, `collected_amount`, `outstanding_amount`, `due_date`, `days_overdue`, `payment_status`

2.33 WHEN any numeric field (amount, quantity, cost) is written to a CSV export THEN the system SHALL write it as a plain unformatted number without currency symbols, thousand separators, or units (e.g., `1250.00` not `$1,250.00`) so spreadsheet tools can perform arithmetic directly

2.34 WHEN a date field is written to a CSV export THEN the system SHALL format it as `YYYY-MM-DD` ISO 8601

2.35 WHEN a CSV file is generated THEN the system SHALL use UTF-8 encoding with a BOM prefix so that Microsoft Excel opens it correctly without encoding errors

**Bug 5 — Stability Checks**

2.21 WHEN the Inventory page endpoint is called THEN the system SHALL return HTTP 200 with inventory data; WHERE a transient database error occurs THEN the API SHALL retry the query up to 2 times with 200 ms back-off before returning HTTP 503; the frontend SHALL display a "Failed to load — Retry" button when it receives a non-200 response

2.22 WHEN the reconciliation command is executed THEN the system SHALL: (a) for each book, compute `expected_quantity = SUM(delta) FROM inventory_history WHERE book_id = ?`; (b) WHERE `inventory.quantity ≠ expected_quantity` THEN update `inventory.quantity` to the computed value and log the correction; (c) SET `inventory_reservations.status = 'released'` for all reservations whose linked order has `status IN ('FULFILLED', 'COMPLETED', 'CANCELLED')`

2.23 WHEN the confirm → fulfill lifecycle integration test is executed THEN the test SHALL assert: `inventory.quantity` decreases by the order quantity after confirm; `inventory.quantity` is unchanged after fulfill; exactly one `inventory_history` row with `reference_type = 'order_confirmed'` exists for the order; exactly one `inventory_history` row with `reference_type = 'order_fulfilled'` exists for the order

2.24 WHEN a credit order is fulfilled before any payment in an integration test THEN the test SHALL assert: the fulfill call returns HTTP 200; `order.status = 'FULFILLED'`; `receivables.outstanding_amount = original order total`; `payment_status = 'unpaid'`

2.25 WHEN payment is recorded after fulfillment in an integration test THEN the test SHALL assert: `receivables.outstanding_amount` decreases by the payment amount; WHERE full payment is made THEN `payment_status = 'paid'`; WHERE partial payment is made THEN `payment_status = 'partially_paid'`; `inventory.quantity` is unchanged by the payment call

2.26 WHEN the profit calculation integration test is executed against a fixture dataset (2 cash orders, 1 credit order with partial payment, 1 return, 1 merchant discount, 1 exchange) THEN the test SHALL assert the computed Net Profit equals the hand-calculated expected value derived from: fulfilled revenue only, purchase cost per unit from procurement records, all three discount types summed, return value subtracted, exchange adjustment applied

2.27 WHEN the catalog search integration test is executed with a term that matches a book seeded on page 3 of the default sort order THEN the test SHALL assert the response contains that book's record and the total result count is ≥ 1, regardless of the `page` or `limit` parameters

2.28 WHEN the `resetDemoData()` integration test is executed THEN the test SHALL assert after the reset: all rows in `staff` table with `id IN (1, 2)` are intact; all seeded `books`, `authors`, `categories`, `publishers` records exist; `inventory.quantity` for each book equals its opening balance value; all tables listed in 2.17 have 0 rows

---

### Unchanged Behavior (Regression Prevention)

3.1 WHEN inventory is modified through any code path THEN the system SHALL CONTINUE TO route all mutations exclusively through `inventoryTransactions.service.ts` — no module shall execute direct `UPDATE inventory SET quantity = ...` statements

3.2 WHEN a POS cash transaction is completed with full payment THEN the system SHALL CONTINUE TO atomically decrement `inventory.quantity` via `inventoryTransactions.service.ts stockOut()`, create a `pos.sale_completed` outbox event, and record a `sale` reference_type in `inventory_history` — unchanged by this fix

3.3 WHEN a DRAFT order is created THEN the system SHALL CONTINUE TO leave `inventory.quantity` unchanged with no `inventory_history` rows for that order

3.4 WHEN `confirm()` is called on a CASH or CREDIT order THEN the system SHALL CONTINUE TO call `inventoryTransactions.service.ts stockOut()` with `reference_type = 'order_confirmed'` to physically deduct available stock

3.5 WHEN a POS credit sale is created THEN the system SHALL CONTINUE TO create a `pos_credit_sale` receivable record unaffected by any order payment operation

3.6 WHEN `computeOrderAllowedActions('FULFILLED', ...)` is called THEN the system SHALL CONTINUE TO return `['return']` unchanged

3.7 WHEN `computeOrderAllowedActions('CANCELLED', ...)` is called THEN the system SHALL CONTINUE TO return `[]` unchanged

3.8 WHEN procurement receives goods via `receivePO()` THEN the system SHALL CONTINUE TO call `inventoryTransactions.service.ts stockIn()` with `reference_type = 'purchase_order'`, unchanged by this fix

3.9 WHEN the catalog search endpoint is called with `?q=` THEN the system SHALL CONTINUE TO search by title, author name, and ISBN/SKU as it does today — the fix extends the search fields without removing existing ones

3.10 WHEN a return is processed with `disposition = 'SELLABLE'` THEN the system SHALL CONTINUE TO increment `inventory.quantity` via `inventoryTransactions.service.ts stockIn()`

3.11 WHEN an exchange is settled THEN the system SHALL CONTINUE TO process all inventory mutations atomically inside a single database transaction via `inventoryTransactions.service.ts`
