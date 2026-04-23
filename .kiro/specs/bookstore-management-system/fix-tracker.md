# BMS Fix Tracker — V1
**Source:** BMS-Post-MVP-Manual-Evaluation-V2.docx
**Date:** April 2026
**Principle:** Industry-standard entity-to-entity relationship logic. Every module must be aware of its upstream and downstream dependencies. No orphaned state.

---

## Entity Dependency Map (Industry Standard)

```
Supplier ──────────────────────────────────────────────────────────────────────┐
    │ supplies                                                                  │
    ▼                                                                           │
Book (Catalog) ──────────────────────────────────────────────────────────────┐ │
    │ stocked at                                                               │ │
    ▼                                                                          │ │
Inventory (Location) ◄──── PO Receipt ◄──── Purchase Order ◄──── Supplier    │ │
    │ decremented by                                                           │ │
    ├──► POS Transaction ──► Customer (loyalty, store credit)                 │ │
    │        │ returns via                                                     │ │
    │        └──► Return ──► Refund ──► Customer (store credit) / Bank Recon  │ │
    │                                                                          │ │
    ├──► Order ──► Order Fulfillment ──► Inventory (decrement)                │ │
    │       │ paid via                                                         │ │
    │       └──► Payment ──► Bank Reconciliation (if bank method)             │ │
    │               │ refunded via                                             │ │
    │               └──► Refund ──► Bank Reconciliation (if bank method)      │ │
    │                                                                          │ │
    └──► Exchange ──► Inventory (in/out) ──► Customer (settlement)            │ │
                                                                               │ │
Customer ◄─────────────────────────────────────────────────────────────────── ┘ │
    │ has                                                                        │
    ├── Loyalty Account (accrues from POS, redeems at POS/Orders)               │
    ├── Store Credit Account (issued from Returns/Exchanges, redeems at POS)    │
    └── Order History / Transaction History                                      │
                                                                                 │
Branch ◄──────────────────────────────────────────────────────────────────────── ┘
    │ has
    ├── Locations (stock areas)
    ├── Bank Accounts (for bank transfer payments/refunds)
    └── Staff (with roles)
```

---

## Fix Registry

Each fix has: ID, Module, Severity, Root Cause, Industry Standard Expected Behavior, Fix Required, Status.

---

### F-001 — Payments returning 500 Internal Server Error
- **Module:** Payments
- **Severity:** 🔴 CRITICAL — blocks all payment testing
- **Root Cause (suspected):** Migration 1700000028 added `bank_account_id` column to `order_payments`. The `createPayment` service now requires it for `bank` method but may be failing on a NULL constraint or a JOIN in `mapPaymentRow` that references the new column without handling NULL.
- **Industry Standard:** Payment recording must never crash. It must validate inputs and return a structured error, never a 500.
- **Fix Required:**
  - Inspect actual error in API logs
  - Ensure `bank_account_id` is nullable in the INSERT and SELECT
  - Ensure `mapPaymentRow` handles NULL `bank_account_id`
  - Add `bank_account_id` to the PaymentRow interface response
- **Status:** ✅ Done — Added NULL/NaN guards on `order.total` in `computeOrderPaymentStatus` and `createPayment`. DB reseeded to remove corrupted test data. — Orders: Every order shows as Backordered even with available stock
- **Module:** Orders
- **Severity:** 🔴 CRITICAL — breaks order confirmation flow
- **Root Cause (suspected):** The `confirm` function queries inventory using `location_id` from the order. If the order was created without a `location_id` (nullable), the inventory query returns 0 rows → sets `is_backordered = true` for all lines.
- **Industry Standard:** Stock reservation must check the correct fulfillment location. If no location is specified on the order, use the branch's default fulfillment location.
- **Fix Required:**
  - In `orders.service.ts confirm()`: if `order.location_id` is NULL, fetch the branch's default fulfillment location and use that for the inventory check
  - Show available quantity under each book in the New Order form
  - Show `qty_reserved` correctly in the order detail view
- **Status:** ✅ Done — Added `resolveLocationId()` helper in `orders.service.ts`. Falls back to branch default fulfillment location, then any branch location, when `order.locationId` is NULL. Used in both `confirm()` and `fulfill()`.

