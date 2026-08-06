# Production Refinement Bugfix Design

## Overview

Six distinct production bugs are addressed in this design. All inventory mutations continue to
flow exclusively through `inventoryTransactions.service.ts` — no other module may issue a
direct `UPDATE inventory SET quantity = ...` statement.

**Architecture constraint (hard):** `inventoryTransactions.service.ts` is the ONLY inventory
mutation engine. New utilities introduced by this fix (search service, profit module, CSV
builder, reset script) must never bypass this service.

The six fix areas are:

| # | Area | Root Files Changed |
|---|------|--------------------|
| 1 | Unified Catalog Search | `catalog.service.ts`, new `catalogSearch.service.ts`, consumer call-sites |
| 2 | Real Profit Calculation | new `profit.service.ts`, `reports.service.ts`, `reports.routes.ts` |
| 3 | Strict Order Lifecycle | `orders.service.ts` (confirm, fulfill, pay, cancel, allowedActions) |
| 4 | resetDemoData() Script | new `scripts/reset-demo-data.mjs` |
| 5 | Stability | `inventory.routes.ts`, `scripts/reconcile-inventory.mjs`, new integration tests |
| 6 | CSV Export | new `lib/csvBuilder.ts`, `reports.routes.ts` |

---

## Glossary

- **Bug_Condition (C)**: A predicate that evaluates `true` for every input that triggers a bug.
- **Property (P)**: The correct observable outcome when a bug-condition input is processed by the fixed code.
- **Preservation**: All behaviors for inputs where `C(X) = false` must remain byte-for-byte identical to the original implementation.
- **`inventoryTransactions.service.ts`**: The centralised inventory mutation pipeline — `stockIn`, `stockOut`, `adjust`, `transfer`, `fulfillReservation`. No other module may mutate `inventory.quantity` directly.
- **Fulfilled Revenue**: Revenue from orders whose `status` is `FULFILLED` or `COMPLETED` and, for credit orders, whose `receivables.outstanding_amount = 0` (i.e. fully collected). Unfulfilled or unpaid credit orders do not contribute to net profit.
- **isBugCondition**: A pseudocode function used below to identify inputs that trigger each bug.
- **F (original)**: The function before the fix. **F′ (fixed)**: The function after the fix.
- **State machine**: The set of valid `(status, saleType)` → allowed-transitions mappings enforced by `orders.service.ts`.


---

## Bug Details

## Bug 1 — Unified Catalog Search

### Bug Condition

The bug manifests when a transactional module (Procurement, Stock In, POS, Orders, Inventory,
Returns, Exchanges) searches for books. Currently `searchBooks()` in `catalog.service.ts` is
called with the `page`/`pageSize` that the listing UI is on, so `OFFSET` moves the search
window away from many matching rows. Additionally, `barcode` and `publisher` are absent from
the `q` predicate — searching by those fields always returns zero results.

```
FUNCTION isBugCondition(input)
  INPUT: input of type SearchRequest { q, page, pageSize, callerModule }
  OUTPUT: boolean

  RETURN (
    // Client-side filter only — search term never reaches the server with full catalog scope
    input.callerModule IN ['Procurement', 'StockIn', 'POS', 'Orders', 'Inventory', 'Returns', 'Exchanges']
    AND input.q IS NOT NULL
    AND (
      // Book exists in catalog but is beyond the requested page window
      matchingBookPageNumber(input.q) > input.page
      // OR the search field is one of the unsupported ones
      OR input.q MATCHES_ONLY_BY [barcode, publisher]
    )
  )
END FUNCTION
```

**Concrete examples:**
- User types "978-99944" (an ISBN) in Procurement's PO picker while on page 1; the book is
  seeded at catalog row 52 (page 3 at default page-size 25). Result: empty. Expected: the book.
- User types "Addis Ababa University Press" (publisher) in any module. Result: empty. Expected:
  all books by that publisher.
- User types a barcode string "B001234" in POS item search. Result: empty. Expected: matching book.

### Shared Server-Side Catalog Search Service

**New file:** `apps/api/src/modules/catalog/catalogSearch.service.ts`

This is a pure search function — no mutation, no pagination offset applied to the full-catalog
search path. It is the single shared implementation consumed by all seven modules.

```
FUNCTION catalogSearch(q, fields, limit)
  INPUT:
    q      — search term (≥ 2 chars, case-insensitive substring)
    fields — subset of {title, isbn, barcode, author, publisher, code/sku}
             (default: all six fields)
    limit  — max results to return (default 50, max 200)
  OUTPUT: BookRecord[]  // same shape as catalog.service.ts BookRecord

  // NO OFFSET. Always scans entire catalog.
  SQL:
    WHERE (
      lower(b.title)     LIKE lower('%' || q || '%')
      OR b.isbn          LIKE '%' || normalizedQ || '%'
      OR lower(b.sku)    LIKE lower('%' || q || '%')
      OR lower(b.barcode) LIKE lower('%' || q || '%')    -- NEW FIELD
      OR lower(p.name)   LIKE lower('%' || q || '%')     -- NEW FIELD (publishers join)
      OR EXISTS (
        SELECT 1 FROM book_authors ba JOIN authors a ON a.id = ba.author_id
        WHERE ba.book_id = b.id AND lower(a.name) LIKE lower('%' || q || '%')
      )
    )
    AND b.is_active = true
    LIMIT limit
END FUNCTION
```

**New endpoint:** `GET /api/catalog/search?q=&limit=&branchId=`

This endpoint is consumed by all transactional modules. The existing `GET /api/catalog` list
endpoint with pagination is preserved unchanged for the catalog management UI.

**Consumer integration pattern** (same for all seven modules):

```typescript
// When search term is present (≥ 2 chars), call the shared search endpoint.
// When search term is absent/short, fall back to the existing paginated list.
if (q && q.length >= 2) {
  results = await catalogSearchService.search(q, { branchId, limit: 50 });
} else {
  results = await catalogService.searchBooks({ page, pageSize, branchId, ...filters });
}
```

**Preservation (3.9):** The existing `searchBooks()` function is not modified. The new
`catalogSearch.service.ts` function is additive. Existing title/author/ISBN/SKU search
behaviour in the catalog management screen is unchanged.


---

## Bug 2 — Real Profit Calculation

### Bug Condition

