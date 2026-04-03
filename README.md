# Bookstore Management System (BMS)

A multi-user, multi-role, multi-branch ERP platform for managing physical bookstore operations.

## Project Status

**Phase: Phase 1 — Slices 0–5 Complete. Next: Slice 6 (Catalog Management)**

| Document | Status | Location |
|----------|--------|----------|
| Requirements | ✅ Complete | `.kiro/specs/bookstore-management-system/requirements.md` |
| Design | ✅ Complete | `.kiro/specs/bookstore-management-system/design.md` |
| Tasks | ✅ In Progress | `.kiro/specs/bookstore-management-system/tasks.md` |

---

## Implementation Progress

### Phase 0 — System Validation ✅ COMPLETE

**Task 0A — Bootstrap Minimal Infrastructure** ✅
- Monorepo: `apps/api` (Node.js 20 + TypeScript 5 + Express 5), `apps/web` (React 18 + Vite + Tailwind), `packages/shared`
- Docker Compose: API + PostgreSQL 16
- node-pg-migrate with `.cjs` migration files (required for ESM monorepo)
- DB migrations: `audit_logs`, `staff`, `staff_branch_roles`, `refresh_tokens`, `branches`
- Express middleware: JWT auth, RBAC (`requireRole`), branch context, request ID, structured JSON logging, global error handler
- `GET /health` endpoint
- Vitest + Supertest integration test infrastructure (prefix-based cleanup — seed data never touched)

**Task 0B — Auth + Branch Management** ✅
- Full JWT authentication: login (branch dropdown), logout, token refresh
- 7-role RBAC: `Super_Admin`, `Admin`, `Manager`, `Finance_Officer`, `Stock_Clerk`, `Sales`, `Purchasor`
- Staff management: create, deactivate, reactivate, branch-role assignment (full replace)
- Branch management: create, update, deactivate, reactivate, delete (with dependency guard)
- Audit log: all write actions recorded with staff, role, entity, branch context
- Audit Log viewer UI: real-time (3s polling), expandable details, entity filter
- Toast notifications for all CRUD actions
- Role-based UI: nav items and action buttons hidden based on JWT role

**Task 0B.9 — Staff Profile & Security** ✅
- DB migration `1700000006_staff_security`: `failed_login_attempts`, `locked_until`, `must_change_password`, `last_login_at`, `password_changed_at`
- 3 system_config security keys: `max_failed_login_attempts` (5), `account_lockout_minutes` (30), `password_expiry_days` (0)
- Login enforces account lockout after N failed attempts; resets on success; tracks `last_login_at`
- `GET /api/staff/me` — own profile with security fields + location access scope
- `PUT /api/staff/me/password` — verifies current password, enforces complexity, clears `must_change_password`
- `GET /api/staff/:id` — Admin+; full staff detail including security status
- `POST /api/staff/:id/reset-password` — Admin+; sets temp password, forces `must_change_password=true`, revokes all tokens
- `POST /api/staff/:id/unlock` — Admin+; clears lockout, resets failed attempt counter
- ProfilePage: avatar, account details, last login, password changed date, branch-role badges, location access scope, must-change-password banner, password change form
- StaffPage: 🔒 Locked and ⚠ Must reset status badges; unlock and reset-password icon buttons
- SettingsPage: Security tab with the 3 policy keys
- 9 integration tests — all passing

**UI Polish** ✅
- Dark / light mode with system preference detection and `localStorage` persistence
- Animated login page with glassmorphism card and gradient background
- Collapsible sidebar with icons, role-colored badges, dark mode toggle
- All pages fully dark-mode compatible (`dark:` Tailwind classes throughout)

**Seed credentials (local dev):**
- `superadmin` / `password` / Branch: Main Branch (role: Super_Admin)
- `admin` / `password` / Branch: Main Branch (role: Admin)

---

### Phase 1 — Core Business Foundation 🔄 IN PROGRESS

**Task 1 — Configuration & System Settings** ✅
- DB migration: `system_config` (key/value, system-wide) + `branch_config` (per-branch overrides)
- 21 system defaults seeded: currency, tax, discounts, inventory, procurement, returns, payments, loyalty, exchange, notifications
- `config.service.ts`: `getEffectiveConfig` (branch → system fallback), `setSystemConfig`, `setBranchConfig`, `deleteBranchConfig`
- 15 typed helper methods for use by future service modules (`getPOApprovalThreshold`, `getLoyaltyAccrualRate`, `isNegativeStockAllowed`, etc.)
- API routes: `GET/PUT /api/config/system`, `GET/PUT/DELETE /api/config/branches/:branchId/:key`
- RBAC: Super_Admin only for system config writes; Admin/Manager for branch overrides
- Settings UI: 10-tab page (General, Discounts, Inventory, Procurement, Returns, Payments, Loyalty, Exchange, Notifications, Security)
- 13 integration tests — all passing