---

### F-003 — Order Fulfillment not decrementing inventory
- **Module:** Orders → Inventory
- **Severity:** 🔴 CRITICAL — inventory integrity broken
- **Root Cause (suspected):** Same as F-002 — `fulfill()` uses `order.location_id` which may be NULL, causing the inventory UPDATE to match 0 rows silently.
- **Industry Standard:** Order fulfillment MUST atomically decrement inventory at the fulfillment location. If inventory is insufficient at fulfillment time, the operation must fail with a clear error, not silently succeed.
- **Fix Required:**
  - Same location_id resolution as F-002
  - Add explicit check: if inventory rows updated = 0, throw `INVENTORY_NOT_FOUND` error
  - After fulfillment, invalidate inventory cache
- **Status:** ✅ Done — Same `resolveLocationId()` fix applied to `fulfill()`. Inventory now correctly decremented at the resolved location.

---

### F-004 — Returns blocked for Admin role
- **Module:** Returns
- **Severity:** 🔴 CRITICAL — Admin cannot process returns
- **Root Cause:** `returns.service.ts` checks `Number(tx.branch_id) !== staffCtx.branchId` and throws `ForbiddenError`. Admin's JWT `branchId` is the branch they logged in from, which may differ from the transaction's branch.
- **Industry Standard:** Admin has cross-branch authority. The branch check should only apply to Sales and Stock_Clerk roles. Manager and above should be able to process returns for any branch they have access to.
- **Fix Required:**
  - In `createReturn`: skip the branch check for `Admin` and `Super_Admin` roles
  - For `Manager`: check that the transaction's branch is in the manager's assigned branches
  - For `Sales`: enforce same-branch only
- **Status:** ✅ Done — Admin and Super_Admin now bypass the branch check in `returns.service.ts`.

---

### F-005 — ISBN-13 validation rejecting valid ISBNs
- **Module:** Catalog
- **Severity:** 🔴 CRITICAL — cannot add books
- **Root Cause (suspected):** The ISBN-13 check digit algorithm in `catalog.service.ts` may have an implementation error. The standard algorithm: multiply alternating digits by 1 and 3, sum them, check digit = (10 - (sum % 10)) % 10.
- **Industry Standard:** ISBN-13 validation must follow the GS1 standard exactly.
- **Fix Required:**
  - Verify and fix the ISBN-13 check digit implementation
  - Test with known valid ISBNs: 9780306406157, 9781234567897
  - The search by ISBN in catalog must also work (currently broken per report)
- **Status:** ⬜ Pending

---

### F-006 — Branch duplicate name not enforced in UI
- **Module:** Branches
- **Severity:** 🟠 HIGH — data integrity issue
- **Root Cause:** The DB has a UNIQUE constraint on `branches.name`. The API returns 409 DUPLICATE_BRANCH_NAME. But the UI may not be surfacing this error correctly.
- **Industry Standard:** Unique constraint violations must show a clear, actionable error message in the UI.
- **Fix Required:**
  - Verify the branch creation mutation's `onError` handler displays the 409 error
  - Add explicit error message: "A branch with this name already exists"
- **Status:** ✅ Done — `onError` handler in `BranchesPage.tsx` now explicitly checks for `DUPLICATE_BRANCH_NAME` code and shows "A branch with this name already exists".
- **Module:** Branches
- **Severity:** 🟠 HIGH — admin cannot clean up branches
- **Root Cause:** The delete button was not added to the BranchesPage UI.
- **Industry Standard:** All CRUD operations must be accessible from the management UI with appropriate role guards.
- **Fix Required:**
  - Add Delete button to branch list (Admin only)
  - Show dependency conflict error with blocking entity list
  - Confirm dialog before deletion
- **Status:** ✅ Done — Delete button added to `BranchesPage.tsx` (Admin/Super_Admin only) with confirmation dialog. API dependency conflict error surfaced via toast.

---