```
FUNCTION isBugCondition(input)
  INPUT: input of type KpiRequest | ReportRequest
  OUTPUT: boolean

  RETURN (
    // Dashboard KPI uses gross sales — includes unfulfilled and unpaid credit orders
    input.caller = 'getKpis'
    AND (
      includesUnfulfilledOrders(input)
      OR includesUnpaidCreditOrders(input)
      OR ignoresPurchaseCost(input)
      OR ignoresAllDiscountTypes(input)
    )
  )
  OR (
    // Reports module uses a different calculation than dashboard — inconsistency
    input.caller = 'getSalesReport'
    AND calculationDiffersFromKpis(input)
  )
END FUNCTION
```

**Concrete examples:**
- Credit order #101 for 500 ETB is confirmed but never paid. `getKpis()` currently adds 500 ETB
  to `monthlySales`. Expected: 0 ETB contribution until payment is collected.
- An order has a Merchant Discount of 100 ETB. Current profit ignores it. Expected: 100 ETB
  deducted from net profit.
- A book was purchased at 200 ETB (procurement record). Current KPI shows revenue of 500 ETB
  as "profit". Expected: net profit = 500 − 200 − discounts − returns.

### Shared Profit Computation Module

**New file:** `apps/api/src/lib/profit.service.ts`

This module is the SINGLE SOURCE OF TRUTH for net profit calculation. Both `getKpis()` and
`getSalesReport()` call it; neither implements its own formula.

```
FUNCTION computeNetProfit(branchId?, dateFrom?, dateTo?)
  OUTPUT: NetProfitResult

  // Step 1: Fulfilled Revenue — ONLY orders in status FULFILLED or COMPLETED
  fulfilledRevenue = SUM(o.total)
    FROM orders o
    WHERE o.status IN ('FULFILLED', 'COMPLETED', 'Fulfilled', 'Completed')
      AND [date/branch filters]

  // Step 2: Collected Credit Revenue — credit orders where receivable is Settled
  // (Already included in fulfilledRevenue above because payment settles FULFILLED orders;
  //  this step is used for the split breakdown only)

  // Step 3: Purchase Cost — from po_line_items matched by book_id to fulfilled order items
  purchaseCost = SUM(pli.unit_cost * oli.quantity)
    FROM order_line_items oli
    JOIN orders o ON o.id = oli.order_id
    LEFT JOIN po_line_items pli ON pli.book_id = oli.book_id
      -- most recent PO receipt cost for that book
    WHERE o.status IN ('FULFILLED', 'COMPLETED', 'Fulfilled', 'Completed')
      AND [date/branch filters]

  // Step 4: All Discounts — Normal + Merchant + Special from fulfilled orders
  totalDiscounts = SUM(o.discount_total)   -- stored on orders table
    FROM orders o
    WHERE o.status IN ('FULFILLED', 'COMPLETED', 'Fulfilled', 'Completed')
      AND [date/branch filters]

  // Step 5: Returns — value of returned items from orders in scope
  returnsValue = SUM(ri.unit_price * ri.quantity)
    FROM return_items ri
    JOIN returns r ON r.id = ri.return_id
    WHERE r.original_order_id IS NOT NULL
      AND r.status IN ('Approved', 'APPROVED', 'Completed', 'COMPLETED')
      AND [date/branch filters]

  // Step 6: Exchange Adjustments — net cash flow from exchanges
  exchangeAdjustment = SUM(
    CASE WHEN ese.entry_type = 'cash_payment' THEN ese.amount
         WHEN ese.entry_type = 'cash_refund'  THEN -ese.amount
         ELSE 0 END
  )
    FROM exchange_settlement_entries ese
    JOIN exchanges e ON e.id = ese.exchange_id
    WHERE e.status IN ('Completed', 'COMPLETED')
      AND [date/branch filters]

  netProfit = fulfilledRevenue
              - purchaseCost
              - totalDiscounts
              - returnsValue
              + exchangeAdjustment

  RETURN {
    netProfit,
    fulfilledRevenue,
    purchaseCost,
    totalDiscounts,
    returnsValue,
    exchangeAdjustment,
    cashSalesRevenue,        // from cash_sale orders only
    creditSalesRevenue,      // from credit_sale orders — fulfilled
    collectedCreditRevenue,  // receivables.status = 'Settled' in scope
    outstandingReceivables,  // sum of outstanding_amount where status != 'Settled'
  }
END FUNCTION
```

**Integration into `getKpis()`:** Replace the current multi-query `dailySales`/`monthlySales`
aggregation with two calls to `computeNetProfit()` — one with `dateFrom/dateTo = today`,
one with `dateFrom/dateTo = current month`. The `KpiReport` interface gains `netProfit`,
`fulfilledRevenue`, `outstandingReceivables` fields and deprecates the misleading `dailySales`/
`monthlySales` gross-sales fields.

**Integration into `getSalesReport()`:** Replace the separate `summaryRes` query with a call
to `computeNetProfit()`. The `SalesReport.summary` interface gains `netProfit`, `purchaseCost`,
`totalDiscounts` fields.

**Preservation:** POS revenue (from `transactions` table) is unaffected — POS uses its own
`grand_total` column and is not included in the order-based profit formula. Requirement 3.2
(POS cash transaction atomicity) is unchanged.


---

## Bug 3 — Strict Order Lifecycle

### Bug Condition

```
FUNCTION isBugCondition(input)
  INPUT: input of type OrderAction { action, orderId, saleType, currentStatus, paymentStatus }
  OUTPUT: boolean

  RETURN (
    // CASH confirm does not atomically set payment_status = 'paid' + stockOut
    (input.action = 'CONFIRM' AND input.saleType = 'cash_sale'
      AND NOT atomicPaymentStatusAndStockOut(input.orderId))

    // CREDIT fulfill blocked by payment-status gate
    OR (input.action = 'FULFILL' AND input.saleType = 'credit_sale'
      AND input.paymentStatus = 'unpaid'
      AND fulfillRejected(input.orderId))

    // Post-fulfillment payment rejected
    OR (input.action = 'COLLECT_PAYMENT'
      AND input.currentStatus IN ('FULFILLED', 'COMPLETED')
      AND requestRejected(input.orderId))

    // Cancel does not restore inventory
    OR (input.action = 'CANCEL'
      AND input.currentStatus IN ('CONFIRMED', 'PARTIALLY_PAID', 'PAID')
      AND NOT inventoryRestored(input.orderId))

    // allowedActions absent from response
    OR allowedActionsAbsentInResponse(input.orderId)
  )
END FUNCTION
```

### State Machine Design

