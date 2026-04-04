# Bookstore Management System (BMS)

A multi-user, multi-role, multi-branch ERP platform for managing physical bookstore operations — built on the PERN stack with Docker. 

---

## Project Status

**Phase 1 — Slices 0–7 Complete. Next: Slice 8 (Supplier Management)**

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
| 8 | Supplier Management | ⬜ Next |
| 8–15 | Operations + Financial Flows | ⬜ Pending |
| 16–17 | Reporting + UI/Dashboard | ⬜ Pending |

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

### Phase 1 — Core Business Foundation 🔄

**Slice 1 — Configuration & System Settings ✅**
- 21 system-wide defaults (currency, tax, discounts, inventory, procurement, returns, payments, loyalty, exchange and others)
- Per-branch overrides with fallback to system defaults
- 15 typed helper methods for use by downstream services
- Settings UI: 10-tab page (General, Discounts, Inventory, Procurement, Returns, Payments, Loyalty, Exchange, Notifications, Security)

**Slice 4 — Bank Account Management ✅**
- AES-256-GCM column encryption for account numbers and IBANs
- Reconciliation import (batch, full rollback on error), clear entries
- RBAC: Admin/Manager write; Finance_Officer reconcile

**Slice 5 — Location Management + Access Control ✅**
- Locations per branch with single-default enforcement (DB-level)
- Staff location access control: explicit assignments or full-branch fallback
- Location access scope surfaced in `GET /api/staff/me` and ProfilePage

**Slice 6 — Catalog Management ✅**
- Master data architecture: Authors, Categories, Publishers as independent entities
- Books reference master data by ID; format + edition required (structured enums)
- Book formats: softcover, hardcover, leather_bound, cloth_bound, traditional_orthodox
- Book editions: first_edition, revised_edition, student_edition, annotated, special_religious
- Pricing can vary by format/edition/branch combination
- Full-text search (tsvector), ISBN-13 validation, SKU/internal ID support
- Production-grade catalog UI: compact filter bar, URL-synced filters, sortable columns, bulk select, tabbed create/edit drawer

**Slice 7 — Inventory Management ✅**
- `inventory` table: stock per book per location with optimistic locking (version counter)
- `inventory_history` partitioned table: full audit trail with `movement_type`, `reference_type`, `reference_id`
- 5 movement types: `stock_in`, `stock_out`, `transfer_in`, `transfer_out`, `adjustment`
- Stock In / Stock Out as first-class operations (not generic adjust misuse); accept reference to source document (PO, order, etc.)
- Adjust: admin corrections only (damage, loss, return, correction)
- Transfer: atomic REPEATABLE READ + FOR UPDATE; dual history rows
- Low-stock detection via partial index; auto-refresh alerts dashboard
- 7 UI sub-pages: Stock Levels | Stock In | Stock Out | Adjust | Transfer | History | Low Stock Alerts
- RBAC: Sales can stock-out; Stock_Clerk can stock-in/out/adjust/transfer; Admin/Manager full access
- Future hooks prepared: Procurement → `stockIn()`, POS/Orders → `stockOut()`, Returns → `stockIn()`

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

## Running Tests

```bash
cd apps/api && npm test
```

> Tests use prefix-based cleanup — seed data is never touched.
> Current: **10 test files, 133 tests, all passing.**

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
- `GET/POST /api/staff` — list / create
- `GET /api/staff/me` — own profile + location access scope
- `PUT /api/staff/me/password` — change own password
- `GET/PUT /api/staff/:id` — detail / update
- `POST /api/staff/:id/deactivate|reactivate|reset-password|unlock`
- `GET/PUT /api/staff/:id/locations` — location access assignments

### Branches & Locations
- `GET /api/branches/public` — no auth, for login dropdown
- `GET/POST /api/branches` — list / create
- `GET/PUT /api/branches/:id` — detail / update
- `POST /api/branches/:id/deactivate|reactivate`
- `DELETE /api/branches/:id` — 409 if dependencies exist
- `GET/POST /api/branches/:branchId/locations`
- `PUT /api/branches/:branchId/locations/:id` — rename
- `PUT /api/branches/:branchId/locations/:id/set-default`
- `DELETE /api/branches/:branchId/locations/:id`

### Configuration
- `GET/PUT /api/config/system` / `GET/PUT/DELETE /api/config/branches/:branchId/:key`

### Bank Accounts
- `GET/POST /api/branches/:branchId/bank-accounts`
- `POST /api/branches/:branchId/bank-accounts/:id/deactivate`
- `GET/POST /api/branches/:branchId/reconciliation/import`
- `PUT /api/branches/:branchId/reconciliation/:entryId`

### Catalog (Slice 6)
- `GET/POST /api/books` — list (full-text search, filters) / create
- `GET/PUT /api/books/:id` — detail / update
- `POST /api/books/:id/deactivate|reactivate`
- `GET /api/books/:id/history` — field-level edit history
- `GET/PUT /api/books/:id/prices/:branchId` — branch price override
- `GET /api/authors` / `POST /api/authors` / `PUT/DELETE /api/authors/:id`
- `GET /api/categories` / `POST /api/categories` / `PUT/DELETE /api/categories/:id`
- `GET /api/publishers` / `POST /api/publishers` / `PUT/DELETE /api/publishers/:id`
- `GET /api/book-formats` — softcover, hardcover, leather_bound, cloth_bound, traditional_orthodox
- `GET /api/book-editions` — first_edition, revised_edition, student_edition, annotated, special_religious
- `GET /api/catalog/authors/suggest?q=` — autocomplete
- `GET /api/catalog/categories/suggest?q=` — autocomplete

### Inventory (Slice 7)
- `GET /api/inventory` — paginated stock levels; `?q`, `locationId`, `bookId`, `lowStockOnly`
- `GET /api/inventory/low-stock` — all items at/below reorder point
- `GET /api/inventory/history` — movement log; filter by book/location/reason/movementType/date
- `POST /api/inventory/stock-in` — Manager, Stock_Clerk; `referenceType`/`referenceId` optional
- `POST /api/inventory/stock-out` — Manager, Stock_Clerk, Sales; enforces stock availability
- `POST /api/inventory/adjust` — Admin/Manager/Stock_Clerk; corrections only (damage/loss/return/correction)
- `POST /api/inventory/transfer` — atomic transfer between locations; 409/422
- `PUT /api/inventory/reorder-point` — Admin/Manager only
- `POST /api/inventory/initialize` — idempotent row creation

### Audit Log
- `GET /api/audit-logs` — paginated; filter by entityType

---

## Seed Credentials

| Username | Password | Role | Branch |
|----------|----------|------|--------|
| `superadmin` | `password` | Super_Admin | Main Branch |
| `admin` | `password` | Admin | Main Branch |

> Super_Admin manages system configuration only. Operational catalog/inventory work requires Admin or Manager role.