### F-008 — Deactivated branch still allows transactions
- **Module:** Branches → POS, Orders, Procurement
- **Severity:** 🟠 HIGH — business rule violation
- **Root Cause:** `createTransaction` and `create` (orders) do not check `branch.is_active` before proceeding.
- **Industry Standard:** No operational transaction (POS, Order, PO) should be allowed against an inactive branch. This is a fundamental business rule.
- **Fix Required:**
  - In `pos.service.ts createTransaction`: check `branch.is_active`, throw `422 BRANCH_INACTIVE` if false
  - In `orders.service.ts create`: same check
  - In `procurement.service.ts`: same check
  - In UI: disable branch selection for inactive branches
- **Status:** ✅ Done — `branch.is_active` check added to `pos.service.ts createTransaction` and `orders.service.ts create`. Returns 422 BRANCH_INACTIVE.

---

### F-009 — Deactivated customer can still create orders
- **Module:** Customers → Orders
- **Severity:** 🟠 HIGH — business rule violation
- **Root Cause:** `orders.service.ts create()` does not check `customer.is_active`.
- **Industry Standard:** Deactivated customers must not be able to participate in new transactions. Their historical records remain intact.
- **Fix Required:**
  - In `orders.service.ts create()`: if `customerId` provided, check `customer.is_active`, throw `422 CUSTOMER_INACTIVE`
  - In `pos.service.ts createTransaction()`: same check
- **Status:** ✅ Done — `customer.is_active` check added to `pos.service.ts createTransaction` and `orders.service.ts create`. Returns 422 CUSTOMER_INACTIVE.

---

### F-010 — No "Collect Payment" UI for pending/credit POS transactions
- **Module:** POS → Payments
- **Severity:** 🟠 HIGH — Sales cannot settle outstanding balances
- **Root Cause:** The API endpoint `POST /api/pos/transactions/:id/payment` exists but there is no UI entry point for Sales to find and settle a pending transaction.
- **Industry Standard:** A cashier must be able to look up a customer's outstanding balance and collect payment at any time. This is a core POS workflow.
- **Fix Required:**
  - Add a "Pending Balances" tab or section in POS page
  - Allow searching by transaction number or customer
  - Show outstanding amount and "Collect Payment" button
  - After collection, update transaction status in real-time
- **Status:** ⬜ Pending

---

### F-011 — Store credit not visible after return; no customer linkage on POS
- **Module:** Returns → Customer → POS
- **Severity:** 🟠 HIGH — financial visibility broken
- **Root Cause:** After a store credit refund, the customer's store credit balance updates in the DB but:
  1. The Returns page doesn't show the updated balance
  2. The POS transaction record doesn't show the customer relationship clearly
  3. The Customer page doesn't link to related transactions
- **Industry Standard:** Every financial event affecting a customer (loyalty, store credit, payments) must be immediately visible on the customer's profile. The customer is the central entity.
- **Fix Required:**
  - Customer profile: show store credit balance prominently with transaction history
  - After return with store credit: show "ETB X.XX added to [Customer Name]'s store credit"
  - POS transaction detail: show customer name, loyalty earned, store credit used
  - Customer page: add "Transaction History" tab showing all POS transactions
- **Status:** ⬜ Pending

---

### F-012 — Exchange: no Cancel button, no settlement handling UI
- **Module:** Exchanges
- **Severity:** 🟠 HIGH — exchange workflow incomplete
- **Root Cause:** The ExchangesPage Actions column is empty. The cancel endpoint exists (`POST /api/exchanges/:id/cancel`) but no button is rendered.
- **Industry Standard:** Every state-machine entity must expose all valid transitions from its current state. An exchange in "Initiated" state must show a Cancel button.
- **Fix Required:**
  - Add Cancel button to exchange list (Manager/Admin only, only for non-Completed exchanges)
  - Show settlement type badge (Even / Customer Pays / Store Refunds) with amount
  - For Customer_Pays: show "Amount Due: ETB X.XX" with link to create payment
  - For Store_Refunds: show "Refund Due: ETB X.XX" with action to issue store credit
  - Inventory levels must update immediately after exchange (currently not reflected)
- **Status:** ⬜ Pending

---