The following table is the authoritative state machine. `orders.service.ts` must enforce these
transitions and reject any others.

| Current Status | Sale Type | Action → Next Status | Inventory Effect | Receivable Effect |
|---|---|---|---|---|
| `DRAFT` | any | `confirm` → `CONFIRMED` | `stockOut` via `invTxSvc` + soft reservation | CASH: none; CREDIT: create receivable |
| `CONFIRMED` | `cash_sale` | `fulfill` → `FULFILLED` | `fulfillReservation` (audit row, delta=0, reservation→deducted); qty unchanged | none |
| `CONFIRMED` | `credit_sale` | `fulfill` → `FULFILLED` | same as above | receivable stays open |
| `CONFIRMED`/`PARTIALLY_PAID`/`PAID` | any | `cancel` → `CANCELLED` | `stockIn` (reverse the `stockOut` from confirm) | close/void receivable |
| `FULFILLED` | any | `cancel` | **REJECT HTTP 422** `ORDER_ALREADY_FULFILLED` | — |
| `FULFILLED`/`COMPLETED` | `credit_sale` | `collectPayment` | none | reduce `outstanding_amount`; if 0 → `payment_status=paid` |
| `CANCELLED` | any | any | **REJECT** | — |

**Key rule: CONFIRM = stockOut.** The previous codebase had `confirm()` create only a soft
reservation (no physical deduction). The requirements (2.10, 2.11, 3.4) define `CONFIRM` as
the point where `inventory.quantity` is physically decremented via `invTxSvc.stockOut()` with
`referenceType = 'order_confirmed'`. `FULFILL` then calls `invTxSvc.fulfillReservation()` which
writes a history audit row with `delta = 0` — no second deduction.

**CASH confirm implementation** (atomic, single DB transaction):

```
BEGIN TRANSACTION
  1. invTxSvc.stockOut(bookId, locationId, qty, 'order_confirmed', orderId, staffCtx)
     -- physically decrements inventory.quantity, writes inventory_history row
  2. UPDATE orders SET status = 'CONFIRMED', payment_status = 'paid'
     -- CASH orders are paid at confirmation
  3. No receivable created for cash orders
COMMIT  (any step failure → full ROLLBACK)
```

**CREDIT confirm implementation** (atomic, single DB transaction):

```
BEGIN TRANSACTION
  1. invTxSvc.stockOut(bookId, locationId, qty, 'order_confirmed', orderId, staffCtx)
  2. UPDATE orders SET status = 'CONFIRMED', payment_status = 'unpaid'
  3. INSERT INTO receivables (source_type='order_credit_sale', source_entity_id=orderId,
       original_amount=order.total, outstanding_amount=order.total, status='Pending')
COMMIT
```

**FULFILL implementation** (no inventory deduction):

```
BEGIN TRANSACTION
  1. Validate: status IN ('CONFIRMED', 'PARTIALLY_PAID', 'PAID')
     -- REMOVE payment-status gate that blocked credit_sale fulfillment
  2. invTxSvc.fulfillReservation({ orderId, locationId, lineItems, staffCtx })
     -- writes audit history rows (delta=0), transitions reservations → 'deducted'
  3. UPDATE order_line_items SET qty_fulfilled = qty_reserved, qty_reserved = 0
  4. UPDATE orders SET status = 'FULFILLED'
COMMIT
```

**CANCEL implementation** (atomic, all-or-nothing):

```
BEGIN TRANSACTION
  1. Validate: status NOT IN ('FULFILLED', 'COMPLETED') → otherwise HTTP 422
  2. IF stock was deducted (confirmed/partially_paid/paid):
       FOR each line item with qty_reserved > 0:
         invTxSvc.stockIn(bookId, locationId, qty, 'order_cancelled', orderId, staffCtx)
  3. UPDATE inventory_reservations SET status='released' WHERE order_id=orderId AND status='reserved'
  4. IF open receivable exists: updateReceivableOnPayment(..., newOutstandingAmount=0, isFullySettled=true)
  5. UPDATE orders SET status='CANCELLED'
COMMIT  (any step failure → full ROLLBACK — no savepoints that swallow errors)
```

**COLLECT_PAYMENT implementation** (credit orders only):

```
BEGIN TRANSACTION
  1. Validate: status IN ('FULFILLED', 'COMPLETED') AND saleType = 'credit_sale'
  2. SELECT outstanding_amount FROM receivables WHERE source_entity_id=orderId FOR UPDATE
  3. newOutstanding = MAX(0, outstanding_amount - paymentAmount)
  4. UPDATE receivables SET outstanding_amount = newOutstanding,
       status = CASE WHEN newOutstanding = 0 THEN 'Settled' ELSE 'PartiallyPaid' END
  5. UPDATE orders SET payment_status =
       CASE WHEN newOutstanding = 0 THEN 'paid' ELSE 'partially_paid' END
COMMIT
```

**`allowedActions` contract** (every API response must include this):

```
computeOrderAllowedActions(status, saleType, permissions):
  'DRAFT'            → ['confirm', 'cancel']          (if CREATE_SALE permission)
  'CONFIRMED'        → ['fulfill', 'cancel']           (cash AND credit — no payment gate)
  'PARTIALLY_PAID'   → ['fulfill', 'cancel']
  'PAID'             → ['fulfill']
  'FULFILLED'        → ['collectPayment'] (credit only); [] (cash)
  'COMPLETED'        → ['collectPayment'] if outstanding > 0 (credit); [] (cash)
  'CANCELLED'        → []
```


---

## Bug 4 — resetDemoData() Maintenance Script

### Bug Condition

```
FUNCTION isBugCondition(input)
  INPUT: input of type MaintenanceRequest { hasSafeResetCommand, hasDryRun, hasConfirmPrompt,
                                             distinguishesTransactionalVsSeed, isAtomic }
  OUTPUT: boolean

  RETURN (
    NOT hasSafeResetCommand      // no maintenance command exists
    OR NOT hasDryRun             // no --dry-run preview mode
    OR NOT hasConfirmPrompt      // executes without confirmation
    OR NOT distinguishesTransactionalVsSeed  // can destroy seed master data
    OR NOT isAtomic              // partial deletes leave DB in inconsistent state
  )
END FUNCTION
```

### Script Design

**New file:** `apps/api/scripts/reset-demo-data.mjs`

The script follows this execution model:

```
FUNCTION resetDemoData(args)
  DRY_RUN = '--dry-run' in args

  TABLES_TO_DELETE (FK dependency order — children first):
    1.  exchange_items
    2.  exchanges
    3.  return_items
    4.  returns
    5.  pos_transaction_items
    6.  pos_transactions         (alias: transactions table)
    7.  order_line_items
    8.  order_payments
    9.  payments
    10. receivables
    11. inventory_reservations
    12. inventory_history
    13. procurement_order_items  (po_line_items + po_receipt_items + po_receipts)
    14. procurement_orders       (purchase_orders)
    15. customers
    16. suppliers                (WHERE id NOT IN (seeded supplier ids))

  TABLES_TO_PRESERVE (explicit allowlist — must not be touched):
    staff, staff_branch_roles, roles, permissions, role_permissions,
    branches, locations, system_config,
    books, authors, categories, publishers,
    book_authors, book_categories, book_prices, book_branch_prices,
    book_formats, book_editions, book_tags,
    inventory  (quantity reset to opening balance, NOT deleted)

  STEP 1: Count rows in each TABLES_TO_DELETE
    FOR each table: SELECT COUNT(*) → print "  table_name: N rows [would be deleted]"

  STEP 2: Validate preserved tables are untouched
    IF any table in TABLES_TO_PRESERVE is in deletion list → EXIT 1 with error

  IF DRY_RUN:
    PRINT dry-run summary → EXIT 0 (no writes)

  STEP 3: Prompt
    PRINT "The above N rows across M tables will be PERMANENTLY DELETED."
    PRINT "Preserved tables (staff, catalog, config) will NOT be touched."
    PRINT "Type YES to confirm deletion: "
    READ confirmation
    IF confirmation != "YES" → PRINT "Aborted." → EXIT 0

  STEP 4: Execute (atomic)
    BEGIN TRANSACTION
      FOR each table in TABLES_TO_DELETE (in order):
        DELETE FROM table [WHERE applicable]
      -- Reset inventory quantities to opening balance
      UPDATE inventory SET quantity = 0, version = version + 1, updated_at = now()
      -- Note: opening balance = 0 (the seed sets quantity=0; stock-in from POs builds the real qty)
    COMMIT
    ON ERROR:
      ROLLBACK
      PRINT "Reset failed. Database unchanged."
      EXIT 1

  PRINT "Reset complete. N rows deleted across M tables."
END FUNCTION
```

**Procurement table mapping** (the schema uses `purchase_orders` not `procurement_orders`):
- Delete order: `po_receipt_items`, `po_receipts`, `po_line_items`, `purchase_orders`
- This is the correct FK chain from the migrations.

**POS table mapping** (the schema uses `transactions` and `transaction_line_items`):
- Delete order: `transaction_payments`, `transaction_line_items`, `transactions`

**Idempotency:** The script is safe to re-run on an already-empty database (all deletes are
no-ops; zero-row summary is printed).

**Atomic rollback guarantee:** Every DELETE runs inside a single `BEGIN`/`COMMIT` block.
If any statement fails the entire transaction is rolled back and the script exits non-zero,
leaving the database completely unchanged (requirement 2.20a).


---

## Bug 5 — Stability

### Bug Condition

```
FUNCTION isBugCondition(input)
  INPUT: input of type StabilityRequest
  OUTPUT: boolean

  RETURN (
    // Inventory endpoint 500s with no retry
    (input.caller = 'GET /api/inventory' AND transientDbError() AND noRetryMechanism())

    // Inventory drift is undetectable and unrepairable
    OR (input.type = 'reconciliation' AND noReconciliationPath())

    // Missing integration test coverage
    OR (input.type = 'integration_test' AND testMissing(input.scenario))
  )
END FUNCTION
```

### API-Level Retry Logic

**File:** `apps/api/src/modules/inventory/inventory.routes.ts`

A `withRetry` wrapper is added to the `GET /api/inventory` route handler (and `GET /api/inventory/low-stock`). It catches transient PostgreSQL errors (connection errors, lock timeouts) and retries up to 2 times with 200 ms back-off before returning HTTP 503.

```typescript
// Transient error codes that warrant retry
const TRANSIENT_PG_CODES = new Set([
  '40001', // serialization failure
  '40P01', // deadlock detected
  '57P03', // cannot connect now
  '08006', // connection failure
  '08001', // unable to establish connection
]);

async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 2,
  delayMs = 200,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const pgCode = (err as { code?: string }).code;
      if (pgCode && TRANSIENT_PG_CODES.has(pgCode) && attempt < maxRetries) {
        lastErr = err;
        await new Promise(resolve => setTimeout(resolve, delayMs * (attempt + 1)));
        continue;
      }
      throw err;  // non-transient — rethrow immediately
    }
  }
  throw lastErr;
}
```

The route handler wraps `inventoryService.listInventory(...)` with `withRetry`. On exhaustion
of all retries, the route re-throws — the global error handler returns HTTP 503.

**Frontend contract (documented in API response):** When the frontend receives a non-200
response from `GET /api/inventory`, it must display a "Failed to load — Retry" button. This is
a frontend implementation note, not a backend change.

### Reconciliation Script Enhancement

The existing `scripts/reconcile-inventory.mjs` already implements Steps 1 and 2 from
requirement 2.22 correctly. The following enhancements align it with the exact requirement
language:

1. **Opening-balance awareness:** The script computes `expected_quantity = SUM(delta) FROM inventory_history WHERE book_id = ? AND movement_type IN ('stock_in','stock_out','transfer_in','transfer_out','adjustment')`. This already matches the requirement.

2. **Stale reservation release:** The script already sets reservations to `'released'` (for
   cancelled orders) or `'deducted'` (for fulfilled/completed orders). The terminal status list
   must include all normalised variants: `('FULFILLED','COMPLETED','CANCELLED','Fulfilled','Completed','Cancelled')`.

3. **Exit codes:** The script must exit with code `0` on success and `1` on any error, and must
   never silently swallow errors that corrupt the DB.

No structural changes are needed to the script — it already satisfies requirement 2.22. The
task is to verify the status list is complete and ensure the dry-run path works.


### Integration Test Suite

**New test file:** `apps/api/src/tests/production-refinement.test.ts`

This file covers all six scenarios from requirements 2.23–2.28. It uses the existing test
infrastructure (`src/tests/setup.ts`, helper factory functions) to create real DB rows and
assert outcomes.

Test scenarios:

| Test ID | Scenario | Key Assertions |
|---------|----------|---------------|
| T-5.1 | Confirm → Fulfill lifecycle (cash order) | `inventory.quantity` decreases by order qty after `confirm()`; unchanged after `fulfill()`; exactly one `order_confirmed` stock_out row; exactly one `order_fulfilled` audit row (delta=0) |
| T-5.2 | Credit order — fulfill before payment | `fulfill()` returns HTTP 200; `order.status = 'FULFILLED'`; `receivables.outstanding_amount = original total`; `payment_status = 'unpaid'` |
| T-5.3 | Credit order — post-fulfillment payment | After payment: `outstanding_amount` decreases by payment amount; full payment → `payment_status = 'paid'`; partial → `payment_status = 'partially_paid'`; `inventory.quantity` unchanged |
| T-5.4 | Profit formula against fixture dataset | Fixture: 2 cash orders + 1 credit order with partial payment + 1 return + 1 merchant discount + 1 exchange. Assert `computeNetProfit()` equals hand-calculated value |
| T-5.5 | Catalog search beyond page 1 | Seed a book at position > 25 in default sort. Call `GET /api/catalog/search?q=<term>`. Assert response contains that book; `total ≥ 1`; `page`/`limit` params have no effect on presence of result |
| T-5.6 | resetDemoData() preserves seed data | Run reset (with `--dry-run=false` in test mode). Assert `staff` rows 1 and 2 exist; `books`/`authors`/`categories`/`publishers` all present; `inventory.quantity = 0` for all books; all transactional tables have 0 rows |

---

## Bug 6 — CSV Export

### Bug Condition

```
FUNCTION isBugCondition(input)
  INPUT: input of type CsvExportRequest { reportType, row }
  OUTPUT: boolean

  RETURN (
    // Missing required columns for the report type
    missingColumns(input.reportType, input.row)

    // Numeric fields formatted as strings with currency symbols
    OR numericFieldIsFormattedString(input.row)

    // Date fields not in ISO 8601 format
    OR dateFieldNotISO8601(input.row)

    // File missing UTF-8 BOM
    OR noBomPrefix(input.response)
  )
END FUNCTION
```

### Shared CSV Builder Utility

**New file:** `apps/api/src/lib/csvBuilder.ts`

This utility is the ONLY place in the codebase that builds CSV content. All four report-type
export routes delegate to it. The existing ad-hoc `toCSV()` in `reports.routes.ts` is replaced.

```typescript
export interface CsvColumnDef {
  key: string;        // property name on the row object
  header: string;     // CSV column header text
  type: 'string' | 'number' | 'date' | 'integer';
}

export function buildCsv(
  rows: Record<string, unknown>[],
  columns: CsvColumnDef[],
): string {
  // UTF-8 BOM is added by the route handler (sendCsv), not here.
  // This function returns pure CSV string without BOM.

  const escape = (v: unknown): string => {
    const s = v == null ? '' : String(v);
    // Wrap in double-quotes if value contains comma, double-quote, or newline
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };

  const formatValue = (v: unknown, type: CsvColumnDef['type']): string => {
    if (v == null) return '';
    if (type === 'number') {
      // Plain unformatted decimal — no currency symbols, no thousand separators
      return parseFloat(String(v)).toFixed(2);
    }
    if (type === 'integer') {
      return String(Math.round(Number(v)));
    }
    if (type === 'date') {
      // ISO 8601 YYYY-MM-DD
      const d = v instanceof Date ? v : new Date(String(v));
      return isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 10);
    }
    return String(v);
  };

  const headers = columns.map(c => escape(c.header));
  const lines = [
    headers.join(','),
    ...rows.map(row =>
      columns.map(c => escape(formatValue(row[c.key], c.type))).join(',')
    ),
  ];
  return lines.join('\r\n');
}

export function sendCsv(res: Response, filename: string, csvContent: string): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('\uFEFF' + csvContent);  // UTF-8 BOM prefix for Excel compatibility
}
```


### Column Schemas Per Report Type

Each schema is defined as a `CsvColumnDef[]` constant in `csvBuilder.ts` (or co-located with
the route). The report routes pass the appropriate schema to `buildCsv()`.

**Sales Report (`SALES_COLUMNS`):**

| # | `key` | `header` | `type` |
|---|-------|---------|--------|
| 1 | `order_reference` | `order_reference` | string |
| 2 | `date` | `date` | date |
| 3 | `customer_name` | `customer_name` | string |
| 4 | `sale_type` | `sale_type` | string |
| 5 | `fulfillment_status` | `fulfillment_status` | string |
| 6 | `subtotal` | `subtotal` | number |
| 7 | `discount_normal` | `discount_normal` | number |
| 8 | `discount_merchant` | `discount_merchant` | number |
| 9 | `discount_special` | `discount_special` | number |
| 10 | `total_discount` | `total_discount` | number |
| 11 | `purchase_cost` | `purchase_cost` | number |
| 12 | `net_profit` | `net_profit` | number |
| 13 | `payment_status` | `payment_status` | string |
| 14 | `collected_amount` | `collected_amount` | number |
| 15 | `outstanding_amount` | `outstanding_amount` | number |

**Inventory Report (`INVENTORY_COLUMNS`):**

| # | `key` | `header` | `type` |
|---|-------|---------|--------|
| 1 | `book_code` | `book_code` | string |
| 2 | `isbn` | `isbn` | string |
| 3 | `title` | `title` | string |
| 4 | `author` | `author` | string |
| 5 | `category` | `category` | string |
| 6 | `publisher` | `publisher` | string |
| 7 | `quantity_on_hand` | `quantity_on_hand` | integer |
| 8 | `quantity_reserved` | `quantity_reserved` | integer |
| 9 | `quantity_available` | `quantity_available` | integer |
| 10 | `unit_cost` | `unit_cost` | number |
| 11 | `last_movement_date` | `last_movement_date` | date |

**Procurement Report (`PROCUREMENT_COLUMNS`):**

| # | `key` | `header` | `type` |
|---|-------|---------|--------|
| 1 | `po_reference` | `po_reference` | string |
| 2 | `date` | `date` | date |
| 3 | `supplier_name` | `supplier_name` | string |
| 4 | `status` | `status` | string |
| 5 | `book_code` | `book_code` | string |
| 6 | `title` | `title` | string |
| 7 | `ordered_quantity` | `ordered_quantity` | integer |
| 8 | `received_quantity` | `received_quantity` | integer |
| 9 | `unit_cost` | `unit_cost` | number |
| 10 | `line_total` | `line_total` | number |
| 11 | `po_total` | `po_total` | number |