**Task 4 — Bank Account Management** ✅
- `lib/encryption.ts`: AES-256-GCM column encryption (`encrypt`, `decrypt`, `maskLast4`) — key from `COLUMN_ENCRYPTION_KEY` env var
- DB migration: `bank_accounts` (encrypted account_number + IBAN) + `bank_reconciliation` tables
- `bankAccount.service.ts`: create (encrypts at rest), update (re-encrypts if changed), deactivate, list (always masked), `importReconciliation` (batch, full rollback on error), `clearEntry` (409 if already cleared)
- API routes: 8 endpoints under `/api/branches/:branchId/bank-accounts` and `/api/branches/:branchId/reconciliation`
- RBAC: Admin/Manager/Finance_Officer read; Admin/Manager write; Finance_Officer reconcile
- Bank Accounts UI: two-panel layout — accounts table + reconciliation panel, branch selector, create form, deactivate, import, clear entries, status filter, pagination
- 10 integration tests — all passing; account numbers verified encrypted at rest

**Task 5 — Location Management + Access Control** ✅
- DB migration `1700000007_create_locations`: `locations` table with `UNIQUE (branch_id, name)` + partial unique index `WHERE is_default_fulfillment = true` (DB-enforced single default per branch)
- DB migration `1700000008_create_staff_locations`: `staff_locations` junction table for optional location-level access control
- Seed: one default "Main Floor" location inserted for every existing branch on migration
- `location.service.ts`: `listLocations`, `createLocation` (409 on duplicate name), `renameLocation`, `setDefaultLocation` (atomic), `deleteLocation` (409 DEPENDENCY_CONFLICT if inventory/orders exist)
- `locationAccess.service.ts`: `getAccessibleLocations`, `assertLocationAccess`, `assignLocationsToStaff`, `getStaffLocationAssignments`
- **Location access model**: Staff with no assignments → full branch access (fallback). Staff with explicit assignments → restricted to those locations only. Enforced at API layer, not just UI.
- `GET /api/branches/:branchId/locations` — access-aware: Admin/Manager see all; restricted staff see only their assigned locations; response includes `accessMode: 'full' | 'restricted'`
- `GET /api/staff/me` — includes `locationAccess: { mode, locations[] }` for current session scope
- API routes: 5 location CRUD endpoints + 2 staff-location assignment endpoints
- LocationsPage UI: branch selector, location table, inline rename, set-default, delete with confirmation; restricted access banner shown to restricted staff
- StaffPage: 📍 location access icon per staff row → inline LocationAccessPanel with checkbox selection, fallback mode indicator
- ProfilePage: "Location Access (Current Session)" section showing scope (Full Access / Restricted with location list)
- 17 location CRUD tests + 14 location access control tests — all passing (80 total across 8 test files)

---

## Domain Coverage (17 Vertical Slices)

| Slice | Domain | Status |
|-------|--------|--------|
| 0 | Infrastructure | ✅ Done |
| 2+3 | Staff & Auth + Branch | ✅ Done |
| 1 | Configuration & System Settings | ✅ Done |
| 4 | Bank Account Management | ✅ Done |
| 5 | Location Management + Access Control | ✅ Done |
| 6 | Catalog Management | ⬜ Next |
| 7 | Inventory Management | ⬜ Pending |
| 8–15 | Operations + Financial Flows | ⬜ Pending |
| 16–17 | Reporting + UI/Dashboard | ⬜ Pending |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + TypeScript + Vite |
| Styling | Tailwind CSS (dark mode: class strategy) |
| State / Data | TanStack Query v5 |
| Forms | React Hook Form + Zod |
| Backend | Node.js 20 + Express 5 + TypeScript |
| Database | PostgreSQL 16 (raw `pg` driver, no ORM) |
| Auth | JWT (15 min) + httpOnly refresh cookie (7 days) |
| Encryption | AES-256-GCM (column-level, bank account data) |
| Logging | Structured JSON (console) |
| Container | Docker + Docker Compose |
| Testing | Vitest + Supertest (integration tests, real DB) |

---

## Running Locally

```bash
# 1. Install dependencies
npm install

# 2. Start PostgreSQL (Docker)
docker compose up -d postgres

# 3. Run migrations (from apps/api)
cd apps/api && npm run migrate

# 4. Start API dev server (from root, terminal 1)
npm run dev:api

# 5. Start web dev server (from root, terminal 2)
npm run dev:web
```

Open `http://localhost:5173` — login with `superadmin` / `password` / Main Branch.

## Running Tests

```bash
cd apps/api && npm test
```

> Tests use prefix-based cleanup — seed data (Main Branch, superadmin, admin) is never touched.
> Current: **8 test files, 80 tests, all passing.**

## Restoring Seed Data

If seed data is ever lost (e.g. after a DB reset):

```bash
cd apps/api && npm run reseed
```

Restores: Main Branch, superadmin, admin, 21 system_config defaults, default "Main Floor" location per branch.

