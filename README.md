# Bookstore Management System (BMS)

A multi-user, multi-role, multi-branch ERP platform for managing physical bookstore operations — built on the PERN stack with Docker.

---

## Project Status

**Phase 2 — Slices 8, 9, 10 & 11 Complete. Next: Slice 12 (Returns & Refunds)**

| Document | Status | Location |
|----------|--------|----------|
| Requirements | ✅ Complete | `.kiro/specs/bookstore-management-system/requirements.md` |
| Design | ✅ Complete | `.kiro/specs/bookstore-management-system/design.md` |
| Tasks | ✅ In Progress | `.kiro/specs/bookstore-management-system/tasks.md` |

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
| 12–15 | Returns, Orders, Payments, Exchange | ⬜ Pending |
| 16–17 | Reporting + UI/Dashboard | ⬜ Pending |

---

## Role-Based Access Control (RBAC)

Every API endpoint and UI page enforces role restrictions. The table below summarises what each role can and cannot do.

| Role | Scope | Can Do | Cannot Do |
|------|-------|--------|-----------|
| `Super_Admin` | Global | System config, staff management, audit log, branch management | Any operational activity (catalog, inventory, suppliers, bank accounts, POS, orders) |
| `Admin` | Global / Multi-Branch | All operational management, staff, branches, bank accounts, catalog, inventory, suppliers | System-level config writes |
| `Manager` | Branch / Multi-Branch | Daily operations: catalog, inventory, suppliers, bank accounts, locations, reconciliation | System config, staff creation |
| `Finance_Officer` | Global / Multi-Branch | Read bank accounts, reconciliation import/clear | Catalog writes, inventory mutations, supplier writes |
| `Stock_Clerk` | Branch / Multi-Branch | Stock in/out, adjust, transfer, inventory reads | PO creation, cash handling, catalog writes |
| `Sales` | Branch | POS transactions, stock-out, customer service | Inventory adjust/transfer, supplier management, PO creation |
| `Purchasor` | Branch / Multi-Branch | Supplier CRUD, PO creation and tracking | Receiving inventory, approving payments |

### Key RBAC Rules

- `Super_Admin` manages **platform and configuration only** — no catalog writes, no inventory mutations, no supplier management, no bank account operations
- `Super_Admin` sees: Branches, Staff, Settings, Audit Log in the UI
- Operational pages (Catalog, Inventory, Suppliers, Bank Accounts, Locations) are hidden from `Super_Admin`
- All restrictions are enforced at the **API layer** via `requireRole()` middleware — client-side nav filtering is cosmetic only

---

## What's Built

### Phase 0 — System Validation ✅

**Slice 0 — Infrastructure**
- Monorepo: `apps/api` (Node.js 20 + TypeScript + Express 5), `apps/web` (React 18 + Vite + Tailwind), `packages/shared`
- Docker Compose: API + PostgreSQL 16
- JWT auth (15 min access + httpOnly refresh cookie), 7-role RBAC
- Audit log: all write actions recorded; real-time viewer UI
- Dark/light mode, animated login, collapsible sidebar

**Slices 2+3 — Staff & Auth + Branch Management**
- Full JWT authentication: login with branch selection, logout, token refresh
- 7-role RBAC: `Super_Admin`, `Admin`, `Manager`, `Finance_Officer`, `Stock_Clerk`, `Sales`, `Purchasor`
- Staff management: create, deactivate, reactivate, branch-role assignment, account lockout, password policy, force-reset
- Branch management: CRUD with dependency guard (409 if locations/staff/orders exist)
- Staff profile: own profile view, password change, security status (locked, must-change)
- Admin controls: unlock accounts, reset passwords, view full security detail

### Phase 1 — Core Business Foundation ✅

**Slice 1 — Configuration & System Settings**
- 21 system-wide defaults (currency, tax, discounts, inventory, procurement, returns, payments, loyalty, exchange)
- Per-branch overrides with fallback to system defaults
- 15 typed helper methods for use by downstream services
- Settings UI: 10-tab page (General, Discounts, Inventory, Procurement, Returns, Payments, Loyalty, Exchange, Notifications, Security)
- RBAC: `Super_Admin` writes system config; `Admin`/`Manager` write branch overrides

