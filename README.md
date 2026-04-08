# Bookstore Management System (BMS)

A multi-user, multi-role, multi-branch ERP platform for managing physical bookstore operations — built on the PERN stack with Docker.

---

## Project Status

**Phase 3 Complete (Slices 12–15). Phase 4 Complete (Slices 16–17)**

| Document | Status | Location |
|----------|--------|----------|
| Requirements | Complete | `.kiro/specs/bookstore-management-system/requirements.md` |
| Design | Complete | `.kiro/specs/bookstore-management-system/design.md` |
| Tasks | In Progress | `.kiro/specs/bookstore-management-system/tasks.md` |

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

---

## Role-Based Access Control

| Role | Can Do | Cannot Do |
|------|--------|-----------|
| Super_Admin | System config, staff, audit log, branches | Any operational activity |
| Admin | All operational management | System-level config writes |
| Manager | Daily operations: catalog, inventory, orders, returns | System config, staff creation |
| Finance_Officer | Bank accounts, reconciliation, view returns | Catalog writes, inventory mutations |
| Stock_Clerk | Stock in/out, adjust, transfer, order fulfillment | PO creation, cash handling |
| Sales | POS, orders, returns (under limit), customer service | Inventory adjust/transfer, suppliers |
| Purchasor | Supplier CRUD, PO creation and tracking | Receiving inventory, approving payments |

Key rules:
- Super_Admin manages platform only — no operational access
- Manager/Admin self-approve high-value returns automatically
- All restrictions enforced at the API layer

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

---

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + TypeScript + Vite |
| Styling | Tailwind CSS (dark mode: class strategy) |
| State / Data | TanStack Query v5 |
| Backend | Node.js 20 + Express 5 + TypeScript |
| Database | PostgreSQL 16 (raw pg driver, no ORM) |
| Auth | JWT (15 min) + httpOnly refresh cookie (7 days) |
| Encryption | AES-256-GCM (column-level, bank account data) |
| Migrations | node-pg-migrate (.cjs format, 27 migrations) |
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

Open http://localhost:5173 — login with superadmin / password / Main Branch.

Note: superadmin only sees Settings, Staff, Branches, and Audit Log. Use admin / password for all operational pages.

## Running Tests

```bash
cd apps/api && npm test
```

Tests use prefix-based cleanup — seed data is never touched.
Current: 19 test files, 238 tests, all passing.

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
- POST /api/auth/login — login with branch selection
- POST /api/auth/logout / POST /api/auth/refresh
- GET/POST /api/staff — list / create (Super_Admin, Admin, Manager)
- GET /api/staff/me — own profile + location access scope (all roles)
- PUT /api/staff/me/password — change own password (all roles)
- GET/PUT /api/staff/:id / POST .../deactivate|reactivate|reset-password|unlock
- GET/PUT /api/staff/:id/locations — location access assignments

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
- POST /api/payments — record payment (Sales, Manager, Admin); body: { orderId, amount, paymentMethod, transactionReference? }
- GET /api/payments — list; filters: orderId, status, paymentMethod, dateFrom, dateTo
- GET /api/payments/:id — detail with refunds
- POST /api/payments/:id/refund — process refund (Manager, Admin); body: { refundAmount, reason }
- GET /api/payments/:id/refunds — list refunds for payment

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

### Audit Log
- GET /api/audit-logs — paginated; filter by entityType (Super_Admin, Admin)

---

## Seed Credentials

| Username | Password | Role | UI Access |
|----------|----------|------|-----------|
| superadmin | password | Super_Admin | Settings, Staff, Branches, Audit Log |
| admin | password | Admin | All operational pages |

Create Manager/Stock_Clerk/Sales/Purchasor via the Staff page after logging in as admin.

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