---

## Environment Variables

Copy `.env.example` to `.env` and fill in:

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://bms:bms@localhost:5432/bms` |
| `JWT_SECRET` | Secret for signing JWTs | any long random string |
| `NODE_ENV` | Environment | `development` |
| `PORT` | API port (optional) | `3000` |
| `COLUMN_ENCRYPTION_KEY` | 64-char hex key for AES-256-GCM | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

---

## API Reference (Implemented Endpoints)

### Auth
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/login` | None | Login; returns accessToken + sets refresh cookie |
| POST | `/api/auth/logout` | Bearer | Revoke refresh token |
| POST | `/api/auth/refresh` | Cookie | Issue new accessToken |

### Staff
| Method | Path | Roles | Description |
|--------|------|-------|-------------|
| GET | `/api/staff` | Admin+ | List staff with branch-role assignments |
| POST | `/api/staff` | Admin+ | Create staff account |
| GET | `/api/staff/me` | Any | Own profile (security fields + location access scope) |
| PUT | `/api/staff/me/password` | Any | Change own password |
| GET | `/api/staff/:id` | Admin+ | Full staff detail including security status |
| PUT | `/api/staff/:id` | Admin+ | Update full name |
| POST | `/api/staff/:id/deactivate` | Admin+ | Deactivate (revokes tokens) |
| POST | `/api/staff/:id/reactivate` | Admin+ | Reactivate |
| PUT | `/api/staff/:id/roles` | Admin+ | Full replace branch-role assignments |
| POST | `/api/staff/:id/reset-password` | Admin+ | Set temp password + force must_change_password |
| POST | `/api/staff/:id/unlock` | Admin+ | Clear lockout + reset failed attempt counter |
| GET | `/api/staff/:id/locations` | Admin, Manager | Get staff location access assignments |
| PUT | `/api/staff/:id/locations` | Admin, Manager | Set location restrictions (empty array = full access) |

### Branches
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/branches/public` | None | Active branches for login dropdown |
| GET | `/api/branches` | Any | Paginated branch list |
| POST | `/api/branches` | Admin+ | Create branch |
| PUT | `/api/branches/:id` | Admin+ | Update branch |
| POST | `/api/branches/:id/deactivate` | Admin+ | Deactivate |
| POST | `/api/branches/:id/reactivate` | Admin+ | Reactivate |
| DELETE | `/api/branches/:id` | Admin+ | Delete (409 if dependencies exist) |

### Locations (Slice 5)
| Method | Path | Roles | Description |
|--------|------|-------|-------------|
| GET | `/api/branches/:branchId/locations` | Any | List locations (access-filtered for restricted staff) |
| POST | `/api/branches/:branchId/locations` | Admin, Manager | Create location (409 on duplicate name) |
| PUT | `/api/branches/:branchId/locations/:id` | Admin, Manager | Rename location |
| PUT | `/api/branches/:branchId/locations/:id/set-default` | Admin, Manager | Set as default fulfillment (atomic) |
| DELETE | `/api/branches/:branchId/locations/:id` | Admin, Manager | Delete (409 if inventory/orders exist) |

### Configuration (Slice 1)
| Method | Path | Roles | Description |
|--------|------|-------|-------------|
| GET | `/api/config/system` | Admin+ | All 21 system config keys |
| PUT | `/api/config/system/:key` | Super_Admin | Update system default |
| GET | `/api/config/branches/:branchId` | Admin+ | Merged effective config with source labels |
| PUT | `/api/config/branches/:branchId/:key` | Admin+ | Set branch override |
| DELETE | `/api/config/branches/:branchId/:key` | Admin+ | Remove branch override |

### Bank Accounts (Slice 4)
| Method | Path | Roles | Description |
|--------|------|-------|-------------|
| GET | `/api/branches/:branchId/bank-accounts` | Admin+, Finance_Officer | List accounts (masked numbers) |
| POST | `/api/branches/:branchId/bank-accounts` | Admin, Manager | Create account (encrypts at rest) |
| GET | `/api/branches/:branchId/bank-accounts/:id` | Admin+, Finance_Officer | Get single account |
| PUT | `/api/branches/:branchId/bank-accounts/:id` | Admin, Manager | Update account |
| POST | `/api/branches/:branchId/bank-accounts/:id/deactivate` | Admin, Manager | Deactivate |
| GET | `/api/branches/:branchId/reconciliation` | Admin+, Finance_Officer | List reconciliation entries |
| POST | `/api/branches/:branchId/reconciliation/import` | Admin+, Finance_Officer | Import rows (batch, full rollback on error) |
| PUT | `/api/branches/:branchId/reconciliation/:entryId` | Admin+, Finance_Officer | Clear entry (409 if already cleared) |

### Audit Log
| Method | Path | Roles | Description |
|--------|------|-------|-------------|
| GET | `/api/audit-logs` | Admin+ | Paginated audit log; filter by entityType |