**Slice 4 — Bank Account Management**
- AES-256-GCM column encryption for account numbers and IBANs
- Reconciliation import (batch, full rollback on error), clear entries
- RBAC: `Admin`/`Manager` write; `Finance_Officer` read + reconcile

**Slice 5 — Location Management + Access Control**
- Locations per branch with single-default enforcement (DB-level)
- Staff location access control: explicit assignments or full-branch fallback
- Location access scope surfaced in `GET /api/staff/me` and ProfilePage
- RBAC: `Admin`/`Manager` write; all operational roles read

**Slice 6 — Catalog Management**
- Master data architecture: Authors, Categories, Publishers as independent entities
- Books reference master data by ID; format + edition required (structured enums)
- Book formats: softcover, hardcover, leather_bound, cloth_bound, traditional_orthodox
- Book editions: first_edition, revised_edition, student_edition, annotated, special_religious
- Pricing can vary by format/edition/branch combination
- Full-text search (tsvector), ISBN-13 validation, SKU/internal ID support
- Production-grade catalog UI: compact filter bar, URL-synced filters, sortable columns, bulk select, tabbed create/edit drawer
- RBAC: `Admin`/`Manager` write; all operational roles read; `Super_Admin` excluded from writes

**Slice 7 — Inventory Management**
- `inventory` table: stock per book per location with optimistic locking (version counter)
- `inventory_history` partitioned table: full audit trail with `movement_type`, `reference_type`, `reference_id`
- 5 movement types: `stock_in`, `stock_out`, `transfer_in`, `transfer_out`, `adjustment`
- Stock In / Stock Out as first-class operations; accept reference to source document (PO, order, etc.)
- Adjust: admin corrections only (damage, loss, return, correction)
- Transfer: atomic REPEATABLE READ + FOR UPDATE; dual history rows
- Low-stock detection via partial index; auto-refresh alerts dashboard
- 7 UI sub-pages: Stock Levels | Stock In | Stock Out | Adjust | Transfer | History | Low Stock Alerts
- RBAC: `Sales` can stock-out; `Stock_Clerk` can stock-in/out/adjust/transfer; `Admin`/`Manager` full access; `Super_Admin` excluded

### Phase 2 — Operations (In Progress) 🔄

**Slice 8 — Supplier Management ✅**
- Unified party model: `supplier_type` = `external` (distributor/wholesaler) or `publisher` (direct from catalog publisher)
- `publisher`-type suppliers require a `publisher_id` FK to the catalog publishers table; `external` must have `publisher_id = NULL` (enforced by DB CHECK constraints)
- `is_blacklisted` flag: blacklisted suppliers are blocked from new purchase orders
- `book_suppliers` junction table: books can map to multiple suppliers with `supplier_sku` and `is_primary` flag
- `validateSupplierForProcurement()`: rejects inactive or blacklisted suppliers before PO creation
- `getSuppliersForBook()`: returns linked suppliers sorted by `is_primary DESC`
- Inventory `reference_type` extended: `purchase_order`, `return`, `adjustment`, `manual`, `initial_stock` (migration 1700000017)
- Supplier UI: DataTable with type/status badges, blacklist action, create/edit drawer with dynamic publisher selector
- RBAC: `Admin`/`Manager`/`Purchasor` manage suppliers; `Admin`/`Manager` blacklist/delete; `Super_Admin` excluded