**Receivables Report (`RECEIVABLES_COLUMNS`):**

| # | `key` | `header` | `type` |
|---|-------|---------|--------|
| 1 | `order_reference` | `order_reference` | string |
| 2 | `date` | `date` | date |
| 3 | `customer_name` | `customer_name` | string |
| 4 | `original_amount` | `original_amount` | number |
| 5 | `collected_amount` | `collected_amount` | number |
| 6 | `outstanding_amount` | `outstanding_amount` | number |
| 7 | `due_date` | `due_date` | date |
| 8 | `days_overdue` | `days_overdue` | integer |
| 9 | `payment_status` | `payment_status` | string |

### Data Query Changes

The existing `getInventoryExportRows()` function returns rows missing `book_code`, `publisher`,
`author`, `quantity_reserved`, `quantity_available`, `unit_cost`, and `last_movement_date`. A
revised query joins `publishers`, `book_authors/authors`, and `po_line_items` (for unit cost)
and uses the `inventory_reservations` table for reserved quantities.

For the Sales export, a new query `getSalesExportRows()` joins `orders`, `order_line_items`,
`customers`, `receivables`, `po_line_items` (for purchase cost per book), and applies the
profit formula per order line. It must filter to `status NOT IN ('CANCELLED')` and include
all sale types.

For the Procurement export, a new query `getProcurementExportRows()` joins `purchase_orders`,
`po_line_items`, `books`, `suppliers`.

For the Receivables export, a new query `getReceivablesExportRows()` joins `receivables`,
`orders`/`transactions` (for the reference), `customers`.


---

## Expected Behavior

The expected correct behaviors for each bug are defined inline within the bug detail sections above,
and formally captured as Correctness Properties below. The key preservation requirements are:

- All inventory mutations continue to flow exclusively through `inventoryTransactions.service.ts`
- POS cash transactions remain atomically unchanged (Requirement 3.2)
- DRAFT order creation leaves inventory unchanged (Requirement 3.3)
- Existing catalog search fields (title, author, ISBN, SKU) continue to work (Requirement 3.9)
- `computeOrderAllowedActions('FULFILLED')` continues to return `['return']` (Requirement 3.6)
- `computeOrderAllowedActions('CANCELLED')` continues to return `[]` (Requirement 3.7)

---

## Hypothesized Root Cause

### Bug 1 — Search scoped to page
The frontend passes `page` and `pageSize` to the search call (it reuses the same list API
call with a `q` param). The `OFFSET` calculation in `searchBooks()` skips rows beyond the
current page. The barcode field doesn't exist on the `books` table directly (it would be a
separate `barcode` column or an alias for `isbn`); publisher is also absent from the `WHERE`
predicate.

### Bug 2 — Gross sales as profit
`getKpis()` sums `orders.total` for all non-cancelled orders regardless of fulfillment status
or payment. No purchase-cost join exists. Only the first discount type visible in the `orders`
table is applied; no multi-discount deduction. The dashboard and report functions are
independent implementations with no shared formula module.

### Bug 3 — Lifecycle inconsistencies
The codebase shows `confirm()` was recently changed to a reservation-only model (no stockOut)
per a previous task, but the requirements for this fix (2.10, 2.11, 3.4) require `CONFIRM` to
physically deduct stock. The current `fulfill()` correctly calls `fulfillReservation()`.
The `pay()` endpoint only changes the order status without touching the receivable. The
`cancel()` function checks `stockWasDeducted` via `inventory_history` but this check is now
unreliable because `confirm()` no longer writes a stock-out row. The `computeOrderAllowedActions()`
function has a payment-gate on `CONFIRMED` credit orders that blocks fulfillment.

### Bug 4 — No safe reset command
The only maintenance scripts are `reseed.mjs` (adds seed data back) and
`reconcile-inventory.mjs` (fixes quantities). There is no script that safely deletes
transactional data. The `reseed.mjs` file has no --dry-run or confirmation prompt.

### Bug 5 — Inventory route fragility
The `GET /api/inventory` route has no retry wrapper around `listInventory()`. Any transient
connection or lock error propagates as a 500 with no recovery path. The reconcile script
is functional but needs the terminal-status list to include all casing variants.

### Bug 6 — CSV column gaps and formatting
The existing export routes map from high-level report aggregates (e.g. `byPeriod`) rather than
from raw transactional rows, so per-order fields like `sale_type`, `net_profit`, `book_code`
are unavailable. Numeric fields are rendered with `.toFixed(2)` as strings and prefixed with
`ETB` in column headers, causing Excel to treat them as text. Date formatting is inconsistent
(some are ISO, some are locale strings).

---

## Correctness Properties

Property 1: Bug Condition — Catalog search returns results independent of page position

_For any_ search query `q` of ≥ 2 characters submitted from any transactional module, the
fixed `GET /api/catalog/search` endpoint SHALL return all catalog books matching by title,
ISBN, barcode, author, publisher, or SKU (case-insensitive substring), regardless of which
page those books appear on in the default paginated catalog listing.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4**

Property 2: Bug Condition — Net profit uses fulfilled-only revenue minus all cost components

_For any_ profit calculation request submitted to the dashboard KPIs or the reports module,
the fixed `computeNetProfit()` SHALL return:
`Net Profit = fulfilledRevenue − purchaseCost − (discountNormal + discountMerchant + discountSpecial) − returnsValue ± exchangeAdjustment`
where `fulfilledRevenue` includes ONLY orders in FULFILLED or COMPLETED status, and
credit orders contribute to revenue ONLY after payment is collected.

**Validates: Requirements 2.5, 2.6, 2.7, 2.8, 2.9**

Property 3: Bug Condition — Order confirm atomically deducts stock and sets correct payment status

_For any_ `confirm()` call on a DRAFT order, the fixed implementation SHALL, within a single
atomic database transaction: call `invTxSvc.stockOut()` with `referenceType='order_confirmed'`,
set `payment_status='paid'` for CASH orders and create a receivable for CREDIT orders, and
transition `status='CONFIRMED'`. Any failure in any step SHALL roll back all changes.

**Validates: Requirements 2.10, 2.11, 3.4**

Property 4: Bug Condition — Credit order fulfillment is never blocked by payment status