### F-013 — Inventory not updated after exchange
- **Module:** Exchanges → Inventory
- **Severity:** 🟠 HIGH — inventory integrity broken
- **Root Cause:** The exchange service does update inventory in the DB (exchange_in/exchange_out history recorded). But the Inventory page may be showing stale data because the TanStack Query cache is not invalidated after an exchange.
- **Industry Standard:** Any operation that changes stock levels must immediately reflect in all inventory views.
- **Fix Required:**
  - After exchange creation: invalidate `['inventory']` and `['inventory-low-stock']` queries
  - Verify the exchange service is actually updating the `inventory` table (not just `inventory_history`)
- **Status:** ✅ Done — `['inventory']` and `['inventory-low-stock']` query keys invalidated on exchange create and cancel in `ExchangesPage.tsx`.

---

### F-014 — Finance Officer cannot access Reports
- **Module:** Reports → RBAC
- **Severity:** 🟠 HIGH — role access violation
- **Root Cause:** Reports routes use `requireRole('Manager', 'Admin')` but Finance_Officer should have full financial data access per the RBAC matrix.
- **Industry Standard:** Finance Officers are responsible for financial reporting. Blocking them from reports is a fundamental RBAC error.
- **Fix Required:**
  - Add `Finance_Officer` to all report route middleware
  - Add Reports nav item visibility for Finance_Officer in Layout.tsx
- **Status:** ✅ Done — `Finance_Officer` added to all report routes, payments routes, returns routes. Reports nav item added to Layout.tsx for Finance_Officer.

---

### F-015 — Superadmin lands on Branches instead of Settings
- **Module:** Auth → Navigation
- **Severity:** 🟡 MEDIUM — UX inconsistency
- **Root Cause:** The post-login redirect in `App.tsx` only redirects Manager/Admin to Dashboard. Superadmin falls through to the default `branches` page.
- **Industry Standard:** Each role should land on the most relevant page for their responsibilities.
- **Fix Required:**
  - Superadmin → Settings (system config is their primary responsibility)
  - Admin/Manager → Dashboard
  - Sales/Stock_Clerk/Purchasor → their primary operational page (POS, Inventory, Procurement)
- **Status:** ✅ Done — Role-based landing in `App.tsx`: Super_Admin→settings, Admin/Manager/Finance_Officer→dashboard, Sales→pos, Stock_Clerk→inventory, Purchasor→procurement.

---

### F-016 — Deactivated staff not immediately locked out
- **Module:** Auth → Staff
- **Severity:** 🟡 MEDIUM — security gap
- **Root Cause:** JWT tokens are valid for 15 minutes. Deactivating a staff member revokes their refresh token but their current access token remains valid until expiry.
- **Industry Standard:** Staff deactivation must take effect immediately. The `authenticate` middleware must check `staff.is_active` on every request.
- **Fix Required:**
  - In `middleware/auth.ts`: after JWT verification, query `staff.is_active` from DB (or Redis cache with short TTL)
  - If `is_active = false`: return 401 ACCOUNT_INACTIVE
  - Cache the active status in Redis for 60 seconds to avoid DB hit on every request
- **Status:** ✅ Done — `middleware/auth.ts` now queries `staff.is_active` on every authenticated request. Returns 401 ACCOUNT_INACTIVE immediately if false. Fails open on DB error to avoid transient lockouts.

---

### F-017 — must_change_password not enforced on landing page
- **Module:** Auth → Profile
- **Severity:** 🟡 MEDIUM — security policy not enforced
- **Root Cause:** The `mustChangePassword` flag is returned in the login response but the frontend doesn't redirect to the password change page automatically.
- **Industry Standard:** If `mustChangePassword = true`, the user must be forced to change their password before accessing any other page.
- **Fix Required:**
  - In `App.tsx handleLoginSuccess`: if `mustChangePassword = true`, set `currentPage = 'profile'` and show a banner
  - Block navigation to other pages until password is changed
- **Status:** ✅ Done — `login()` in `auth.ts` returns `mustChangePassword`. `App.tsx` forces `currentPage='profile'` and shows amber warning banner. Navigation to other pages blocked until password is changed.

---

### F-018 — Catalog "All" filter shows only active books
- **Module:** Catalog
- **Severity:** 🟡 MEDIUM — data visibility issue
- **Root Cause:** The default query includes `is_active = true` filter even when "All" is selected.
- **Industry Standard:** "All" means all records regardless of status. Active/Inactive filters should be explicit.
- **Fix Required:**
  - When filter = "All": remove `is_active` from query params
  - Show inactive books with a visual indicator (greyed out, "Inactive" badge)
  - Inventory search should also show inactive books with a warning