**Slice 9 — Procurement & Purchase Orders ✅**
- Full PO lifecycle: draft → pending_approval → approved → ordered → partially_received → received → closed → cancelled
- Approval threshold: auto-approved if total ≤ `po_approval_threshold` config; otherwise requires Manager/Admin approval
- Flexible receiving destination: `receiving_branch_id` + `receiving_location_id` on PO — supports direct-to-branch delivery (Option A) or centralized receiving + transfer (Option B via Inventory `transfer()`)
- GRN (Goods Receipt Note): transactional receive with inline inventory update — sole authoritative source of `stock_in` for purchased goods; `locationId` in GRN is optional (falls back to PO's `receiving_location_id`)
- Partial receiving supported; status auto-transitions to `partially_received` or `received`
- Over-receipt rejected (422 OVER_RECEIPT); cancel blocked after any receipt exists
- `financial_status` field (`unpaid`/`partial`/`paid`) tracks payment readiness — payment logic deferred to Slice 14 (no cross-slice coupling)
- 4 UI sub-views: PO List, PO Detail (with receiving location + payment status), Receive Goods (GRN form with branch-scoped location selector pre-selecting PO's receiving location), Create/Edit PO (with receiving branch + location dropdowns)
- RBAC: `Admin`/`Manager`/`Purchasor` create; `Admin`/`Manager` approve/close; `Admin`/`Manager`/`Stock_Clerk` receive; `Finance_Officer` read-only
- 16 integration tests passing (including flexible location and PO-default-location fallback tests)
- GRN form always fetches full PO detail (bypasses list cache) to ensure line items are populated
- Stock In PO reference shows dropdown of approved POs instead of free-text input

**Slice 10 — Customer Management ✅**
- Customer as a core financial entity: CRUD with auto-generated `customer_code` (CUS-0001 format)
- Customer groups for segmentation with `discount_pct` (ready for POS Slice-11)
- Loyalty accounts auto-created on customer creation; config-driven accrual (`getLoyaltyAccrualRate`, `getLoyaltyMinTransactionAmount`); redeem with balance validation
- Store credit accounts with non-negative balance enforcement; credit/debit with full audit trail
- 4 UI sub-views: Customer List (search by name/phone/code), Customer Profile (edit form), Loyalty Tab (balance + redeem + history), Store Credit Tab (balance + manual adjustment + history)
- RBAC: all roles view; `Admin`/`Manager`/`Sales` create+edit; `Admin`/`Manager` deactivate; `Admin`/`Finance_Officer` adjust store credit; `Sales` redeem loyalty
- Forward-compatible: `customers.id` ready to be referenced by transactions, orders, returns (Slices 11–13)
- 15 integration tests passing

**Slice 11 — POS Transactions ✅**
- Single-step atomic transaction engine: no draft state, completed immediately on creation
- Currency locked to ETB (Ethiopian Birr) — enforced at DB and service layer
- Inventory decremented via `stock_out` with `inventory_history` (`reference_type = 'sale'`)
- Config-driven tax rate and per-role max discount enforcement
- Customer integration: loyalty point accrual on subtotal, loyalty point redemption, store credit deduction
- Void: reverses inventory (`reference_type = 'void'`), reverses loyalty accrual + redemption, restores store credit
- Transaction number format: `POS-YYYYMMDD-XXXX`
- 3-column POS terminal UI: book search | cart (qty ±, inline discount) | summary + payment (Cash/Bank/Store Credit/Loyalty)
- Bank payment method: dropdown of active branch bank accounts
- "Fill ETB X.XX" quick-fill button + auto-default to remaining balance on empty Add click
- Pending balance indicator: amber (due) / green (paid) / red (overpaid)
- Credit sales: `payment_status` (`paid`/`partial`/`credit`) tracked per transaction; `amount_paid` and `amount_due` stored
- "Credit Sale" button (amber) allows recording a sale with partial or zero payment — requires a customer
- `POST /api/pos/transactions/:id/payment` collects outstanding balance on credit/partial transactions
- History tab: Paid/Due columns, payment_status badge (green/amber/red), "Collect" button on pending rows
- Receipt modal on success; transaction history tab with filters
- Location dropdown correctly scoped to logged-in branch via `getCurrentBranchId()` (session memory)
- Migration `1700000022`: extends `inventory_history_reference_type_check` to include `'sale'` and `'void'`
- Migration `1700000023`: adds `payment_status`, `amount_paid`, `amount_due` to `transactions`
- RBAC: `Sales`/`Manager` create; `Manager`/`Admin` void; all authenticated view
- 10 integration tests passing

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + TypeScript + Vite |
| Styling | Tailwind CSS (dark mode: class strategy) |
| State / Data | TanStack Query v5 |
| Backend | Node.js 20 + Express 5 + TypeScript |
| Database | PostgreSQL 16 (raw `pg` driver, no ORM) |
| Auth | JWT (15 min) + httpOnly refresh cookie (7 days) |
| Encryption | AES-256-GCM (column-level, bank account data) |
| Migrations | node-pg-migrate (`.cjs` format) |
| Testing | Vitest + Supertest (integration tests, real DB) |
| Container | Docker + Docker Compose |

---

## Running Locally

```bash
# 1. Install dependencies
npm install

# 2. Start PostgreSQL
docker compose up -d postgres

# 3. Run migrations
cd apps/api && npm run migrate

# 4. Start API (terminal 1)
npm run dev:api

# 5. Start web (terminal 2)
npm run dev:web
```

Open `http://localhost:5173` — login with `superadmin` / `password` / Main Branch.

> Note: `superadmin` only sees Settings, Staff, Branches, and Audit Log. Use `admin` / `password` for operational pages (Catalog, Inventory, Suppliers, etc.).

## Running Tests

```bash
cd apps/api && npm test
```

> Tests use prefix-based cleanup — seed data is never touched.
> Current: **14 test files, 196 tests, all passing.**

## Restoring Seed Data

```bash
cd apps/api && npm run reseed
```

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Secret for signing JWTs |
| `NODE_ENV` | `development` \| `production` |
| `PORT` | API port (default: 3000) |
| `COLUMN_ENCRYPTION_KEY` | 64-char hex key for AES-256-GCM |

Generate encryption key: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

---

## API Reference (Implemented)

### Auth & Staff
- `POST /api/auth/login` — login with branch selection
- `POST /api/auth/logout` / `POST /api/auth/refresh`
- `GET/POST /api/staff` — list / create (`Super_Admin`, `Admin`, `Manager`)
- `GET /api/staff/me` — own profile + location access scope (all roles)
- `PUT /api/staff/me/password` — change own password (all roles)
- `GET/PUT /api/staff/:id` — detail / update (`Super_Admin`, `Admin`)
- `POST /api/staff/:id/deactivate|reactivate|reset-password|unlock` (`Super_Admin`, `Admin`)
- `GET/PUT /api/staff/:id/locations` — location access assignments

### Branches & Locations
- `GET /api/branches/public` — no auth, for login dropdown
- `GET/POST /api/branches` — list / create (`Super_Admin`, `Admin`, `Manager`)
- `GET/PUT /api/branches/:id` — detail / update
- `POST /api/branches/:id/deactivate|reactivate`
- `DELETE /api/branches/:id` — 409 if dependencies exist (`Super_Admin`, `Admin`)
- `GET/POST /api/branches/:branchId/locations` (`Admin`, `Manager`)
- `PUT /api/branches/:branchId/locations/:id` — rename
- `PUT /api/branches/:branchId/locations/:id/set-default`
- `DELETE /api/branches/:branchId/locations/:id`

### Configuration
- `GET /api/config/system` — read (`Super_Admin`, `Admin`, `Manager`)
- `PUT /api/config/system/:key` — write (`Super_Admin` only)
- `GET/PUT /api/config/branches/:branchId/:key` — branch overrides (`Admin`, `Manager`)
- `DELETE /api/config/branches/:branchId/:key` — remove override (`Admin`)

### Bank Accounts
- `GET/POST /api/branches/:branchId/bank-accounts` (`Admin`, `Manager`; Finance_Officer read)
- `PUT/POST .../deactivate` (`Admin`, `Manager`)
- `GET/POST /api/branches/:branchId/reconciliation/import` (`Admin`, `Manager`, `Finance_Officer`)
- `PUT /api/branches/:branchId/reconciliation/:entryId` (`Admin`, `Manager`, `Finance_Officer`)

### Catalog (Slice 6)
- `GET /api/books` — list with full-text search (all authenticated)
- `POST /api/books` — create (`Admin`, `Manager`)
- `GET/PUT /api/books/:id` — detail / update (`Admin`, `Manager` write)
- `POST /api/books/:id/deactivate|reactivate` (`Admin`, `Manager`)
- `GET /api/books/:id/history` — field-level edit history (`Admin`, `Manager`)
- `PUT /api/books/:id/prices/:branchId` — branch price override (`Admin`, `Manager`)
- `GET/POST /api/authors` / `PUT/DELETE /api/authors/:id` (`Admin`, `Manager` write)
- `GET/POST /api/categories` / `PUT/DELETE /api/categories/:id` (`Admin`, `Manager` write)
- `GET/POST /api/publishers` / `PUT/DELETE /api/publishers/:id` (`Admin`, `Manager` write)
- `GET /api/book-formats` / `GET /api/book-editions` (all authenticated)

### Inventory (Slice 7)
- `GET /api/inventory` — paginated stock levels (all authenticated)
- `GET /api/inventory/low-stock` — items at/below reorder point (all authenticated)
- `GET /api/inventory/history` — movement log (all authenticated)
- `POST /api/inventory/stock-in` — `Admin`, `Manager`, `Stock_Clerk`
- `POST /api/inventory/stock-out` — `Admin`, `Manager`, `Stock_Clerk`, `Sales`
- `POST /api/inventory/adjust` — `Admin`, `Manager`, `Stock_Clerk`
- `POST /api/inventory/transfer` — `Admin`, `Manager`, `Stock_Clerk`
- `PUT /api/inventory/reorder-point` — `Admin`, `Manager`
- `POST /api/inventory/initialize` — `Admin`, `Manager`

### Suppliers (Slice 8)
- `GET /api/suppliers` — list with filters (`Admin`, `Manager`, `Purchasor`)
- `POST /api/suppliers` — create (`Admin`, `Manager`, `Purchasor`)
- `GET/PUT /api/suppliers/:id` — detail / update (`Admin`, `Manager`, `Purchasor`)
- `POST /api/suppliers/:id/deactivate` — (`Admin`, `Manager`, `Purchasor`)
- `POST /api/suppliers/:id/blacklist` — (`Admin`, `Manager`)
- `DELETE /api/suppliers/:id` — (`Admin`, `Manager`)
- `GET /api/books/:bookId/suppliers` — linked suppliers sorted by is_primary (all authenticated)
- `POST /api/books/:bookId/suppliers` — link supplier to book (`Admin`, `Manager`)
- `DELETE /api/books/:bookId/suppliers/:supplierId` — unlink (`Admin`, `Manager`)

### Procurement (Slice 9)
- `GET /api/purchase-orders` — list (`Admin`, `Manager`, `Purchasor`, `Stock_Clerk`, `Finance_Officer`)
- `POST /api/purchase-orders` — create (`Admin`, `Manager`, `Purchasor`)
- `GET/PUT /api/purchase-orders/:id` — detail / update draft
- `POST /api/purchase-orders/:id/submit` — submit for approval (`Admin`, `Manager`, `Purchasor`)
- `POST /api/purchase-orders/:id/approve` — approve (`Admin`, `Manager`)
- `POST /api/purchase-orders/:id/order` — mark as ordered (`Admin`, `Manager`, `Purchasor`)
- `POST /api/purchase-orders/:id/receive` — GRN (`Admin`, `Manager`, `Stock_Clerk`); body: `{ locationId? (optional, falls back to PO's receiving_location_id), items: [{ poLineItemId, quantityReceived }] }`
- `POST /api/purchase-orders/:id/close` — close (`Admin`, `Manager`)
- `POST /api/purchase-orders/:id/cancel` — cancel (`Admin`, `Manager`, `Purchasor`)

### POS Transactions (Slice 11)
- `POST /api/pos/transactions` — create transaction (`Sales`, `Manager`); body: `{ branchId, locationId, customerId?, items, payments, allowCredit? }`
- `GET /api/pos/transactions` — list (all authenticated); filters: `branchId`, `customerId`, `staffId`, `dateFrom`, `dateTo`, `status`, `paymentStatus`
- `GET /api/pos/transactions/:id` — detail with line items + payments (all authenticated)
- `POST /api/pos/transactions/:id/payment` — collect outstanding balance on credit/partial transaction (`Sales`, `Manager`, `Admin`)
- `POST /api/pos/transactions/:id/void` — void transaction (`Manager`, `Admin`)

### Audit Log
- `GET /api/audit-logs` — paginated; filter by entityType (`Super_Admin`, `Admin`)

---

## Seed Credentials

| Username | Password | Role | Branch | UI Access |
|----------|----------|------|--------|-----------|
| `superadmin` | `password` | Super_Admin | Main Branch | Settings, Staff, Branches, Audit Log |
| `admin` | `password` | Admin | Main Branch | All operational pages |

> Create a Manager/Stock_Clerk/Sales/Purchasor via the Staff page after logging in as `admin`.