_For any_ `fulfill()` call on a CREDIT order in CONFIRMED, PARTIALLY_PAID, or PAID status,
the fixed implementation SHALL succeed and call `invTxSvc.fulfillReservation()` without
checking `payment_status` or `paymentStatus`; `inventory.quantity` SHALL remain unchanged at
the fulfill step.

**Validates: Requirements 2.12, 3.2**

Property 5: Bug Condition — Post-fulfillment payment collection updates receivable

_For any_ `collectPayment()` call on a FULFILLED or COMPLETED credit order with
`receivables.outstanding_amount > 0`, the fixed implementation SHALL reduce
`outstanding_amount` by the payment amount and update `payment_status` accordingly.

**Validates: Requirements 2.13**

Property 6: Bug Condition — resetDemoData dry-run previews and atomic delete preserves seed

_For any_ invocation of `reset-demo-data.mjs --dry-run`, no DELETE statements SHALL be
executed and the preview SHALL list table names and row counts. _For any_ confirmed
(non-dry-run) invocation, all rows in the transactional tables listed in requirement 2.17
SHALL be deleted and seed tables SHALL remain intact; any failure SHALL roll back all deletes.

**Validates: Requirements 2.17, 2.18, 2.19, 2.20**

Property 7: Bug Condition — CSV exports include all required columns with correct formatting

_For any_ CSV export request for any of the four report types (Sales, Inventory, Procurement,
Receivables), the fixed implementation SHALL produce a file with exactly the columns defined
in the column schema for that type; numeric fields SHALL be plain decimal numbers without
currency symbols; date fields SHALL be `YYYY-MM-DD`; the file SHALL start with a UTF-8 BOM.

**Validates: Requirements 2.29, 2.30, 2.31, 2.32, 2.33, 2.34, 2.35**

Property 8: Preservation — All inventory mutations continue through inventoryTransactions.service.ts

_For any_ code path that modifies `inventory.quantity` (stockIn, stockOut, adjust, transfer,
fulfillReservation), the fixed code SHALL route the mutation exclusively through
`inventoryTransactions.service.ts`. No direct `UPDATE inventory SET quantity = ...` statements
SHALL appear in any other service file.

**Validates: Requirements 3.1, 3.4, 3.8, 3.10, 3.11**

Property 9: Preservation — Every order API response includes allowedActions

_For any_ order lifecycle API response (confirm, fulfill, pay, cancel, collectPayment), the
fixed code SHALL include an `allowedActions` array computed by `computeOrderAllowedActions()`.
The values SHALL match the state machine table in Bug 3's design section exactly.

**Validates: Requirements 2.16, 3.6, 3.7**


---

## Fix Implementation

### Bug 1 — Unified Catalog Search

**New file:** `apps/api/src/modules/catalog/catalogSearch.service.ts`
- Export `search(q: string, opts: { branchId?: number; limit?: number }): Promise<BookRecord[]>`
- SQL: full catalog scan with no OFFSET; predicate covers `title`, `isbn`, `sku`, `barcode`,
  `publisher` (via `publishers` join or `books.publisher` text column), `author` (via
  `book_authors/authors` EXISTS subquery)
- Returns same `BookRecord` shape as `catalog.service.ts`

**New route:** `GET /api/catalog/search` in `catalog.routes.ts`
- Query params: `q` (required, min 2 chars), `limit` (optional, max 200, default 50),
  `branchId` (optional)
- Returns `{ results: BookRecord[], total: number }`
- HTTP 200 with `results: []` when no matches (never an error)

**Consumer changes** (all call-sites that currently pass `q` to the paginated list):
- `procurement.routes.ts` (book picker)
- `inventory.routes.ts` (stock-in book lookup)
- POS frontend → existing `GET /api/catalog?q=` call → redirect to `GET /api/catalog/search?q=`
- Orders, Returns, Exchanges — same pattern

### Bug 2 — Real Profit Calculation

**New file:** `apps/api/src/lib/profit.service.ts`
- Export `computeNetProfit(opts: { branchId?: number; dateFrom?: string; dateTo?: string }): Promise<NetProfitResult>`
- Implement the 6-step formula as specified in the design section above

**Modified:** `apps/api/src/modules/reports/reports.service.ts`
- `getKpis()`: replace ad-hoc sales sums with `computeNetProfit({ branchId })` for monthly and
  daily scopes; update `KpiReport` interface to expose `netProfit`, `fulfilledRevenue`,
  `outstandingReceivables`
- `getSalesReport()`: replace the `summaryRes` `SUM(o.total)` query with `computeNetProfit()`
  for the summary block; update `SalesReport.summary` interface

### Bug 3 — Strict Order Lifecycle

**Modified:** `apps/api/src/modules/orders/orders.service.ts`

`confirm()` changes:
- Remove the reservation-only model; replace with `invTxSvc.stockOut()` call inside the
  transaction for each line item with `referenceType = 'order_confirmed'`
- For CASH: `payment_status = 'paid'` set in the same UPDATE
- For CREDIT: create receivable (existing savepoint logic promoted to hard-fail if it errors)
- Soft reservation record still created after stockOut (for compatibility with
  `fulfillReservation()`)

`fulfill()` changes:
- Remove any remaining payment-status gate; allow `CONFIRMED`, `PARTIALLY_PAID`, `PAID`
- `invTxSvc.fulfillReservation()` call unchanged (already in place)
- Transition to `FULFILLED` only (remove the immediate double-transition to `COMPLETED`)

`cancel()` changes:
- Remove the `stockWasDeducted` history check (unreliable after model change); replace with:
  `hasDeductedStock = status IN ('CONFIRMED', 'PARTIALLY_PAID', 'PAID')` as the sole gate
- Wrap all three steps (stockIn, reservation release, receivable close) in one `BEGIN`/`COMMIT`
  with NO savepoints that swallow errors — all-or-nothing

New `collectPayment()` function:
- Validates `status IN ('FULFILLED', 'COMPLETED')` and `saleType = 'credit_sale'`
- Reduces `receivables.outstanding_amount` by payment amount
- Updates `payment_status` on the order

`computeOrderAllowedActions()` changes:
- Remove payment-status gate on `CONFIRMED` → always return `['fulfill', 'cancel']`
- Add `collectPayment` to allowed actions for FULFILLED/COMPLETED credit orders with
  `outstanding_amount > 0`

New route: `POST /api/orders/:id/collect-payment` in `orders.routes.ts`

### Bug 4 — resetDemoData() Script

