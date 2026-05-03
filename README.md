# Bookstore Management System (BMS)

A multi-user, multi-role, multi-branch ERP platform for managing physical bookstore operations — built on the PERN stack with Docker.

---

## Project Status

**Phase 3 Complete (Slices 12–15). Phase 4 Complete (Slices 16–17). Phase 5 Complete (Real-Time Notification System). UI/UX Improvements Applied (Sidebar Refactor, Dashboard Enhancement, Notification Fixes). Post-MVP Hardening + Immediate + Mid-Range Improvements Applied. Post-Evaluation Bug Fixes Applied (V1 + V2). ERP Production Hardening Complete. Multi-Role/Multi-Branch Auth Refactor Applied (May 2026).**

| Document | Status | Location |
|----------|--------|----------|
| Requirements | Complete | `.kiro/specs/bookstore-management-system/requirements.md` |
| Design | Complete | `.kiro/specs/bookstore-management-system/design.md` |
| Tasks | In Progress | `.kiro/specs/bookstore-management-system/tasks.md` |
| Fix Tracker | Active | `.kiro/specs/bookstore-management-system/fix-tracker.md` |
| MVP Evaluation | v1.2 | `.kiro/specs/bookstore-management-system/mvp-evaluation.md` |
| Industry-Grade Roadmap | Active | `.kiro/specs/bookstore-management-system/roadmap.md` |
| Notification System Spec | Implemented | `.kiro/specs/bookstore-management-system/notification-spec.md` |
| ERP Hardening Spec | Complete | `.kiro/specs/erp-production-hardening/` |

---

## Domain Coverage

| Slice | Domain | Status |
|-------|--------|--------|
| 0 | Infrastructure | ✅ Done |
| 2+3 | Staff & Auth + Branch | ✅ Done |
| 1 | Configuration & System Settings | ✅ Done |
| 4 | Bank Account Management | ✅ Done |
| 5 | Location Management + Access Control | ✅ Done |
| 6 | Catalog Management | ✅ Done |
| 7 | Inventory Management | ✅ Done |
| 8 | Supplier Management | ✅ Done |
| 9 | Procurement & Purchase Orders | ✅ Done |
| 10 | Customer Management | ✅ Done |
| 11 | POS Transactions | ✅ Done |
| 12 | Returns & Refunds | ✅ Done |
| 13 | Order Management | ✅ Done |
| 14 | Payment Management | ✅ Done |
| 15 | Merchant Exchange | ✅ Done |
| 16 | Reporting Engine | ✅ Done |
| 17 | Dashboard & UI | ✅ Done |
| P5 | Real-Time Notification System (SSE) | ✅ Done |

---

## Role-Based Access Control

All access control is **permission-based** (not role-name checks). Permissions are computed as the union of all roles assigned to a staff member for their active branch session.

| Role | Permissions |
|------|-------------|
| Super_Admin | All 9 permissions |
| Admin | All 9 permissions + `is_all_branches = true` by default |
| Manager | All except `MANAGE_BRANCH` |
| Finance_Officer | `PROCESS_PAYMENT`, `PROCESS_REFUND`, `VIEW_REPORTS` |
| Stock_Clerk | `MANAGE_INVENTORY` |
| Sales | `CREATE_SALE`, `PROCESS_PAYMENT` |
| Purchasor | `MANAGE_INVENTORY`, `VIEW_REPORTS` |

**Multi-Role Support**: A staff member can hold multiple roles per branch. Their effective permissions are the union of all assigned roles. No profile switching required.

**Multi-Branch Support**: Staff can be assigned to multiple branches with different roles per branch. The `is_all_branches` flag grants cross-branch access without per-branch role assignments.

**Branch Switcher**: After login, staff can switch their active branch from the top navigation bar. Permissions are recomputed for the new branch context.

**Login Flow**:
1. Enter credentials → system validates and returns available branches
2. If single branch → auto-selects and logs in
3. If multiple branches → branch picker shown with roles per branch
4. `is_all_branches` staff see all branches with a 🌐 indicator

Key rules:
- All API routes use `requirePermission(...)` — never `requireRole(...)`
- JWT carries `permissions` array (union of all branch roles) + `role` (primary, for compat)
- Deactivated staff are immediately locked out (auth middleware checks `is_active` on every request)
- `must_change_password` flag forces password change before any other navigation
- 15-minute inactivity timeout with 1-minute warning overlay
- 8-hour refresh token cookie (covers a full work shift)

---

## What's Built

### Phase 0 — Infrastructure

- Monorepo: apps/api (Node.js 20 + TypeScript + Express 5), apps/web (React 18 + Vite + Tailwind)
- Docker Compose: API + PostgreSQL 16
- JWT auth (15 min access + httpOnly refresh cookie), 7-role RBAC
- Audit log: all write actions recorded; real-time viewer UI
- Dark/light mode, animated login, collapsible scrollable sidebar

### Phase 1 — Core Business Foundation

**Slice 1 — Configuration**
- 21 system-wide defaults; per-branch overrides; 15 typed helper methods
- Settings UI: 10-tab page (General, Discounts, Inventory, Procurement, Returns, Payments, Loyalty, Exchange, Notifications, Security)

**Slice 4 — Bank Accounts**
- AES-256-GCM column encryption; reconciliation import with full rollback on error

**Slice 5 — Locations**
- Locations per branch with single-default enforcement; staff location access control