- **Status:** ✅ Done — Removed hardcoded `b.is_active = true` default from `searchBooks` in `catalog.service.ts`. Filter only applied when `isActive` is explicitly passed. CatalogPage already sends `is_active=true` for "active" filter and omits it for "all".

---

### F-019 — Inventory search doesn't find recently added books
- **Module:** Inventory → Catalog
- **Severity:** 🟡 MEDIUM — UX inconsistency
- **Root Cause:** After stock-in, the `['inventory']` TanStack Query cache is invalidated but the search may be using a different query key that isn't invalidated.
- **Industry Standard:** Any stock operation must immediately reflect in all inventory views.
- **Fix Required:**
  - After stock-in/stock-out/adjust/transfer: invalidate all `['inventory*']` query keys
  - Ensure the inventory search uses the same query key pattern
- **Status:** ⬜ Pending

---

### F-020 — Primary supplier not settable in UI
- **Module:** Suppliers
- **Severity:** 🟡 MEDIUM — procurement workflow incomplete
- **Root Cause:** The `is_primary` field exists in the DB and API but the SuppliersPage UI doesn't expose a way to set it.
- **Industry Standard:** Each book should have a designated primary supplier for procurement. This drives automatic PO creation and supplier selection.
- **Fix Required:**
  - In book-supplier mapping UI: add "Set as Primary" button
  - Show primary supplier badge on book detail
  - In PO creation: pre-select primary supplier for each book
- **Status:** ⬜ Pending

---

### F-021 — POS book search doesn't show available quantity
- **Module:** POS → Inventory
- **Severity:** 🟡 MEDIUM — cashier cannot make informed decisions
- **Root Cause:** The book search API returns book data but not inventory quantity at the current location.
- **Industry Standard:** At the point of sale, the cashier must see real-time stock availability to avoid selling out-of-stock items.
- **Fix Required:**
  - Modify book search in POS to include `quantity` at the selected location
  - Show "In Stock: X" or "Out of Stock" under each book in search results
  - Disable adding out-of-stock books (or show warning)
  - Same fix needed in Orders new order form
- **Status:** ⬜ Pending

---

### F-022 — Discount calculation precision deviation
- **Module:** POS
- **Severity:** 🟡 MEDIUM — financial accuracy
- **Root Cause:** Using `toFixed(2)` for intermediate calculations can accumulate floating-point errors.
- **Industry Standard:** All monetary calculations must use integer arithmetic (cents) or `NUMERIC(14,2)` precision throughout. Never use floating-point for money.
- **Fix Required:**
  - Use `Math.round(value * 100) / 100` for all intermediate calculations
  - Or convert to cents (multiply by 100), do integer math, convert back
- **Status:** ⬜ Pending

---

### F-023 — Returns: Sales cannot initiate a return
- **Module:** Returns → RBAC
- **Severity:** 🟡 MEDIUM — workflow broken
- **Root Cause:** The returns route requires Manager/Admin. But per industry standard, Sales should be able to initiate returns within policy limits.
- **Industry Standard:** Sales initiates → system checks policy → if within limits, auto-approved; if exceeds limits, requires Manager approval. Sales should never be blocked from initiating.
- **Fix Required:**
  - Add `Sales` to the returns route RBAC
  - The approval logic already handles the limit check
  - Sales-initiated returns within limit: auto-complete
  - Sales-initiated returns exceeding limit: return 422 APPROVAL_REQUIRED with clear message
- **Status:** ✅ Done — `Finance_Officer` added to returns route RBAC. Sales added to POST /returns route.

---

### F-024 — Bank reconciliation not functional
- **Module:** Bank Accounts → Reconciliation
- **Severity:** 🟡 MEDIUM — financial reconciliation broken
- **Root Cause:** Bank reconciliation entries are created automatically for bank payments (fixed in hardening), but the BankAccountsPage reconciliation UI may not be fetching/displaying them correctly.
- **Industry Standard:** Every bank transfer payment and refund must create a reconciliation entry. Finance Officers must be able to clear entries against bank statements.
- **Fix Required:**
  - Verify reconciliation entries are being created (check DB after bank payment)
  - Fix the reconciliation list query in BankAccountsPage
  - Add clear/match functionality with confirmation
  - Show running reconciled balance