**New file:** `apps/api/scripts/reset-demo-data.mjs`
- Implement exactly as specified in the design section above
- Use `readline` for the YES confirmation prompt (non-TTY-safe: check `process.stdin.isTTY`)
- Exit codes: 0 = success or dry-run or aborted; 1 = error

### Bug 5 — Stability

**Modified:** `apps/api/src/modules/inventory/inventory.routes.ts`
- Add `withRetry()` helper (as specified above)
- Wrap `listInventory()` call in `GET /api/inventory` and `GET /api/inventory/low-stock`

**Verified (no changes needed):** `apps/api/scripts/reconcile-inventory.mjs`
- Confirm terminal-status list includes all casing variants
- Confirm `--dry-run` path prints correct output and exits 0

**New test file:** `apps/api/src/tests/production-refinement.test.ts`
- Implement all six test scenarios T-5.1 through T-5.6

### Bug 6 — CSV Export

**New file:** `apps/api/src/lib/csvBuilder.ts`
- Implement `buildCsv(rows, columns)` and `sendCsv(res, filename, content)` as specified

**New query functions in `reports.service.ts`:**
- `getSalesExportRows(filters)` — per-order rows with all 15 Sales columns
- `getProcurementExportRows(filters)` — per-PO-line rows with all 11 Procurement columns
- `getReceivablesExportRows(filters)` — per-receivable rows with all 9 Receivables columns
- `getInventoryExportRows(filters)` — enhanced to return all 11 Inventory columns
  (add `book_code`, `publisher`, `author`, `quantity_reserved`, `quantity_available`,
  `unit_cost`, `last_movement_date`)

**Modified:** `apps/api/src/modules/reports/reports.routes.ts`
- Replace the ad-hoc `toCSV()` function with imports from `csvBuilder.ts`
- Replace all four export routes to use `buildCsv(rows, SCHEMA_CONSTANT)` + `sendCsv()`
- Add `GET /api/reports/procurement/export` and `GET /api/reports/receivables/export` routes

---

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that
demonstrate each bug on unfixed code, then verify the fix works correctly and preserves
existing behavior.

### Exploratory Bug Condition Checking

**Goal**: Confirm root cause for each of the six bugs before implementing the fix.

**Test Cases (run against UNFIXED code):**

1. **Search pagination bug**: Call `GET /api/catalog?q=<term>&page=3` on a book seeded at row 52.
   Assert the book is absent from page 1 results (expected on unfixed code).

2. **Profit overstatement**: Create a CONFIRMED (unfulfilled) credit order for 500 ETB. Call
   `GET /api/reports/kpis`. Assert `monthlySales` includes the 500 ETB (expected on unfixed
   code — confirms the bug).

3. **Credit fulfill gate**: Create a CONFIRMED credit order. Call `POST /api/orders/:id/fulfill`.
   Assert HTTP 422 or 400 with payment gate error (expected on unfixed code).

4. **No reset script**: Verify `scripts/reset-demo-data.mjs` does not exist (expected on
   unfixed code).

5. **CSV missing columns**: Call `GET /api/reports/inventory/export`. Parse response CSV.
   Assert `book_code` column is absent (expected on unfixed code).

### Fix Checking (Properties 1–9)

See integration test scenarios T-5.1 through T-5.6 under Bug 5 above.

### Preservation Checking

```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT fixedFunction(input) = originalFunction(input)
END FOR
```

Preservation test cases:

1. **POS cash transaction**: Complete a full POS transaction. Assert inventory decrements via
   `inventoryTransaction.service.ts` `stockOut()`, and an `inventory_history` row with
   `reference_type='sale'` is written. Assert `pos.sale_completed` outbox event emitted.
   (Requirement 3.2)

2. **Procurement receivePO**: Receive goods on a PO. Assert `stockIn()` is called with
   `reference_type='purchase_order'`. (Requirement 3.8)

3. **Return with SELLABLE disposition**: Process a return. Assert `stockIn()` increments
   inventory. (Requirement 3.10)

4. **DRAFT order unchanged**: Create a DRAFT order. Assert `inventory.quantity` is unchanged
   and no `inventory_history` rows exist for that order. (Requirement 3.3)

5. **computeOrderAllowedActions('FULFILLED')**: Assert returns `['return']`. (Requirement 3.6)

6. **computeOrderAllowedActions('CANCELLED')**: Assert returns `[]`. (Requirement 3.7)

7. **Existing catalog search fields preserved**: After adding barcode/publisher to the search
   predicate, assert that existing title/author/ISBN/SKU searches still return the same results.
   (Requirement 3.9)

### Unit Tests

- `profit.service.ts`: Unit test `computeNetProfit()` with mock DB results; cover all six
  formula components; assert zero credit contribution for unfulfilled orders.
- `csvBuilder.ts`: Unit test `buildCsv()` with all four schemas; assert column order, numeric
  formatting (no currency symbol), ISO 8601 dates, escaping of commas/quotes in values.
- `catalogSearch.service.ts`: Unit test the SQL predicate builder; mock DB; assert all six
  fields are searched.
- `computeOrderAllowedActions()`: Unit test all status × saleType combinations against
  the state machine table.

### Property-Based Tests

- Generate random `OrderStatus × SaleType` pairs; assert `computeOrderAllowedActions()`
  never returns `'fulfill'` for `CANCELLED`, `FULFILLED`, or `COMPLETED` statuses.
- Generate random numeric values; assert `buildCsv()` formats them as plain decimals
  (regex: `^\d+\.\d{2}$`) with no currency symbols.
- Generate random date strings (ISO and non-ISO); assert `buildCsv()` always produces
  `YYYY-MM-DD` output for `type: 'date'` columns.

### Integration Tests

- Full order lifecycle (CASH): `CREATE → confirm → fulfill → cancel-rejected` with DB assertions
  at each step.
- Full order lifecycle (CREDIT): `CREATE → confirm → fulfill → collect-payment-partial →
  collect-payment-full` with receivable balance assertions.
- Catalog search across pages: Seed book at position 52; assert search returns it regardless
  of `page` parameter.
- `reset-demo-data.mjs --dry-run`: Assert no rows deleted; output contains expected tables.
- `reset-demo-data.mjs` (with auto-YES): Assert transactional tables empty; seed tables intact.
- CSV export round-trip: Call each of four export endpoints; parse CSV; assert all required
  column headers present; assert numeric columns are parseable as `parseFloat`; assert date
  columns match `/^\d{4}-\d{2}-\d{2}$/`; assert response body starts with UTF-8 BOM (`\uFEFF`).