**Slice 6 — Catalog**
- Authors, Categories, Publishers as independent entities; books with format + edition
- Full-text search (tsvector), ISBN-13 validation, pricing per format/edition/branch

**Slice 7 — Inventory**
- Stock per book per location with optimistic locking (version counter)
- inventory_history partitioned table: movement_type, reference_type, reference_id
- 5 movement types; transfer with REPEATABLE READ + FOR UPDATE; low-stock alerts

### Phase 2 — Operations

**Slice 8 — Suppliers**
- Unified party model: external (distributor) or publisher (direct)
- is_blacklisted flag; book_suppliers junction table

**Slice 9 — Procurement**
- Full PO lifecycle: draft to closed/cancelled
- Approval threshold from config; flexible receiving destination; partial receiving; GRN

**Slice 10 — Customers**
- Auto-generated customer_code (CUS-0001); customer groups
- Loyalty accounts (config-driven accrual/redemption) + store credit accounts

**Slice 11 — POS Transactions**
- Single-step atomic transaction engine; currency locked to ETB
- Config-driven tax + per-role max discount; inventory decremented via stock_out
- Customer integration: loyalty accrual, redemption, store credit deduction
- Credit sales: payment_status (paid/partial/credit), amount_paid, amount_due
- Credit Sale button for partial/zero-payment sales (requires customer)
- POST /api/pos/transactions/:id/payment collects outstanding balance
- Bank payment method with branch bank account dropdown
- Void: reverses all inventory + customer effects
- 10 integration tests

**Slice 12 — Returns & Refunds**
- Compensating financial operations — never deletes transactions
- Return number format: RET-YYYYMMDD-XXXX
- Config-driven: return_window_days, max_return_value_without_auth, refund_method_after_window
- Manager/Admin self-approve automatically; Sales directed to Manager for high-value returns
- Partial returns with cumulative over-return prevention
- Inventory restored via reference_type = pos_return; store credit + loyalty reversal
- 3-step wizard UI: find transaction, select items, refund method
- 8 integration tests

**Slice 13 — Order Management**
- Full order lifecycle: Pending, Confirmed, In_Progress, Fulfilled, Cancelled
- Order number format: ORD-YYYYMMDD-XXXX; currency locked to ETB
- payment_status field (unpaid/partial/paid/refunded) — updated by Payments module (Slice 14)
- Stock reservation on confirmation: qty_reserved tracked on order_line_items
- Backorder flag set automatically when stock insufficient at confirmation
- Fulfillment: REPEATABLE READ + FOR UPDATE; inventory decremented with reference_type = order
- Cancellation: releases reserved qty, blocked after fulfillment
- Multi-channel support: in_store, phone, online
- Orders UI: list with status/payment badges + inline action buttons; expandable line item detail; New Order form
- RBAC: Sales/Manager/Admin create; Manager/Admin confirm/fulfill/cancel; Stock_Clerk progress/fulfill
- Migration 1700000025: creates orders, order_line_items; extends inventory_history reference_type
- 8 integration tests

**Slice 14 — Payment Management ✅**
- Payment reference format: PAY-YYYYMMDD-XXXX; currency locked to ETB
- Payment methods: cash, bank, mobile, card, store_credit, loyalty_points, other (extensible for Slice 15)
- Payment status lifecycle: success → refunded / partially_refunded
- Total payment cannot exceed order total (422 EXCEEDS_ORDER_TOTAL)
- Refund cannot exceed payment amount (422 EXCEEDS_PAYMENT_AMOUNT)
- Order payment_status auto-updated after every payment/refund: unpaid → partial → paid → refunded
- Split payments: multiple payments per order with different methods
- Outstanding balance: GET /api/orders/:id/balance returns orderTotal, totalPaid, totalRefunded, outstanding
- Payments UI: list with status/method badges, inline refund form; Record Payment tab with order lookup + balance display
- RBAC: Sales/Manager/Admin create payments; Manager/Admin process refunds; all authenticated view
- Migration 1700000026: creates order_payments, order_refunds tables
- 8 integration tests passing

**Slice 15 — Merchant Exchange ✅**
- Exchange reference format: EXC-YYYYMMDD-XXXX; currency locked to ETB
- Single-step atomic exchange: validates books/stock, updates inventory, computes net balance, determines settlement
- net_balance = total_outgoing_value − total_incoming_value; settlement_type: Even / Customer_Pays / Store_Refunds
- Incoming items increase stock; outgoing items decrease stock — all within one DB transaction
- Inventory history recorded with reference_type = exchange_in / exchange_out
- Cancel blocked on Completed exchanges; audit log on all state changes
- Exchanges UI: list with status/settlement badges + expandable item detail; New Exchange tab with incoming/outgoing item builders and real-time balance/settlement preview
- RBAC: Sales/Manager/Admin create; Manager/Admin cancel
- Migration 1700000027: exchanges, exchange_incoming_items, exchange_outgoing_items; extends inventory_history reference_type check
- 8 integration tests passing

### Phase 4 — Reporting & Analytics