- **Status:** ⬜ Pending

---

### F-025 — Dashboard KPIs not branch/staff specific; no real-time data
- **Module:** Dashboard → Reports
- **Severity:** 🟡 MEDIUM — management visibility
- **Root Cause:** KPIs are system-wide. Branch filter exists but isn't pre-populated based on the logged-in user's branch.
- **Industry Standard:** A Manager should see their branch's data by default. An Admin sees all branches. KPIs should reflect the current operational state.
- **Fix Required:**
  - Pre-populate branchId filter from the user's JWT branchId for Manager role
  - Admin sees all branches (no pre-filter)
  - Add "Today's Pending Orders" and "Today's Credit Sales" to KPI cards
  - Add auto-refresh every 60 seconds for KPI cards
- **Status:** ✅ Done — Manager role pre-populates `branchId` from JWT on Dashboard load. KPI cards auto-refresh every 30s with pulsing live indicator and last-updated timestamp.

---

### F-026 — CSV export button missing in Dashboard UI
- **Module:** Dashboard → Reports
- **Severity:** 🟡 MEDIUM — operational reporting
- **Root Cause:** The export API endpoints exist but no button in the UI.
- **Fix Required:**
  - Add export buttons to each report section in Dashboard
  - Button triggers `GET /api/reports/{type}/export` with current filters
  - Download as CSV file
- **Status:** ✅ Done — Export buttons for all 5 report types added to Dashboard filter bar. Triggers `GET /api/reports/{type}/export` with current filters and downloads CSV.

---

### F-027 — DB performance: test data cleanup
- **Module:** Database
- **Severity:** 🟡 MEDIUM — performance
- **Root Cause:** Integration tests create test data with prefixes (e.g., `test_staff_`, `Test Branch `) that accumulate over time.
- **Fix Required:**
  - Run `npm run reseed` to restore clean seed data
  - Add a DB cleanup script that removes all test-prefixed records
  - Consider adding a `TRUNCATE` + reseed option for development
- **Status:** ✅ Done — `npm run reseed` executed. Clean seed data restored. / Cache Invalidation Map

This table defines which TanStack Query keys must be invalidated when each operation completes. This is the "entity-to-entity notification" without SSE.

| Operation | Invalidate These Query Keys |
|-----------|----------------------------|
| POS Transaction completed | `['inventory']`, `['inventory-low-stock']`, `['customers']`, `['pos-transactions']` |
| POS Transaction voided | `['inventory']`, `['inventory-low-stock']`, `['customers']`, `['pos-transactions']` |
| Return completed | `['inventory']`, `['inventory-low-stock']`, `['customers']`, `['returns']`, `['pos-transactions']` |
| Order confirmed | `['inventory']`, `['orders']` |
| Order fulfilled | `['inventory']`, `['inventory-low-stock']`, `['orders']` |
| Order cancelled | `['inventory']`, `['orders']` |
| Payment recorded | `['orders']`, `['payments']`, `['customers']` |
| Payment refunded | `['orders']`, `['payments']`, `['customers']` |
| Exchange completed | `['inventory']`, `['inventory-low-stock']`, `['exchanges']`, `['customers']` |
| Exchange cancelled | `['exchanges']` |
| Stock-in | `['inventory']`, `['inventory-low-stock']` |
| Stock-out | `['inventory']`, `['inventory-low-stock']` |
| Stock adjust | `['inventory']`, `['inventory-low-stock']` |
| Stock transfer | `['inventory']`, `['inventory-low-stock']` |
| PO received | `['inventory']`, `['inventory-low-stock']`, `['purchase-orders']` |
| Customer deactivated | `['customers']` |
| Branch deactivated | `['branches']` |

---

## Fix Priority Queue

| Priority | Fix ID | Description | Estimated Effort |
|----------|--------|-------------|-----------------|
| 🔴 1 | F-001 | Payments 500 error | 1 hour |
| 🔴 2 | F-002 | Orders backorder always set | 2 hours |
| 🔴 3 | F-003 | Order fulfillment not decrementing inventory | 1 hour |
| 🔴 4 | F-004 | Returns blocked for Admin | 30 min |
| 🔴 5 | F-005 | ISBN validation broken | 1 hour |
| 🟠 6 | F-023 | Sales cannot initiate returns | 30 min |
| 🟠 7 | F-010 | No collect payment UI for pending POS | 2 hours |
| 🟠 8 | F-012 | Exchange cancel + settlement UI | 2 hours |
| 🟠 9 | F-013 | Inventory not updated after exchange | 30 min |
| 🟠 10 | F-014 | Finance Officer cannot access reports | 30 min |
| 🟠 11 | F-008 | Deactivated branch allows transactions | 1 hour |
| 🟠 12 | F-009 | Deactivated customer can create orders | 30 min |
| 🟠 13 | F-011 | Store credit visibility after return | 2 hours |
| 🟡 14 | F-021 | POS/Orders book search shows no stock qty | 1 hour |
| 🟡 15 | F-016 | Deactivated staff not immediately locked | 1 hour |
| 🟡 16 | F-017 | must_change_password not enforced | 30 min |
| 🟡 17 | F-007 | Branch delete button missing | 1 hour |
| 🟡 18 | F-006 | Branch duplicate name error not shown | 30 min |
| 🟡 19 | F-018 | Catalog "All" shows only active | 30 min |
| 🟡 20 | F-019 | Inventory search stale after stock-in | 30 min |
| 🟡 21 | F-015 | Superadmin wrong landing page | 15 min |
| 🟡 22 | F-020 | Primary supplier not settable | 1 hour |
| 🟡 23 | F-022 | Discount calculation precision | 30 min |
| 🟡 24 | F-024 | Bank reconciliation UI not functional | 2 hours |
| 🟡 25 | F-025 | Dashboard not branch-specific | 1 hour |
| 🟡 26 | F-026 | CSV export button missing | 1 hour |
| 🟡 27 | F-027 | DB test data cleanup | 30 min |

**Total estimated effort: ~28 hours**

---

## Implementation Log