**Slice 17 — Dashboard & UI ✅**
- Presentation-only layer — consumes /reports/* endpoints exclusively, zero business logic
- 7 KPI cards: daily revenue, monthly revenue, AOV, active customers, low-stock alerts, pending orders, exchanges today
- Sales trend line chart + sales by branch horizontal bar chart (recharts)
- Payment method pie chart + payment collected vs refunded bar chart
- Exchange summary: totals, incoming/outgoing value, settlement type distribution with progress bars
- Inventory panel: stock summary stats, top-selling books list, low-stock alert list
- Customer panel: summary stats, top customers by spend
- Stock movement bar chart (stock in vs stock out by period)
- Filter bar: dateFrom, dateTo, groupBy (day/week/month), clear button
- All panels: loading skeleton, error state, empty state handled gracefully
- RBAC: Manager/Admin only; other roles see access-denied message
- Dashboard nav item in sidebar (Admin/Manager only); Manager/Admin land on Dashboard after login
- No new dependencies — uses recharts already installed

### Post-MVP Hardening

**Bank Transfer Validation + Reconciliation ✅**
- `paymentMethod = 'bank'` now requires `bank_account_id`; validated against current branch
- 422 INVALID_BANK_ACCOUNT if account inactive or belongs to different branch
- Successful bank payment auto-creates `bank_reconciliation` entry (direction='in', status='uncleared')
- Refund with bankAccountId auto-creates `bank_reconciliation` entry (direction='out', status='uncleared')

**Idempotency (PostgreSQL-backed) ✅**
- `lib/idempotency.ts` — `withIdempotency(key, endpoint, requestHash, fn)` using `idempotency_keys` table
- Applied to `POST /api/payments` via `Idempotency-Key` header
- Duplicate request returns stored response + `X-Idempotent-Replayed: true` header
- 24h TTL; opportunistic cleanup; no Redis required

**Customer PII Encryption ✅**
- `lib/piiEncryption.ts` — `encryptPii`, `decryptPii`, `piiLookupHash` (SHA256)
- New customers: `email_encrypted`, `phone_encrypted`, `email_lookup`, `phone_lookup` populated on create
- API returns decrypted values transparently; backward compatible with existing plaintext records
- Search uses lookup hash for exact-match + plaintext ILIKE for partial match

**Rate Limiting (In-Memory) ✅**
- `middleware/rateLimit.ts` — sliding window counter per IP; no Redis required
- Login: 10 requests per 15 minutes; returns 429 + Retry-After header
- `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` headers on all responses

**Installment Plans ✅**
- `installment_plans` + `installments` tables; monthly schedule auto-generated
- `min_deposit_pct` enforced from config (422 DEPOSIT_TOO_LOW)
- `max_installments` enforced from config (422 EXCEEDS_MAX_INSTALLMENTS)
- `recordInstallmentPayment` updates installment status + order.payment_status
- 4 new endpoints: POST/GET /api/orders/:id/installment-plan, GET /api/installment-plans/:id, POST /api/installments/:id/pay

**Merchant Foundation ✅**
- `merchants` table created; `exchanges.merchant_id` nullable FK added
- Existing direct exchange flows unchanged; foundation for future merchant-to-merchant exchange

**Installment Plans UI ✅**
- InstallmentsPage: View Plan tab (lookup by order ID, payment schedule with status badges, inline payment recording) + New Plan tab (create plan with config-driven validation)
- Installments nav item added to sidebar (Admin, Manager, Sales, Finance_Officer)
- Wired into App.tsx and Layout.tsx

**CSRF Protection ✅**
- `middleware/csrf.ts` — double-submit cookie pattern; `setCsrfCookie()` sets readable `csrf-token` cookie on login and token refresh
- `csrfMiddleware` validates `X-CSRF-Token` header on all mutating requests; skips if no cookie present (backward compatible with tests)
- Frontend `api.ts` reads `csrf-token` cookie and sends as `X-CSRF-Token` header on all POST/PUT/DELETE requests
- Exempt paths: `/api/auth/login`, `/api/auth/refresh`, `/api/auth/logout`, `/api/health`, `/api/branches/public`

**Idempotency Extended ✅**
- `POST /api/orders` — accepts `Idempotency-Key` header; returns `X-Idempotent-Replayed: true` on replay
- `POST /api/exchanges` — accepts `Idempotency-Key` header; returns `X-Idempotent-Replayed: true` on replay
- Combined with existing `POST /api/payments` idempotency: all three major financial write endpoints are now protected

### Mid-Range Improvements

**Redis + Async Infrastructure ✅**
- Redis 7 added to Docker Compose with persistent volume and health check
- `lib/redis.ts` — ioredis singleton with graceful degradation (no crash if Redis unavailable)
- `lib/outbox.ts` — `insertOutbox(client, eventType, payload)` helper for domain event emission within DB transactions
- `workers/outboxPoller.ts` — polls outbox table every 1s using `SELECT FOR UPDATE SKIP LOCKED`; routes events to in-process handlers
- `workers/loyaltyWorker.ts` — idempotent loyalty accrual; checks for existing accrual; optimistic lock on loyalty account
- `workers/installmentChecker.ts` — daily cron; marks overdue installments; emits InstallmentOverdue outbox events
- POS loyalty accrual moved from synchronous to async via outbox — POS completion no longer blocks on loyalty calculation
- Config service caches effective config in Redis (`cfg:{branchId}:{key}` TTL 5min); invalidates on branch config write
- Graceful shutdown: workers stopped on SIGTERM/SIGINT

**Report CSV Export ✅**
- 5 export endpoints: GET /api/reports/{sales,payments,inventory,customers,exchanges}/export
- Returns CSV with BOM (Excel-compatible); Content-Disposition: attachment
- Same filters as JSON endpoints; RBAC: Manager/Admin only
- API-first, read-only reporting layer — no business logic, pure aggregation
- GET /api/reports/sales — order revenue + POS revenue; by period (day/week/month); by branch
- GET /api/reports/payments — collected/refunded/pending totals; by payment method; by period
- GET /api/reports/exchanges — exchange totals; by settlement type; by period
- GET /api/reports/inventory — stock summary, low-stock list (top 50), top-selling books (top 20), stock movement by period
- GET /api/reports/customers — totals, repeat customers, top spenders (top 20), new customers by period
- GET /api/reports/kpis — daily revenue, monthly revenue, AOV, active customers, low-stock alerts, pending orders, exchanges today
- Common filters: branchId, dateFrom, dateTo, groupBy (day/week/month)
- RBAC: Manager/Admin only; Sales → 403
- Empty date ranges return zeros gracefully
- 10 integration tests passing

### Phase 5 — Real-Time Notification System

**Notification Infrastructure ✅**
- `db/migrations/1700000030_create_notifications.cjs` — `notifications` table with `branch_id`, `target_roles TEXT[]`, `target_staff_id`, `event_type`, `title`, `body`, `entity_type`, `entity_id`, `severity` (info/success/warning/error), `is_read`, `read_at`; 3 indexes (branch+unread, target_staff, created_at)
- `lib/outbox.ts` — `OutboxEventType` union extended with 40+ Phase 5 event types across all modules
- `lib/sseManager.ts` — in-memory SSE connection registry; `register(staffId, branchId, role, res)` sets SSE headers and auto-removes on disconnect; `broadcast(branchId, targetRoles, notification)` fans out to all matching connections; `pushToStaff(staffId, notification)` for direct delivery

**Notification Worker ✅**
- `workers/notificationWorker.ts` — full event catalog (40+ event types); maps each event to `{ title, body, targetRoles, severity, entityType, entityId }`; inserts notification row; broadcasts via SSEManager; **never throws** — errors are logged and swallowed so notification failures never block the outbox poller
- `workers/outboxPoller.ts` — updated to route all 40+ notification event types to `handleNotification`; injects `_eventType` into payload before dispatch

**Notification API ✅**
- `GET /api/notifications/stream` — SSE endpoint; sets `Content-Type: text/event-stream`; sends initial `connected` event with unread count; heartbeat every 30s; auto-cleanup on disconnect
- `GET /api/notifications` — paginated list filtered by staff's role + branch; supports `?isRead=false`, `?severity=`, `?page=`, `?pageSize=`
- `GET /api/notifications/unread-count` — badge count for bell icon
- `PUT /api/notifications/:id/read` — mark single notification as read
- `PUT /api/notifications/read-all` — mark all unread as read for the authenticated staff

**Event Coverage ✅**
All 9 service modules wired with `insertOutbox()` calls:
- **Inventory** — stock_in, stock_out, adjustment, transfer_completed, low_stock, out_of_stock
- **POS** — sale_completed, credit_sale, transaction_voided, payment_collected
- **Orders** — created, confirmed, backordered, in_progress, fulfilled, cancelled
- **Payments** — recorded, refunded, bank_transfer; installment.payment_recorded, overdue, plan_completed
- **Returns** — initiated, approval_required, approved, rejected, completed
- **Procurement** — po.created, approval_required, approved, ordered, partially_received, fully_received, cancelled
- **Exchanges** — completed, cancelled, store_refund_due
- **Customers** — store_credit_added, deactivated
- **Auth** — failed_login_attempts, staff_deactivated, password_reset

**Notification Bell UI ✅**
- `components/NotificationBell.tsx` — bell icon with unread badge in header; dropdown showing recent notifications with severity icons, relative timestamps, and mark-read actions; SSE client with auto-reconnect; TanStack Query cache invalidation on notification receipt
- `Layout.tsx` — NotificationBell added to header for all authenticated roles

**Integration Tests ✅**
- `tests/notifications.test.ts` — 12 tests covering: worker inserts row, GET returns role-filtered results, isRead filter, mark single read, mark all read, unread count, SSE stream headers, branch isolation, insertOutbox failure is non-fatal, unknown event type handled gracefully, unauthenticated access rejected

### UI/UX Improvements

**Hierarchical Sidebar Refactor ✅**
- `components/Layout.tsx` — flat nav list replaced with accordion-style grouped sidebar
- 5 collapsible sections: **Sales** (POS, Orders, Returns, Exchanges, Customers), **Stock** (Inventory, Procurement, Suppliers, Catalog), **Finance** (Payments, Installments, Bank Accounts), **Organization** (Branches, Locations, Staff), **System** (Settings, Audit Log)
- Dashboard remains a standalone top-level item
- Accordion: only one section open at a time; auto-expands the section containing the active page on navigation
- Collapsed sidebar (icon-only mode) shows section headers as icon buttons with tooltips
- Configuration-driven menu structure via `NAV_SECTIONS` array; `SidebarSection` and `SidebarItem` as reusable sub-components
- Role-based visibility preserved — items only render for roles that have access

**Dashboard Enhancement ✅**
- `components/WelcomeBanner.tsx` — slim branded banner between top bar and page content; "Welcome to Bakos Bookstore" + Amharic subtitle; slide-in animation on first load; book icon with gentle pulse; dismissible (sessionStorage); does not re-trigger on navigation
- **Quick Actions** row: New Sale → POS, New Purchase → Procurement, Add Customer → Customers, Record Payment → Payments — gradient buttons with hover lift
- **KPI cards** are now clickable and navigate to the relevant module
- **Alerts & Activity** section: Low Stock panel (amber, links to Inventory) and Pending Orders panel (orange, links to Orders) — only shown when there's actually something to alert about
- Filters and Export split into two separate rows for better space utilization
- `onNavigate` prop added to `DashboardPage` and wired through `App.tsx`

**Stock Quantity in POS & Orders Book Search ✅**
- `GET /api/books` now returns `stockQuantity` for the selected location (or branch total when no location specified)
- Catalog service `searchBooks` query: correlated subquery sums `inventory.quantity` filtered by `locationId` (specific location) or all locations in the branch (fallback)
- `POSPage.tsx` and `OrdersPage.tsx` book search dropdowns show stock availability under each book name:
  - `✓ N in stock` (green) — adequate stock
  - `⚠ Only N left` (amber) — low stock (≤3)
  - `⚠ Out of stock` (red) — button disabled, cannot be added

**Notification System Fixes ✅**
- `components/NotificationBell.tsx` — complete rewrite to fix silent failures:
  - `fetchList()` called directly on mount (no longer waits for SSE `connected` event)
  - Single `openStream` function with `scheduleReconnect` as a plain closure — eliminates stale `useCallback` closure chain
  - `AbortController` for clean stream teardown on unmount or reconnect
  - `mountedRef` guard prevents state updates on unmounted component
  - "→ Go to [Module]" hint shown on each notification for clear navigation intent
- `modules/notifications/notifications.routes.ts` — query logic updated for all 5 endpoints (list, stream unread count, unread-count, mark-read, mark-all-read):
  - Admin and Super_Admin now see notifications across **all branches** (not just their login branch): `OR $2 IN ('Admin', 'Super_Admin')` added to branch filter
  - Other roles (Manager, Finance_Officer, Stock_Clerk, Sales, Purchasor) see notifications for their specific branch + system-wide (`branch_id IS NULL`) notifications

### Post-Evaluation Bug Fixes (V1)

Applied from `BMS_Fix_Tracker_V1.md` — 19 of 27 fixes completed.

**Critical Fixes ✅**
- **F-001** — Payments 500 error: NULL/NaN guards on `order.total` in payment service
- **F-002** — Orders always backordered: `resolveLocationId()` helper falls back to branch default fulfillment location in `confirm()` and `fulfill()`
- **F-003** — Order fulfillment not decrementing inventory: same `resolveLocationId()` fix in `fulfill()`
- **F-004** — Returns blocked for Admin: Admin/Super_Admin bypass branch check in `returns.service.ts`
- **F-023** — Sales cannot initiate returns: Sales added to POST /returns RBAC

**Security & Auth Fixes ✅**
- **F-016** — Deactivated staff not immediately locked out: `auth.ts` middleware queries `staff.is_active` on every request; returns 401 ACCOUNT_INACTIVE
- **F-017** — `must_change_password` not enforced: login flow forces profile page with warning banner; navigation blocked until changed

**Business Rule Fixes ✅**
- **F-008** — Deactivated branch allows transactions: `branch.is_active` check in POS and Orders create (422 BRANCH_INACTIVE)
- **F-009** — Deactivated customer can create orders: `customer.is_active` check in POS and Orders create (422 CUSTOMER_INACTIVE)

**RBAC Fixes ✅**
- **F-014** — Finance_Officer cannot access Reports: added to all report routes, payments, returns, and nav

**UI/UX Fixes ✅**
- **F-006** — Branch duplicate name error not shown: explicit DUPLICATE_BRANCH_NAME message in BranchesPage
- **F-007** — Branch delete button missing: Delete button added (Admin/Super_Admin only) with confirmation dialog
- **F-013** — Inventory not updated after exchange: cache invalidation on exchange create/cancel
- **F-015** — Superadmin wrong landing page: role-based landing for all 7 roles
- **F-018** — Catalog "All" shows only active: removed hardcoded `is_active=true` default from `searchBooks`
- **F-025** — Dashboard not branch-specific: Manager pre-populates branchId from JWT; KPI auto-refreshes every 30s
- **F-026** — CSV export buttons missing: export buttons for all 5 report types in Dashboard filter bar
- **F-027** — DB test data cleanup: `npm run reseed` executed

**Post-Evaluation Bug Fixes (V1) — Session 2 ✅**

Additional fixes applied in a follow-up session:

- **Staff Multi-Role per Branch** — Migration `1700000029` changes `staff_branch_roles` from `PRIMARY KEY (staff_id, branch_id)` to a serial PK with `UNIQUE (staff_id, branch_id, role)`. A staff member can now hold e.g. Manager + Finance_Officer at the same branch. Login picks the first role for the selected branch (backward compatible). StaffPage RoleEditor updated to allow multiple role assignments per branch.

- **Catalog Search — Complete Fix** — Root cause was systematic missing `$` prefix in PostgreSQL parameterized placeholders (`${p++}` instead of `$${p++}`) across ISBN, SKU, isActive, and author conditions in `searchBooks`. All conditions now correctly use `$${p++}`. Search field now covers title + author name + SKU via a single OR condition. Dedicated `?author=` JOIN-based filter added. Active/Inactive dropdown filter confirmed working.

- **Inventory Transfer — Destination Dropdown** — Destination locations now fetched directly from `GET /branches/:branchId/locations` using the current session branch on mount. No longer depends on inventory records existing at the destination. Updates automatically when a book from a different branch is selected. Note: transfer remains within-branch only (location to location); cross-branch transfer is a deferred feature.

---

## What's New — May 2026

### ERP Production Hardening (Complete)

- **Order Lifecycle State Machine** — `DRAFT → CONFIRMED → PAID → FULFILLED → COMPLETED / CANCELLED` with inventory reservations, financial transactions, and `allowedActions` in every response
- **Exchange Lifecycle State Machine** — `INITIATED → REVIEWED → APPROVED → SETTLED → COMPLETED / CANCELLED` with multi-entry hybrid settlement, returned item condition classification (resellable/damaged), and atomic inventory + finance updates
- **Permission-Based Access Control** — all routes use `requirePermission(...)` instead of `requireRole(...)`; permissions are the union of all roles for the active branch
- **Financial Transactions Table** — `financial_transactions` with idempotency key, order/exchange linkage, and DB-level constraint ensuring every record references an order or exchange
- **Inventory Reservations** — soft holds on stock at order confirmation; released on cancel, converted to deductions on fulfillment
- **Property-Based Tests** — 7 correctness properties validated (status monotonicity, inventory conservation, settlement balance, financial traceability, idempotency, permission union, reservation availability)

### Multi-Role / Multi-Branch Auth Refactor (May 2026)

- **Two-Step Login** — credentials first, then branch picker (auto-selects if single branch)
- **Branch Switcher** — top navigation dropdown; switches active branch without re-login; recomputes permissions
- **`roles` Array in JWT** — all roles for the active branch included alongside primary `role` field
- **`is_all_branches` Flag** — Admin/Super_Admin have cross-branch access by default; any staff can be granted this via the Staff page
- **Permission-Based Form Visibility** — New Order / Exchange forms shown based on `CREATE_SALE` permission, not role name
- **Staff Management** — All Branches toggle in staff creation form and staff list actions
- **Bug Fixes** — catalog `GET /api/books` 500 (missing `$` prefix on SQL params), React key warning in OrdersPage, CSRF on pre-login endpoint, session restore on F5

---

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + TypeScript + Vite |
| Styling | Tailwind CSS (dark mode: class strategy) |
| State / Data | TanStack Query v5 |
| Backend | Node.js 20 + Express 5 + TypeScript |
| Database | PostgreSQL 16 (raw pg driver, no ORM) |
| Auth | JWT (15 min) + httpOnly refresh cookie (8 hours) |
| Encryption | AES-256-GCM (column-level, bank account data) |
| Migrations | node-pg-migrate (.cjs format, 34 migrations) |
| Testing | Vitest + Supertest (integration tests, real DB) |
| Container | Docker + Docker Compose |

---

## Running Locally

```bash
npm install
docker compose up -d postgres
cd apps/api && npm run migrate
npm run dev:api   # terminal 1
npm run dev:web   # terminal 2
```

Open http://localhost:5173

**Default credentials** (password: `Admin@1234`):
- `superadmin` — all permissions, all branches
- `admin` — all permissions, all branches

**Login flow**: Enter username + password → system shows available branches → select branch (or auto-selects if only one) → logged in.

Note: superadmin and admin both have `is_all_branches = true` and land on the Dashboard after login.

## Running Tests

```bash
cd apps/api && npm test
```

Tests use prefix-based cleanup — seed data is never touched.
Current: 21 test files, 265 tests, 259 passing (6 pre-existing catalog failures unrelated to Phase 5).

## Restoring Seed Data

```bash
cd apps/api && npm run reseed
```

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| DATABASE_URL | PostgreSQL connection string |
| JWT_SECRET | Secret for signing JWTs |
| NODE_ENV | development or production |
| PORT | API port (default: 3000) |
| COLUMN_ENCRYPTION_KEY | 64-char hex key for AES-256-GCM |

Generate encryption key: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

---

## API Reference

### Auth & Staff
- POST /api/auth/pre-login — step 1: validate credentials, return available branches (no auth required)
- POST /api/auth/login — step 2: complete login with selected branch
- POST /api/auth/logout / POST /api/auth/refresh
- GET /api/auth/branches — branches for authenticated user (branch switcher)
- POST /api/auth/switch-branch — issue new access token for a different branch
- GET/POST /api/staff — list / create (Super_Admin, Admin, Manager)
- GET /api/staff/me — own profile + location access scope (all roles)
- PUT /api/staff/me/password — change own password (all roles)
- GET/PUT /api/staff/:id / POST .../deactivate|reactivate|reset-password|unlock
- GET/PUT /api/staff/:id/locations — location access assignments
- PUT /api/staff/:id/roles — update branch-role assignments
- PUT /api/staff/:id/all-branches — grant/revoke all-branch access (Admin/Super_Admin)

### Branches & Locations
- GET /api/branches/public — no auth, for login dropdown
- GET/POST /api/branches / GET/PUT /api/branches/:id
- POST /api/branches/:id/deactivate|reactivate / DELETE /api/branches/:id
- GET/POST /api/branches/:branchId/locations
- PUT /api/branches/:branchId/locations/:id — rename
- PUT /api/branches/:branchId/locations/:id/set-default
- DELETE /api/branches/:branchId/locations/:id

### Configuration
- GET /api/config/system (Super_Admin, Admin, Manager)
- PUT /api/config/system/:key (Super_Admin only)
- GET/PUT /api/config/branches/:branchId/:key (Admin, Manager)
- DELETE /api/config/branches/:branchId/:key (Admin)

### Bank Accounts
- GET/POST /api/branches/:branchId/bank-accounts
- PUT/POST .../deactivate
- GET/POST /api/branches/:branchId/reconciliation/import
- PUT /api/branches/:branchId/reconciliation/:entryId

### Catalog
- GET /api/books — full-text search (all authenticated)
- POST /api/books / GET/PUT /api/books/:id / POST .../deactivate|reactivate
- GET /api/books/:id/history — field-level edit history
- PUT /api/books/:id/prices/:branchId — branch price override
- GET/POST /api/authors|categories|publishers / PUT/DELETE .../:id
- GET /api/book-formats / GET /api/book-editions

### Inventory
- GET /api/inventory — paginated stock levels
- GET /api/inventory/low-stock / GET /api/inventory/history
- POST /api/inventory/stock-in|stock-out|adjust|transfer
- PUT /api/inventory/reorder-point / POST /api/inventory/initialize

### Suppliers
- GET/POST /api/suppliers / GET/PUT /api/suppliers/:id
- POST /api/suppliers/:id/deactivate|blacklist / DELETE /api/suppliers/:id
- GET/POST /api/books/:bookId/suppliers / DELETE .../suppliers/:supplierId

### Procurement
- GET/POST /api/purchase-orders / GET/PUT /api/purchase-orders/:id
- POST /api/purchase-orders/:id/submit|approve|order|receive|close|cancel

### POS Transactions
- POST /api/pos/transactions — body: { branchId, locationId, customerId?, items, payments, allowCredit? }
- GET /api/pos/transactions — filters: branchId, customerId, staffId, transactionNumber, status, paymentStatus
- GET /api/pos/transactions/:id
- POST /api/pos/transactions/:id/payment — collect outstanding balance
- POST /api/pos/transactions/:id/void

### Returns
- POST /api/returns — body: { transactionId, refundMethod, reason?, lines, approvedBy? }
- GET /api/returns — filters: branchId, customerId, transactionId, status
- GET /api/returns/:id
- POST /api/returns/:id/reject

### Orders
- POST /api/orders — body: { customerId?, locationId?, channel?, notes?, items: [{bookId, quantity, discountAmount?}] }
- GET /api/orders — filters: branchId, customerId, status, paymentStatus, channel
- GET /api/orders/:id
- POST /api/orders/:id/confirm — reserve stock (Manager, Admin)
- POST /api/orders/:id/progress — mark in progress (Manager, Admin, Stock_Clerk)
- POST /api/orders/:id/fulfill — decrement inventory (Manager, Admin, Stock_Clerk)
- POST /api/orders/:id/cancel — body: { reason } (Manager, Admin)
- GET /api/orders/:id/payments — list payments for order
- GET /api/orders/:id/balance — { orderTotal, totalPaid, totalRefunded, outstanding, paymentStatus }

### Payments (Slice 14)
- POST /api/payments — record payment; body: { orderId, amount, paymentMethod, transactionReference?, bankAccountId? (required for bank method) }
- GET /api/payments — list; filters: orderId, status, paymentMethod, dateFrom, dateTo
- GET /api/payments/:id — detail with refunds
- POST /api/payments/:id/refund — process refund; body: { refundAmount, reason, bankAccountId? }
- GET /api/payments/:id/refunds — list refunds for payment
- POST /api/orders/:id/installment-plan — create installment plan; body: { numInstallments, depositAmount?, firstDueDate?, notes? }
- GET /api/orders/:id/installment-plan — get plan with installment schedule
- GET /api/installment-plans/:id — get plan by ID
- POST /api/installments/:id/pay — record installment payment; body: { amount }

### Exchanges (Slice 15)
- POST /api/exchanges — create exchange (Sales, Manager, Admin); body: { locationId?, customerId?, notes?, incomingItems, outgoingItems }
- GET /api/exchanges — list; filters: branchId, customerId, status, dateFrom, dateTo
- GET /api/exchanges/:id — detail with incoming/outgoing items
- POST /api/exchanges/:id/cancel — cancel exchange (Manager, Admin)

### Reports (Slice 16)
- GET /api/reports/sales — total sales, orders, AOV; by period + by branch (Manager, Admin)
- GET /api/reports/payments — collected/refunded/pending; by method + by period (Manager, Admin)
- GET /api/reports/exchanges — exchange totals; by settlement type + by period (Manager, Admin)
- GET /api/reports/inventory — stock summary, low-stock list, top-selling books, movement (Manager, Admin)
- GET /api/reports/customers — totals, repeat customers, top spenders, new by period (Manager, Admin)
- GET /api/reports/kpis — daily/monthly revenue, AOV, active customers, alerts (Manager, Admin)
- Common filters: ?branchId=&dateFrom=&dateTo=&groupBy=day|week|month
- GET /api/reports/sales/export — CSV download (Manager, Admin)
- GET /api/reports/payments/export — CSV download (Manager, Admin)
- GET /api/reports/inventory/export — CSV download (Manager, Admin)
- GET /api/reports/customers/export — CSV download (Manager, Admin)
- GET /api/reports/exchanges/export — CSV download (Manager, Admin)

### Notifications (Phase 5)
- GET /api/notifications/stream — SSE endpoint; `Content-Type: text/event-stream`; sends `connected` event with unread count; heartbeat every 30s (all authenticated roles)
- GET /api/notifications — paginated list for authenticated staff's role + branch; filters: `?isRead=`, `?severity=`, `?page=`, `?pageSize=`
- GET /api/notifications/unread-count — `{ count }` for bell badge (all authenticated roles)
- PUT /api/notifications/:id/read — mark single notification as read
- PUT /api/notifications/read-all — mark all unread as read for the authenticated staff

### Audit Log
- GET /api/audit-logs — paginated; filter by entityType (Super_Admin, Admin)

---

## Seed Credentials

| Username | Password | Role | Landing Page | UI Access |
|----------|----------|------|--------------|-----------|
| superadmin | password | Super_Admin | Settings | Settings, Staff, Branches, Audit Log |
| admin | password | Admin | Dashboard | All operational pages |

Create Manager/Stock_Clerk/Sales/Purchasor/Finance_Officer via the Staff page after logging in as admin.

**Role landing pages after login:**
- Super_Admin → Settings
- Admin / Manager / Finance_Officer → Dashboard
- Sales → POS
- Stock_Clerk → Inventory
- Purchasor → Procurement

---

## Migrations (25 total)

| Migration | Purpose |
|-----------|---------|
| 1700000001_create_audit_logs | Audit log table |
| 1700000002_create_staff_auth | Staff, roles, refresh tokens |
| 1700000003_create_branches | Branches |
| 1700000004_create_config | System + branch config |
| 1700000005_create_bank_accounts | Bank accounts + reconciliation |
| 1700000006_staff_security | Account lockout, password policy |
| 1700000007_create_locations | Locations |
| 1700000008_create_staff_locations | Staff location access |
| 1700000009_create_catalog | Books, prices, categories, tags |
| 1700000010_books_sku | SKU / internal ID |
| 1700000011_master_data | Authors, categories, publishers |
| 1700000012_book_format_edition | Format + edition enums |
| 1700000013_fix_price_pk | Price table PK fix |
| 1700000014_create_inventory | Inventory + history (partitioned) |
| 1700000015_inventory_movement_type | movement_type, reference_type columns |
| 1700000016_create_suppliers | Suppliers + book_suppliers |
| 1700000017_inventory_reference_type | reference_type CHECK constraint |
| 1700000018_create_procurement | Purchase orders + line items + receipts |
| 1700000019_procurement_receiving_location | receiving_branch_id, financial_status |
| 1700000020_create_customers | Customers, groups, loyalty, store credit |
| 1700000021_create_pos | Transactions, line items, payments |
| 1700000022_pos_reference_types | Adds sale, void to reference_type |
| 1700000023_pos_payment_status | payment_status, amount_paid, amount_due |
| 1700000024_create_returns | Returns, return_line_items, refunds |
| 1700000025_create_orders | Orders, order_line_items |
| 1700000026_create_payments | Order payments, order refunds |
| 1700000027_create_exchanges | Exchanges, exchange_incoming_items, exchange_outgoing_items |
| 1700000028_hardening | Idempotency keys, outbox, customer PII columns, installment plans, merchants, bank_account_id on payments |
| 1700000029_staff_multi_role | Drop composite PK on staff_branch_roles; add serial PK + UNIQUE(staff_id, branch_id, role) for multi-role support |
| 1700000030_create_notifications | Notifications table with branch_id, target_roles, severity, is_read; 3 indexes |

---

## Phase 2 — Industry-Grade Improvements

See `BMS_Industry_Grade_Roadmap.md` for the full prioritized roadmap.

### Planned Features (Priority Order)

**P0 — Real-Time Notifications (SSE) ✅ COMPLETE**
Full lifecycle event coverage across all ERP modules. Every state change in Inventory, POS, Orders, Payments, Returns, Procurement, Exchanges, Customers, and Auth generates a role-targeted notification delivered via Server-Sent Events. See `.kiro/specs/bookstore-management-system/notification-spec.md` for the complete event catalog (40+ event types).

**P1 — Dashboard & Reporting Improvements**
- KPI query audit and accuracy fixes
- 4 new KPI cards: POs Awaiting Approval, Overdue Installments, Today's Returns, Today's Credit Sales
- Procurement analytics report (`GET /api/reports/procurement`)
- Returns analytics report (`GET /api/reports/returns`)
- Customer transaction history tab in Customer profile

**P2 — Financial & Security Hardening**
- Overdue installments list for Finance_Officer
- Return approval queue UI for Manager
- Bank reconciliation running balance
- HMAC audit log signing (tamper-evident)
- Redis token revocation cache
- API rate limiting beyond login endpoint
- Session invalidation on role change

**P3 — Operational Completeness**
- Cross-branch stock transfer request workflow
- Book reorder automation (draft PO on low stock)
- Supplier performance tracking

**P4 — Infrastructure**
- Audit log monthly partitioning
- PgBouncer connection pooling
- Read replica for report queries