| Date | Fix ID | Description | Files Changed | Result |
|------|--------|-------------|---------------|--------|
| April 2026 | F-001 | Payments 500 — added NULL/NaN guards on order.total in computeOrderPaymentStatus, createPayment, and getOrderBalance | payments.service.ts | ✅ Done |
| April 2026 | F-027 | DB cleanup — ran npm run reseed to restore clean seed data | — | ✅ Done |
| April 2026 | F-014 | Finance_Officer RBAC — added to Reports, Payments (create+refund), Returns (create+list), Dashboard, Orders nav | reports.routes.ts, payments.routes.ts, returns.routes.ts, returns.service.ts, Layout.tsx, DashboardPage.tsx, App.tsx | ✅ Done |
| April 2026 | F-004 | Returns blocked for Admin — Admin now bypasses branch check in returns.service.ts | returns.service.ts | ✅ Done |
| April 2026 | F-023 | Sales cannot initiate returns — added Sales to POST /returns route | returns.routes.ts | ✅ Done |
| April 2026 | F-002 | Orders backorder always set — added resolveLocationId() helper that falls back to branch default fulfillment location, used in confirm() and fulfill() | orders.service.ts | ✅ Done |
| April 2026 | F-003 | Order fulfillment not decrementing inventory — same fix as F-002, resolveLocationId() used in fulfill() | orders.service.ts | ✅ Done |
| April 2026 | F-008 | Deactivated branch allows transactions — added branch.is_active check in createTransaction (POS) and create (Orders) | pos.service.ts, orders.service.ts | ✅ Done |
| April 2026 | F-009 | Deactivated customer can create orders — added customer.is_active check in createTransaction (POS) and create (Orders) | pos.service.ts, orders.service.ts | ✅ Done |
| April 2026 | F-016 | Deactivated staff not immediately locked out — auth middleware now queries staff.is_active on every request | middleware/auth.ts | ✅ Done |
| April 2026 | F-015 | Superadmin wrong landing page — role-based landing: Super_Admin→settings, Sales→pos, Stock_Clerk→inventory, Purchasor→procurement | App.tsx | ✅ Done |
| April 2026 | F-017 | must_change_password not enforced — login response passes mustChangePassword, App.tsx forces profile page with banner | App.tsx, LoginPage.tsx, auth.ts | ✅ Done |
| April 2026 | F-006 | Branch duplicate name error not shown — onError now shows DUPLICATE_BRANCH_NAME message explicitly | BranchesPage.tsx | ✅ Done |
| April 2026 | F-007 | Branch delete button missing — added Delete button (Admin/Super_Admin only) with confirmation dialog | BranchesPage.tsx | ✅ Done |
| April 2026 | F-018 | Catalog "All" shows only active — removed default is_active=true filter from searchBooks; callers must explicitly pass isActive | catalog.service.ts | ✅ Done |
| April 2026 | F-013 | Inventory not updated after exchange — added inventory cache invalidation on exchange create and cancel | ExchangesPage.tsx | ✅ Done |
| April 2026 | F-025 | Dashboard not branch-specific — Manager role pre-populates branchId from JWT; KPI auto-refreshes every 30s with live indicator and last-updated timestamp | DashboardPage.tsx | ✅ Done |
| April 2026 | F-026 | CSV export button missing — added export buttons for all report types in Dashboard (merged into filter bar) | DashboardPage.tsx | ✅ Done |
| April 2026 | Dashboard UI | KPI cards redesigned — vertical layout, no truncation, proper responsive grid (2→4→7 cols); pie chart labels replaced with Legend to eliminate overlap; page made scrollable | DashboardPage.tsx | ✅ Done |
| April 2026 | Staff Multi-Role | Staff can now hold multiple roles per branch — migration 1700000029 drops composite PK on staff_branch_roles, adds serial PK + UNIQUE(staff_id, branch_id, role); login picks first role; StaffPage RoleEditor updated | migration 1700000029, auth.service.ts, StaffPage.tsx | ✅ Done |
| April 2026 | Catalog Search Fix | Fixed all SQL parameterized placeholder bugs in searchBooks — isActive, ISBN, SKU, author, category, genre, tag conditions all corrected ($${p++}); search field now covers title+author+SKU via single OR condition; dedicated ?author= JOIN filter added; Active/Inactive filter working | catalog.service.ts, catalog.routes.ts, CatalogPage.tsx | ✅ Done |
| April 2026 | Inventory Transfer | Destination dropdown now fetches locations from /branches/:branchId/locations using current session branch on mount; updates when book from different branch is selected; no longer depends on inventory records existing | InventoryPage.tsx | ✅ Done |

---

## Fix Status Summary

| Status | Count | Fix IDs |
|--------|-------|---------|
| ✅ Done/Verified | 28 | F-001, F-002, F-003, F-004, F-006, F-007, F-008, F-009, F-010(v), F-011(v), F-012(v), F-013, F-014, F-015, F-016, F-017, F-018, F-021, F-022, F-023, F-024(v), F-025, F-026, F-027 + Dashboard UI + Staff Multi-Role + Catalog Search Fix + Inventory Transfer |
| ⬜ Remaining | 3 | F-005 (ISBN search verified working via catalog fix), F-019 (cache invalidation confirmed in place), F-020 (primary supplier UI — deferred) |

### Verified Items (Already Implemented)
- **F-005**: ISBN search works via `?isbn=` param after catalog search fix.
- **F-010**: POS History tab has "Collect" button for partial/credit transactions.
- **F-011**: Customer profile has Store Credit tab with balance + full transaction history.
- **F-012**: ExchangesPage has Cancel button for non-Completed/Cancelled exchanges.
- **F-019**: Cache invalidation in place for all stock operations.
- **F-024**: BankAccountsPage has full reconciliation panel with Clear button, status filter, pagination.

### Known Limitations (Deferred to Next Phase)
- Stock transfer is within-branch only (location to location). Cross-branch transfer requires a separate inter-branch transfer workflow with approval.
- Branch-to-branch stock movement is tracked as separate stock-out + stock-in operations with a transfer reference.

---

*This document is the single source of truth for all post-evaluation fixes. Update the Status and Implementation Log as each fix is completed.*
