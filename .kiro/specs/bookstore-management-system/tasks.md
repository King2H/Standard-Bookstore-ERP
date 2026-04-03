# Implementation Plan: Bookstore Management System

## Overview

Risk-driven, vertically-sliced execution roadmap for a solo developer building a complete production-grade
Bookstore ERP on the PERN stack (PostgreSQL + Express + React + Node.js) with Docker.

**Guiding principles:**
- Validate architecture within the first 2 tasks (auth works, RBAC enforced, one entity operational)
- Progressive complexity — advanced infrastructure (BullMQ, outbox, observability) deferred to Phase 4
- Every task IS a vertical slice (DB → service → API → UI → integration test) — phases are delivery sequencing only
- Property-based tests are optional and scoped to critical modules (Inventory, Payments, Orders)
- Each task has a clear Definition of Done

---

## Slice → Task Traceability Map

Every task in this plan corresponds to exactly one vertical slice from `design.md §1.4`.
**Task N = Slice N = Requirement N** — the same number means the same domain across all three documents.

| Slice / Req / Task | Name | Phase | Key Design Refs |
|---|---|---|---|
| Slice 0 / Task 0A | Infrastructure (cross-cutting) | Phase 0 | design.md §1, §2, §3.2 |
| Slice 2+3 / Task 0B | Staff & Auth + Branch (first vertical slice) | Phase 0 | design.md §3.4, §3.5, §8.1 |
| Slice 1 / Task 1 | Configuration & System Settings | Phase 1 | design.md §3.3 |
| Slice 4 / Task 4 | Bank Account Management | Phase 1 | design.md §3.6, §8.5 |
| Slice 5 / Task 5 | Location Management | Phase 1 | design.md §3.7 |
| Slice 6 / Task 6 | Catalog Management | Phase 1 | design.md §3.8 |
| Slice 7 / Task 7 | Inventory Management | Phase 1 | design.md §3.9, §5.1, §5.2 |
| Slice 8 / Task 8 | Supplier Management | Phase 2 | design.md §3.10 |
| Slice 9 / Task 9 | Procurement & Purchase Orders | Phase 2 | design.md §3.10, §4.3 |
| Slice 10 / Task 10 | Customer Management | Phase 2 | design.md §3.11 |
| Slice 11 / Task 11 | Point of Sale — Transactions | Phase 2 | design.md §3.12, §4.1, §5.3 |
| Slice 12 / Task 12 | Returns & Refunds | Phase 3 | design.md §3.13 |
| Slice 13 / Task 13 | Order Management | Phase 3 | design.md §3.14, §4.2, §5.1 |
| Slice 14 / Task 14 | Payment Management | Phase 3 | design.md §3.14, §5.2, §7.1, §7.2 |
| Slice 15 / Task 15 | Merchant Exchange | Phase 3 | design.md §3.15, §4.5 |
| Slice 16 / Task 16 | Reporting & Analytics | Phase 4 | design.md §6.8 |
| Slice 17 / Task 17 | UI & Data Presentation | Phase 4 | design.md §7.4 |

**Notes on ordering deviations from strict Slice 1→17 sequence:**
- Task 0B covers Slices 2+3 together — auth is untestable without at least one RBAC-protected entity
- Slice 1 (Config) becomes Task 1 in Phase 1 — config depends on staff existing (Slice 2) to write it
- Slice 4 (Bank Accounts) moved to Phase 1 alongside Branch — bank accounts belong to branches and should be set up before any payment flow
- Slices 8+9 (Supplier+Procurement) grouped in Phase 2 — both require inventory (Slice 7) to exist first

---

## Phase 0 — System Validation
> Goal: Prove the architecture works end-to-end. Auth, RBAC, and Branch management operational before any business logic is built.

---

- [x] 0A. Bootstrap Minimal Infrastructure
  > Set up the bare minimum to run a working API with a database. No Redis, no queues, no observability yet.
  > _Design: Slice 0 (cross-cutting infrastructure) | Requirements: 18, 19, 20, 21, 22, 23, 24_

  - [x] 0A.1 Initialize monorepo project structure
    - Create `apps/api` (Node.js 20 + TypeScript 5 + Express 5) and `apps/web` (React 18 + TypeScript 5 + Vite)
    - Configure `tsconfig.json` strict mode for both apps; shared `packages/shared` for types
    - Set up ESLint + Prettier with shared config across workspaces
    - _Requirements: 18, 19_

  - [x] 0A.2 Configure minimal Docker Compose (API + PostgreSQL only)
    - Services: `api` (Node.js), `postgres` (PostgreSQL 16)
    - Mount `apps/api/src/db/migrations/` as volume for migration runs
    - Configure `.env.example` with: `DATABASE_URL`, `JWT_SECRET`, `NODE_ENV`
    - _Requirements: 19, 20_

  - [x] 0A.3 Set up node-pg-migrate and DB connection pool
    - Create `apps/api/src/db/migrations/` directory with `database.json`
    - Implement `apps/api/src/db/index.ts` — single `pg.Pool` connecting to `DATABASE_URL`
    - Add `npm run migrate` script; verify connection on startup with a health log
    - _Requirements: 24_

  - [x] 0A.4 Create base DB migration: audit_logs table (simplified — no partitioning yet)
    - `audit_logs (id BIGSERIAL PK, staff_id INTEGER, staff_role TEXT, action TEXT, entity_type TEXT, entity_id TEXT, branch_id INTEGER, meta JSONB, created_at TIMESTAMPTZ DEFAULT now())`
    - Indexes: `(entity_type, entity_id)`, `(staff_id)`, `(created_at)`
    - Note: partitioning added in Phase 4; this is the functional schema
    - _Requirements: 2.4_

  - [x] 0A.5 Implement Express app skeleton with essential middleware
    - `app.ts` — Express app factory with: JSON body parser, request ID header injection, structured console logging (JSON format, includes requestId + method + path + statusCode + durationMs), global error handler (returns `{ error, message, requestId, timestamp }`)
    - `middleware/auth.ts` — JWT verify → `req.staff`; 401 on missing/expired/invalid token
    - `middleware/rbac.ts` — `requireRole(...roles)` factory; 403 FORBIDDEN on role mismatch
    - `middleware/branchCtx.ts` — validate `X-Branch-Id` header against staff's assigned branches
    - `GET /health` — returns `{ status: 'ok', db: 'ok'|'error' }`; 200/503
    - _Requirements: 2.5, 22.1_

  - [x] 0A.6 Set up Vitest + Supertest integration test infrastructure
    - Configure `vitest.config.ts` with integration test setup (real DB, test transactions)
    - Create `tests/helpers/testDb.ts` — wraps each test in a transaction that rolls back after
    - Create `tests/helpers/testApp.ts` — returns configured Express app for Supertest
    - Create `tests/helpers/seed.ts` — minimal seed helpers (createTestStaff, createTestBranch)
    - _Requirements: 23_

  **Definition of Done:**
  - `docker compose up` starts API + PostgreSQL without errors
  - `GET /health` returns `{ status: 'ok', db: 'ok' }`
  - Migrations run cleanly with `npm run migrate`
  - Integration test infrastructure runs with `npm test`
  - Structured JSON logs visible in console on every request

---

- [x] 0B. Authenticate Staff and Manage Branches (First Working Vertical Slice)
  > First real business flow: create a staff member, assign a role, log in, create a branch. Validates auth + RBAC + one entity end-to-end.
  > _Design: Slice 2 (Staff & Access Control) + Slice 3 (Branch Management) | Requirements: 2, 3_

  - [x] 0B.1 Create DB migration: staff, staff_branch_roles, refresh_tokens
    - `staff (id SERIAL PK, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, full_name TEXT NOT NULL, is_active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT now())`
    - `staff_branch_roles (staff_id INTEGER REFERENCES staff(id), branch_id INTEGER, role TEXT CHECK (role IN ('Super_Admin','Admin','Manager','Finance_Officer','Stock_Clerk','Sales','Purchasor')), PRIMARY KEY (staff_id, branch_id))`
    - `refresh_tokens (id BIGSERIAL PK, staff_id INTEGER REFERENCES staff(id), token_hash TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, revoked BOOLEAN DEFAULT false)` + index on `(staff_id, revoked)`
    - Seed: insert one Super_Admin and one Admin staff record with known credentials for local dev
    - _Requirements: 2_

  - [x] 0B.2 Create DB migration: branches
    - `branches (id SERIAL PK, name TEXT UNIQUE NOT NULL, address TEXT NOT NULL, contact_info JSONB NOT NULL, operating_hours JSONB NOT NULL, is_active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT now())`
    - Seed: insert one default branch for local dev testing
    - _Requirements: 3_

  - [x] 0B.3 Implement auth.service.ts
    - `login(username, password, branchId)` — SELECT staff by username; bcrypt.compare (cost 12); validate is_active; validate branchId in staff_branch_roles; sign 15min JWT `{ staffId, role, branchId }`; generate refresh token; store bcrypt hash in refresh_tokens; return `{ accessToken }`
    - `logout(staffId, tokenHash)` — UPDATE refresh_tokens SET revoked=true WHERE staff_id=$1 AND token_hash=$2
    - `refresh(cookieToken)` — SELECT non-revoked token; bcrypt.compare; issue new JWT
    - `createStaff(data)` — validate password complexity (min 10 chars, upper+lower+digit+special via Zod); bcrypt hash; INSERT staff; INSERT audit_logs
    - `deactivate(staffId)` — UPDATE staff SET is_active=false; UPDATE refresh_tokens SET revoked=true WHERE staff_id=$1; INSERT audit_logs
    - `reactivate(staffId)` — UPDATE staff SET is_active=true; INSERT audit_logs
    - `assignRoles(staffId, roles[])` — UPSERT staff_branch_roles; INSERT audit_logs; validate role IN ('Super_Admin','Admin','Manager','Finance_Officer','Stock_Clerk','Sales','Purchasor')
    - _Requirements: 2.1, 2.2, 2.3, 2.6, 2.8, 2.9_

  - [x] 0B.4 Implement branch.service.ts
    - `create(data, staffCtx)` — INSERT branches; INSERT audit_logs; 409 DUPLICATE_BRANCH_NAME on unique violation
    - `update(id, data, staffCtx)` — UPDATE branches; INSERT audit_logs
    - `deactivate(id, staffCtx)` — UPDATE branches SET is_active=false; INSERT audit_logs
    - `delete(id, staffCtx)` — check for blocking dependencies (locations, staff_branch_roles, open orders); if any: 409 DEPENDENCY_CONFLICT `{ blockingDependencies: [{ type, count }] }`; else DELETE + INSERT audit_logs
    - _Requirements: 3.1, 3.2, 3.3, 3.5, 3.6_

  - [x] 0B.5 Implement auth + staff API routes
    - `POST /api/auth/login` — body: `{ username, password, branchId }`; sets httpOnly SameSite=Strict refresh cookie; response: `{ accessToken, expiresIn: 900 }`; errors: 401 INVALID_CREDENTIALS, 403 ACCOUNT_INACTIVE
    - `POST /api/auth/logout` — revokes refresh token; clears cookie
    - `POST /api/auth/refresh` — reads cookie; issues new accessToken; 401 TOKEN_EXPIRED/TOKEN_REVOKED
    - `GET /api/staff` — Super_Admin/Admin/Manager; paginated list with branch-role assignments; Manager sees own-branch staff only
    - `POST /api/staff` — Super_Admin/Admin; calls createStaff; 409 DUPLICATE_USERNAME
    - `PUT /api/staff/:id` — Super_Admin/Admin; update full_name + audit log
    - `POST /api/staff/:id/deactivate` — Super_Admin/Admin; cannot deactivate self; cannot deactivate last Super_Admin
    - `POST /api/staff/:id/reactivate` — Super_Admin/Admin
    - `PUT /api/staff/:id/roles` — Super_Admin/Admin/Manager; full replace (delete + insert); Manager cannot assign Super_Admin role
    - _Requirements: 2.5, 2.7_
    - _Note: GET /api/branches/public (no auth) added for login page branch dropdown_

  - [x] 0B.6 Implement branch API routes
    - `GET /api/branches/public` — no auth; returns active branches for login page dropdown
    - `GET /api/branches` — any authenticated; paginated; filter by `is_active`
    - `POST /api/branches` — Super_Admin/Admin/Manager; calls create; 403 for other roles
    - `GET /api/branches/:id` — any authenticated
    - `PUT /api/branches/:id` — Super_Admin/Admin/Manager
    - `POST /api/branches/:id/deactivate` — Super_Admin/Admin/Manager
    - `POST /api/branches/:id/reactivate` — Super_Admin/Admin/Manager (added for completeness)
    - `DELETE /api/branches/:id` — Super_Admin/Admin; 409 DEPENDENCY_CONFLICT with dependency list
    - _Requirements: 3.7_

  - [x] 0B.7 Implement Login page and Staff + Branch management UI
    - Login page: username/password/branchId form (React Hook Form + Zod); stores accessToken in memory (not localStorage); auto-refresh on 401; handles 401/403
    - Staff list page: table with username, full_name, is_active, roles per branch; create/edit/deactivate/reactivate actions
    - Branch list page: table with name, address, is_active; create/edit/deactivate/delete actions; dependency error display
    - TanStack Query hooks: `useLogin`, `useLogout`, `useStaffList`, `useCreateStaff`, `useBranchList`, `useCreateBranch`, `useUpdateBranch`, `useDeactivateBranch`
    - _Requirements: 2, 3_

  - [x] 0B.8 Write integration tests for auth and branch flows
    - Auth: login success, login with wrong password (401), login with inactive account (403), token refresh, logout + refresh rejected
    - RBAC: Sales attempting Admin-only endpoint (403), correct role succeeds
    - Branch: create branch (Admin), duplicate name (409), deactivate branch, delete with dependencies (409), delete clean branch (200)
    - Seed data used in all tests via `testDb` helper
    - _Requirements: 2, 3_

  - [x] 0B.9 Implement Staff Profile + Security (self-service, all roles; admin security controls) ✅
    - `GET /api/staff/me` — any role; returns own profile with security fields (mustChangePassword, lastLoginAt, passwordChangedAt, isLocked)
    - `PUT /api/staff/me/password` — any role; verifies current password, enforces complexity, clears must_change_password flag, sets password_changed_at
    - `GET /api/staff/:id` — Admin+; full staff detail including security status
    - `POST /api/staff/:id/reset-password` — Admin+; sets temp password, forces must_change_password=true, revokes all tokens
    - `POST /api/staff/:id/unlock` — Admin+; clears lockout and resets failed attempt counter
    - Migration `1700000006_staff_security`: adds failed_login_attempts, locked_until, must_change_password, last_login_at, password_changed_at to staff table
    - Login enforces account lockout after N failed attempts (configurable via system_config), resets on success, tracks last_login_at
    - 3 new system_config security keys: max_failed_login_attempts (5), account_lockout_minutes (30), password_expiry_days (0)
    - ProfilePage: avatar, account details, last login, password changed date, branch-role badges, must-change-password warning banner, password change form with confirm + complexity validation
    - StaffPage: 🔒 Locked and ⚠ Must reset status badges; unlock icon button (shown when locked); reset-password icon button
    - SettingsPage: new Security tab with the 3 policy keys
    - _Requirements: 2 (RBAC matrix: all roles R on own profile; Admin security controls)_

  **Definition of Done:**
  - `POST /api/auth/login` returns a valid JWT
  - `GET /api/branches` returns 401 without token, 200 with valid token
  - Admin can create a branch; Sales gets 403
  - Deactivated staff cannot refresh token
  - All integration tests pass
  - Audit log entries visible in DB after each write

---

## Phase 1 — Core Business Foundation
> Goal: All master data entities operational. A developer can configure the system, define locations, build the catalog, and track inventory.

---

- [x] 1. Configure System Settings (Business Rules, Discounts, Procurement, Returns, Payments, Loyalty, Exchange)
  > Establish all system-wide and branch-level business rule configurations that every other module depends on. This is the single source of truth for operational policy.
  > _Slice 1 = Requirement 1 | Design: design.md §3.3, §6.4_

  - [x] 1.1 Create DB migration: system_config and branch_config with full seed data
    - `system_config (key TEXT PK, value JSONB NOT NULL, updated_by INTEGER NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())`
    - `branch_config (branch_id INTEGER REFERENCES branches(id), key TEXT, value JSONB NOT NULL, updated_by INTEGER NOT NULL, updated_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (branch_id, key))`
    - Seed all 21 system_config defaults as defined in design.md §3.3 (base_currency, tax_rate, fiscal_year_start_month, max_line_discount_pct, max_transaction_discount_pct, discount_approval_threshold_pct, reorder_point_default, allow_negative_stock, po_approval_threshold, default_supplier_lead_time_days, return_window_days, max_return_value_without_auth, refund_method_after_window, min_deposit_pct, max_installments, installment_grace_period_days, loyalty_accrual_rate, loyalty_redemption_rate, loyalty_min_transaction_amount, exchange_cash_adjustment_allowed, notification_prefs)
    - _Requirements: 1_

  - [x] 1.2 Implement config.service.ts with all typed helpers
    - `getEffectiveConfig(branchId, key)` — SELECT from branch_config; fallback to system_config; cache in Redis `cfg:{branchId}:{key}` TTL 5min; invalidate on write
    - `setSystemConfig(key, value, staffCtx)` — validate value type against key schema; UPDATE system_config; INSERT outbox; invalidate Redis; 403 if not Super_Admin
    - `setBranchConfig(branchId, key, value, staffCtx)` — UPSERT branch_config; INSERT outbox; invalidate Redis; 403 if not Super_Admin/Admin/Manager (own branch)
    - `deleteBranchConfig(branchId, key, staffCtx)` — DELETE branch_config row; key falls back to system default; INSERT outbox
    - Implement all typed helpers: `getMaxLineDiscountPct`, `getDiscountApprovalThresholdPct`, `getPOApprovalThreshold`, `getReturnWindowDays`, `getMaxReturnValueWithoutAuth`, `getRefundMethodAfterWindow`, `getMinDepositPct`, `getMaxInstallments`, `getInstallmentGracePeriodDays`, `getAllowedPaymentMethods`, `getLoyaltyAccrualRate`, `getLoyaltyRedemptionRate`, `getLoyaltyMinTransactionAmount`, `isNegativeStockAllowed`, `isExchangeCashAdjustmentAllowed`
    - _Requirements: 1.24, 1.25, 1.26_

  - [x] 1.3 Implement config API routes
    - `GET /api/config/system` — Super_Admin/Admin/Manager; returns all system_config rows
    - `PUT /api/config/system/:key` — Super_Admin only; 403 for all other roles
    - `GET /api/config/branches/:branchId` — Super_Admin/Admin/Manager (own branch); returns merged effective config with `source` field
    - `PUT /api/config/branches/:branchId/:key` — Super_Admin/Admin/Manager (own branch)
    - `DELETE /api/config/branches/:branchId/:key` — Super_Admin/Admin; removes branch override
    - _Requirements: 1.26_

  - [x] 1.4 Implement Settings UI page (grouped by domain)
    - Settings page at `/settings` with tabs: **General** (currency, tax, fiscal year) | **Discounts** (max line %, max transaction %, approval threshold) | **Inventory** (reorder point, negative stock) | **Procurement** (PO approval threshold, default lead time) | **Returns** (window, max value, refund method) | **Payments** (min deposit, max installments, grace period, allowed methods) | **Loyalty** (accrual rate, redemption rate, min transaction) | **Exchange** (cash adjustment allowed) | **Notifications**
    - Each tab: system default form + branch override panel (branch selector, per-key override, source indicator showing "branch" or "system default")
    - Super_Admin sees system defaults as editable; Admin/Manager see branch overrides only
    - TanStack Query hooks: `useSystemConfig`, `useBranchConfig`, `useUpdateSystemConfig`, `useUpdateBranchConfig`, `useDeleteBranchConfig`
    - _Requirements: 1_

  - [x] 1.5 Write integration tests for config service
    - Branch override returns branch value; absent key returns system default
    - Super_Admin can write system config; Admin gets 403 on system config write
    - Admin can write branch config for own branch; Manager gets 403 on other branch
    - Delete branch override restores system default
    - All writes produce audit log entries
    - Typed helpers return correct parsed values (number, boolean, string[], JSONB)
    - _Requirements: 1.24, 1.25, 1.26_

  - [ ]* 1.6 Write property-based tests for config-driven business rules (Properties 55–64)
    - **Property 55:** Line discount capped at role's max_line_discount_pct — `Validates: Req 1.4`
    - **Property 56:** Transaction discount capped at max_transaction_discount_pct — `Validates: Req 1.5`
    - **Property 57:** PO total > po_approval_threshold → status=PendingApproval — `Validates: Req 1.10`
    - **Property 58:** Installments count ≤ max_installments — `Validates: Req 1.16`
    - **Property 59:** Installment not overdue until grace_period_days after due_date — `Validates: Req 1.17`
    - **Property 60:** Loyalty not accrued when total < loyalty_min_transaction_amount — `Validates: Req 1.21`
    - **Property 61:** Exchange cash adjustment rejected when exchange_cash_adjustment_allowed=false — `Validates: Req 1.22`
    - **Property 62:** Negative stock blocked when allow_negative_stock=false — `Validates: Req 1.9`
    - **Property 63:** Return value > max_return_value_without_auth requires manager auth — `Validates: Req 1.13`
    - **Property 64:** Out-of-window refund restricted to store_credit when refund_method_after_window=store_credit_only — `Validates: Req 1.14`

  **Definition of Done:**
  - All 21 system_config defaults seeded and readable
  - `GET /api/config/branches/:id` returns merged effective config with source labels
  - Branch override takes precedence; delete restores system default
  - Role restrictions enforced (Super_Admin for system, Admin/Manager for branch)
  - All typed helpers callable by other services (POS, procurement, returns, payments, loyalty)
  - Audit log entry created on every config write

---

- [x] 4. Manage Bank Accounts per Branch (Create, Encrypt, Deactivate)
  > Register branch bank accounts with encrypted details. Required before any bank transfer payment can be recorded.
  > _Slice 4 = Requirement 4 | Design: design.md §3.6, §8.5_

  - [x] 4.1 Implement lib/encryption.ts (AES-256-GCM column encryption)

  - [x] 4.2 Create DB migration: bank_accounts, bank_reconciliation

  - [x] 4.3 Implement bankAccount.service.ts

  - [x] 4.4 Implement bank account API routes

  - [x] 4.5 Implement Bank Accounts list and Reconciliation UI

  - [x] 4.6 Write integration tests for bank account service
    - `bank_accounts (id SERIAL PK, branch_id INTEGER REFERENCES branches(id), account_name TEXT NOT NULL, bank_name TEXT NOT NULL, account_number TEXT NOT NULL, iban TEXT, currency TEXT NOT NULL, is_active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT now())` + index on `(branch_id, is_active)`
    - `bank_reconciliation (id BIGSERIAL PK, bank_account_id INTEGER REFERENCES bank_accounts(id), payment_ref_id BIGINT, refund_ref_id BIGINT, amount NUMERIC(14,2) NOT NULL, direction TEXT NOT NULL CHECK (direction IN ('in','out')), status TEXT DEFAULT 'uncleared' CHECK (status IN ('uncleared','cleared','unmatched')), statement_date DATE, notes TEXT, created_at TIMESTAMPTZ DEFAULT now())` + index on `(bank_account_id, status)`
    - _Requirements: 4_

  - [ ] 4.3 Implement bankAccount.service.ts
    - `create(data, staffCtx)` — encrypt account_number and iban with lib/encryption; INSERT bank_accounts; INSERT audit_logs
    - `update(id, data, staffCtx)` — re-encrypt if changed; UPDATE; INSERT audit_logs
    - `deactivate(id, staffCtx)` — UPDATE is_active=false; INSERT audit_logs
    - `importReconciliation(bankAccountId, csvRows, staffCtx)` — BEGIN; for each row: attempt match by amount+direction+date; INSERT bank_reconciliation (uncleared if matched, unmatched if not); COMMIT; rollback entire batch on any row error
    - `clearEntry(entryId, paymentRefId, staffCtx)` — UPDATE status='cleared'; INSERT audit_logs; 409 if already cleared
    - _Requirements: 4.1–4.9_

  - [ ] 4.4 Implement bank account API routes
    - `GET /api/branches/:branchId/bank-accounts` — Admin/Manager; masked account_number (last 4 digits only)
    - `POST /api/branches/:branchId/bank-accounts` — Admin/Manager; 403 for other roles
    - `PUT /api/branches/:branchId/bank-accounts/:id` — Admin/Manager
    - `POST /api/branches/:branchId/bank-accounts/:id/deactivate` — Admin/Manager
    - `GET /api/branches/:branchId/reconciliation` — Admin/Manager; paginated; filter by status
    - `POST /api/branches/:branchId/reconciliation/import` — Admin/Manager; CSV upload
    - `PUT /api/branches/:branchId/reconciliation/:entryId` — Admin/Manager; body: `{ status, paymentRefId? }`
    - _Requirements: 4.9_

  - [ ] 4.5 Implement Bank Accounts list and Reconciliation UI
    - Bank accounts list: table with account_name, bank_name, masked account_number, currency, is_active
    - Reconciliation table: amount, direction, status tabs (uncleared/cleared/unmatched); bulk-clear action
    - CSV import: file picker → preview → confirm → result summary
    - TanStack Query hooks: `useBankAccounts`, `useReconciliation`, `useImportReconciliation`, `useClearEntry`
    - _Requirements: 4_

  - [ ] 4.6 Write integration tests for bank account service
    - Create (encrypted at rest), update, deactivate, CSV import (matched + unmatched), clear entry, already-cleared (409)
    - _Requirements: 4_

  **Definition of Done:**
  - account_number and IBAN encrypted at rest; only last 4 digits shown in UI
  - CSV import rolls back entire batch on any row failure
  - Unmatched entries flagged for review
  - Audit log entries on all writes

---

- [ ] 5. Manage Locations (Create, Rename, Assign Default Fulfillment)
  > Define stock areas within each branch. Required before inventory can be tracked.
  > _Slice 5 = Requirement 5 | Design: design.md §3.7_

  - [ ] 5.1 Create DB migration: locations
    - `locations (id SERIAL PK, branch_id INTEGER REFERENCES branches(id), name TEXT NOT NULL, is_default_fulfillment BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT now(), UNIQUE (branch_id, name))`
    - Index on `branch_id`
    - Seed: insert one default location per seeded branch
    - _Requirements: 5_

  - [ ] 5.2 Implement location.service.ts
    - `create(branchId, name, staffCtx)` — validate branch is_active; INSERT locations; INSERT audit_logs; 409 DUPLICATE_LOCATION_NAME on unique violation
    - `rename(id, name, staffCtx)` — UPDATE locations.name; INSERT audit_logs; 409 on duplicate name within branch
    - `setDefault(id, staffCtx)` — BEGIN; UPDATE locations SET is_default_fulfillment=false WHERE branch_id=$branchId; UPDATE SET is_default_fulfillment=true WHERE id=$id; INSERT audit_logs; COMMIT
    - `delete(id, staffCtx)` — check inventory.quantity > 0 or open orders assigned; 409 DEPENDENCY_CONFLICT; DELETE + INSERT audit_logs if clear
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

  - [ ] 5.3 Implement location API routes
    - `GET /api/branches/:branchId/locations` — any authenticated
    - `POST /api/branches/:branchId/locations` — Admin/Manager; 403 for other roles
    - `PUT /api/branches/:branchId/locations/:id` — Admin/Manager; rename
    - `DELETE /api/branches/:branchId/locations/:id` — Admin/Manager; 409 DEPENDENCY_CONFLICT
    - `PUT /api/branches/:branchId/locations/:id/set-default` — Admin/Manager
    - _Requirements: 5.7_

  - [ ] 5.4 Implement Location list UI per branch
    - Location list: table with name, is_default_fulfillment badge, inventory count; inline rename; set-default button; delete with dependency guard
    - TanStack Query hooks: `useLocations`, `useCreateLocation`, `useRenameLocation`, `useSetDefaultLocation`, `useDeleteLocation`
    - _Requirements: 5_

  - [ ] 5.5 Write integration tests for location service
    - Create location, duplicate name (409), rename, set default (clears previous default), delete with inventory (409), delete clean location
    - _Requirements: 5_

  **Definition of Done:**
  - Locations CRUD working per branch
  - Only one default fulfillment location per branch at any time
  - Delete blocked when inventory exists
  - Audit log entries created on all writes

---

- [ ] 6. Build the Book Catalog (Create, Search, Price Overrides)
  > Master catalog of all books. Required before inventory, POS, or orders can reference books.
  > _Slice 6 = Requirement 6 | Design: design.md §3.8_

  - [ ] 6.1 Create DB migration: books, book_branch_prices, book_categories, book_tags, book_edit_history
    - `books (id SERIAL PK, isbn TEXT UNIQUE NOT NULL, title TEXT NOT NULL, authors TEXT[] NOT NULL, genre TEXT, publisher TEXT, edition TEXT, language TEXT, format TEXT, description TEXT, cover_image_url TEXT, default_price NUMERIC(14,2), trade_value NUMERIC(14,2), is_active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT now(), search_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(array_to_string(authors,' '),''))) STORED)`
    - Indexes: GIN on `search_vector`, btree on `isbn`, btree on `is_active`
    - `book_branch_prices (book_id INTEGER REFERENCES books(id), branch_id INTEGER REFERENCES branches(id), price NUMERIC(14,2) NOT NULL, PRIMARY KEY (book_id, branch_id))`
    - `book_categories (book_id INTEGER REFERENCES books(id), category TEXT NOT NULL, PRIMARY KEY (book_id, category))`
    - `book_tags (book_id INTEGER REFERENCES books(id), tag TEXT NOT NULL, PRIMARY KEY (book_id, tag))`
    - `book_edit_history (id BIGSERIAL PK, book_id INTEGER REFERENCES books(id), field_name TEXT, old_value TEXT, new_value TEXT, changed_by INTEGER, changed_at TIMESTAMPTZ DEFAULT now())` + index on `book_id`
    - Seed: insert 5–10 sample books with categories and tags
    - _Requirements: 6_
    - `create(data, staffCtx)` — validate ISBN-13 check digit (mod-10 algorithm); INSERT books + categories + tags; INSERT audit_logs; 409 DUPLICATE_ISBN
    - `update(id, data, staffCtx)` — diff changed bibliographic fields; INSERT book_edit_history row per changed field; UPDATE books; INSERT audit_logs
    - `deactivate(id, staffCtx)` — UPDATE books SET is_active=false; INSERT audit_logs
    - `setBranchPrice(bookId, branchId, price, staffCtx)` — UPSERT book_branch_prices; INSERT audit_logs
    - `search(query, filters, page)` — full-text via `search_vector @@ to_tsquery` for title/author; exact match for ISBN; filter by genre/category/tag/is_active; paginated with `buildListQuery`
    - `getEffectivePrice(bookId, branchId)` — SELECT from book_branch_prices; fallback to books.default_price
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9_

  - [ ] 3.3 Implement catalog API routes
    - `GET /api/books` — any authenticated; paginated; `?q`, `isbn`, `genre`, `category`, `tag`, `is_active`, `branchId`, `sortBy`, `sortDir`
    - `POST /api/books` — Admin/Manager; 409 DUPLICATE_ISBN; 403 for other roles
    - `GET /api/books/:id` — any authenticated; includes categories, tags, branch prices
    - `PUT /api/books/:id` — Admin/Manager
    - `POST /api/books/:id/deactivate` — Admin/Manager
    - `GET /api/books/:id/history` — Admin/Manager; paginated edit history
    - `GET /api/books/:id/prices` — any authenticated
    - `PUT /api/books/:id/prices/:branchId` — Admin/Manager
    - _Requirements: 6.10_

  - [ ] 6.2 Implement catalog.service.ts
    - `create(data, staffCtx)` — validate ISBN-13 check digit (mod-10 algorithm); INSERT books + categories + tags; INSERT audit_logs; 409 DUPLICATE_ISBN
    - `update(id, data, staffCtx)` — diff changed bibliographic fields; INSERT book_edit_history row per changed field; UPDATE books; INSERT audit_logs
    - `deactivate(id, staffCtx)` — UPDATE books SET is_active=false; INSERT audit_logs
    - `setBranchPrice(bookId, branchId, price, staffCtx)` — UPSERT book_branch_prices; INSERT audit_logs
    - `search(query, filters, page)` — full-text via `search_vector @@ to_tsquery` for title/author; exact match for ISBN; filter by genre/category/tag/is_active; paginated
    - `getEffectivePrice(bookId, branchId)` — SELECT from book_branch_prices; fallback to books.default_price
    - _Requirements: 6.1–6.9_

  - [ ] 6.3 Implement catalog API routes
    - `GET /api/books` — any authenticated; paginated; `?q`, `isbn`, `genre`, `category`, `tag`, `is_active`, `branchId`, `sortBy`, `sortDir`
    - `POST /api/books` — Admin/Manager; 409 DUPLICATE_ISBN; 403 for other roles
    - `GET /api/books/:id` — any authenticated; includes categories, tags, branch prices
    - `PUT /api/books/:id` — Admin/Manager
    - `POST /api/books/:id/deactivate` — Admin/Manager
    - `GET /api/books/:id/history` — Admin/Manager; paginated edit history
    - `GET /api/books/:id/prices` — any authenticated
    - `PUT /api/books/:id/prices/:branchId` — Admin/Manager
    - _Requirements: 6.10_

  - [ ] 6.4 Implement Book list, Detail, and Edit UI
    - Book list: DataTable with isbn, title, authors, genre, default_price, is_active; full-text search input; filter panel
    - Book detail: all fields + categories/tags + branch price overrides table + edit history timeline
    - Create/Edit form: all bibliographic fields + category/tag multi-input
    - TanStack Query hooks: `useBookList`, `useBook`, `useCreateBook`, `useUpdateBook`, `useDeactivateBook`, `useBookHistory`, `useSetBranchPrice`
    - _Requirements: 6_

  - [ ] 6.5 Write integration tests for catalog service
    - Create book, duplicate ISBN (409), update (edit history created), deactivate (rejected from new PO), full-text search returns correct results, branch price override takes precedence
    - _Requirements: 6_

  **Definition of Done:**
  - ISBN-13 check digit validated on create
  - Full-text search returns relevant results
  - Edit history entry created for each changed field
  - Inactive book rejected from new operations
  - Branch price override works correctly

---

- [ ] 7. Track Inventory (Adjust Stock, Transfer Between Locations)
  > Stock levels per book per location. The most concurrency-critical module — optimistic locking implemented here.
  > _Slice 7 = Requirement 7 | Design: design.md §3.9, §5.1, §5.2_
  > _Concurrency: Optimistic locking (version counter) on all inventory mutations — see design.md §5.1_

  - [ ] 7.1 Create DB migration: inventory and inventory_history
    - `inventory (book_id INTEGER REFERENCES books(id), location_id INTEGER REFERENCES locations(id), quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0), reorder_point INTEGER NOT NULL DEFAULT 5, version INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (book_id, location_id))`
    - Partial index: `CREATE INDEX ON inventory (book_id, location_id) WHERE quantity <= reorder_point` (low-stock queries)
    - `inventory_history (id BIGSERIAL NOT NULL, book_id INTEGER NOT NULL, location_id INTEGER NOT NULL, qty_before INTEGER NOT NULL, qty_after INTEGER NOT NULL, delta INTEGER NOT NULL, reason TEXT NOT NULL, reason_code TEXT, staff_id INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (id, created_at)) PARTITION BY RANGE (created_at)`
    - Create initial 3 monthly partitions (current month + 2 ahead)
    - Index on `(book_id, location_id)` on inventory_history
    - Seed: initialize inventory records for seeded books at seeded locations (quantity=0)
    - _Requirements: 7, 24.6_

  - [ ] 7.2 Implement inventory.service.ts
    - `initializeInventory(bookId, locationId)` — INSERT inventory (quantity=0, version=0) ON CONFLICT DO NOTHING
    - `adjust(bookId, locationId, delta, reasonCode, version, staffCtx)` — validate reasonCode IN ('damage','loss','return','correction'); if delta < 0 AND !config.isNegativeStockAllowed(): check current quantity + delta >= 0 (422 INSUFFICIENT_STOCK); `UPDATE inventory SET quantity=quantity+$delta, version=version+1 WHERE book_id=$1 AND location_id=$2 AND version=$3`; if 0 rows: re-read to distinguish VERSION_CONFLICT vs INSUFFICIENT_STOCK; INSERT inventory_history; INSERT audit_logs; if new quantity <= reorder_point: INSERT outbox(InventoryAdjusted) for low-stock alert
    - `transfer(bookId, fromLocationId, toLocationId, quantity, fromVersion, staffCtx)` — BEGIN REPEATABLE READ; SELECT inventory WHERE book_id=$1 AND location_id=$from FOR UPDATE; check quantity >= requested (422 INSUFFICIENT_STOCK); UPDATE source (version check → 409 VERSION_CONFLICT on 0 rows); UPDATE destination (version+1); INSERT inventory_history (TRANSFER_OUT + TRANSFER_IN); INSERT audit_logs; COMMIT
    - `getLowStock(branchId)` — SELECT via partial index WHERE quantity <= reorder_point
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8_

  - [ ] 7.3 Implement inventory API routes
    - `GET /api/inventory` — any authenticated; paginated; `?branchId`, `locationId`, `bookId`, `lowStock=true`
    - `PUT /api/inventory/:bookId/:locationId/adjust` — Manager/Stock_Clerk; body: `{ delta, reasonCode, version }`; 409 VERSION_CONFLICT, 422 INSUFFICIENT_STOCK, 400 INVALID_REASON_CODE
    - `POST /api/inventory/transfer` — Manager/Stock_Clerk; body: `{ bookId, fromLocationId, toLocationId, quantity, fromVersion }`
    - `GET /api/inventory/:bookId/:locationId/history` — any authenticated; paginated
    - _Requirements: 7.9_

  - [ ] 7.4 Implement Inventory grid UI
    - Inventory grid: DataTable with book title, isbn, location, quantity, reorder_point, low-stock badge; filter by branch/location/lowStock
    - Adjust modal: delta input, reasonCode select, version (hidden); client retries on 409 VERSION_CONFLICT (re-fetch version, re-submit up to 3 times)
    - Transfer form: book search, from/to location selects, quantity input
    - History drawer: slide-in panel with inventory_history for selected book+location
    - TanStack Query hooks: `useInventory`, `useAdjustInventory`, `useTransferInventory`, `useInventoryHistory`
    - _Requirements: 7_

  - [ ] 7.5 Write integration tests for inventory service
    - Adjust: success, insufficient stock (422), version conflict (409), reason code validation (400)
    - Transfer: atomic (both locations updated), insufficient stock (422), version conflict (409)
    - History: every quantity change recorded with correct qty_before/qty_after/delta
    - _Requirements: 7_

  - [ ]* 7.6 Write property-based tests for inventory (Properties 17–21)
    - **Property 17:** Inventory initialized to 0 on first association — `Validates: Req 7.1`
    - **Property 18:** Stock transfer atomic: source decrements, destination increments, total conserved — `Validates: Req 7.4`
    - **Property 19:** Transfer rejected when source quantity < requested; no quantity changes — `Validates: Req 7.5`
    - **Property 20:** Low-stock condition detected when quantity falls to or below reorder_point — `Validates: Req 7.7`
    - **Property 21:** Inventory history: qty_after = qty_before + delta for every change — `Validates: Req 7.8`

  **Definition of Done:**
  - Optimistic locking prevents concurrent quantity corruption
  - Transfer is atomic — no partial state possible
  - Version conflict returns 409 with retryable flag
  - Inventory history records every change with correct before/after values
  - Low-stock condition correctly detected

---

- [ ] P1. Phase 1 Checkpoint — Core Foundation Validated
  - Verify: Config (Task 1) → Bank Accounts (Task 4) → Locations (Task 5) → Catalog (Task 6) → Inventory (Task 7) all working end-to-end
  - Run full integration test suite; zero failures
  - Manually test: create branch → add location → add book → adjust inventory → verify history
  - Verify audit_logs table has entries for all write operations
  - Confirm no regressions from Phase 0 (auth + branch still working)

---

## Phase 2 — Operations
> Goal: The system can receive stock, manage customers, and process sales. Core revenue-generating flows operational.

---

- [ ] 8. Manage Suppliers (Register, Update, Deactivate)
  > Supplier registry required before purchase orders can be created.
  > _Slice 8 = Requirement 8 | Design: design.md §3.10_

  - [ ] 8.1 Create DB migration: suppliers
    - `suppliers (id SERIAL PK, name TEXT UNIQUE NOT NULL, contact_info JSONB NOT NULL, lead_time_days INTEGER NOT NULL DEFAULT 7, pricing_terms TEXT, is_active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT now())`
    - Seed: insert 2–3 sample suppliers
    - _Requirements: 8_

  - [ ] 8.2 Implement supplier.service.ts
    - `create(data, staffCtx)` — INSERT suppliers; INSERT audit_logs; 409 DUPLICATE_SUPPLIER_NAME
    - `update(id, data, staffCtx)` — UPDATE suppliers; INSERT audit_logs (does not affect existing POs)
    - `deactivate(id, staffCtx)` — UPDATE is_active=false; INSERT audit_logs
    - `delete(id, staffCtx)` — check for associated POs; 409 DEPENDENCY_CONFLICT if any; DELETE + INSERT audit_logs if clear
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

  - [ ] 8.3 Implement supplier API routes + UI
    - `GET/POST /api/suppliers`, `GET/PUT /api/suppliers/:id`, `POST /api/suppliers/:id/deactivate`, `DELETE /api/suppliers/:id`
    - Supplier list: DataTable with name, lead_time_days, is_active; create/edit/deactivate/delete actions
    - TanStack Query hooks: `useSupplierList`, `useCreateSupplier`, `useUpdateSupplier`, `useDeactivateSupplier`
    - _Requirements: 8.6_

  - [ ] 8.4 Write integration tests for supplier service
    - Create, duplicate name (409), update, deactivate, delete with POs (409), delete clean supplier
    - _Requirements: 8_

  **Definition of Done:**
  - Supplier CRUD working; deactivated supplier blocked from new POs
  - Delete blocked when POs exist

---

- [ ] 9. Procure Stock via Purchase Orders (Create, Receive, Track Status)
  > Full procurement flow: create PO → receive stock → inventory updated. Includes over-receipt confirmation.
  > _Slice 9 = Requirement 9 | Design: design.md §3.10, §4.3_
  > _Concurrency: Optimistic locking on inventory during PO receipt — see design.md §5.1_

  - [ ] 9.1 Create DB migration: purchase_orders, po_line_items, po_receipts
    - `purchase_orders (id SERIAL PK, po_number TEXT UNIQUE NOT NULL, supplier_id INTEGER REFERENCES suppliers(id), branch_id INTEGER REFERENCES branches(id), location_id INTEGER REFERENCES locations(id), status TEXT DEFAULT 'PendingApproval' CHECK (status IN ('PendingApproval','Pending','In_Progress','Closed','Cancelled')), bank_account_id INTEGER REFERENCES bank_accounts(id), notes TEXT, created_by INTEGER NOT NULL, created_at TIMESTAMPTZ DEFAULT now())`
    - Indexes: `(supplier_id, status)`, `(branch_id, status)`
    - `po_line_items (id SERIAL PK, po_id INTEGER REFERENCES purchase_orders(id), book_id INTEGER REFERENCES books(id), qty_ordered INTEGER NOT NULL CHECK (qty_ordered > 0), qty_received INTEGER NOT NULL DEFAULT 0, unit_price NUMERIC(14,2) NOT NULL)` + index on `po_id`
    - `po_receipts (id BIGSERIAL PK, po_id INTEGER REFERENCES purchase_orders(id), line_item_id INTEGER REFERENCES po_line_items(id), qty_received INTEGER NOT NULL, over_receipt BOOLEAN DEFAULT false, confirmed_by INTEGER, received_by INTEGER NOT NULL, received_at TIMESTAMPTZ DEFAULT now())`
    - _Requirements: 9_

  - [ ] 9.2 Implement procurement.service.ts
    - `create(data, staffCtx)` — validate supplier is_active; validate each book is_active; generate unique po_number (`PO-{YYYYMMDD}-{seq}`); compute PO total = SUM(qty × unit_price); if PO total > config.getPOApprovalThreshold(): set status='PendingApproval' and INSERT outbox(POApprovalRequired) to notify Manager/Admin; else set status='Pending'; INSERT purchase_orders + po_line_items; INSERT audit_logs; restricted to `Purchasor` and `Manager` roles
    - `approve(poId, staffCtx)` — validate status='PendingApproval'; UPDATE status='Pending'; INSERT audit_logs; restricted to `Manager` and `Admin` roles; 409 INVALID_STATE_TRANSITION for other statuses
    - `cancel(poId, staffCtx)` — validate status IN ('PendingApproval','Pending'); UPDATE status='Cancelled'; INSERT audit_logs; 409 INVALID_STATE_TRANSITION for other statuses
    - `receive(poId, lineItemId, qtyReceived, confirm, staffCtx)` — validate status='Pending' or 'In_Progress' (409 if PendingApproval — must be approved first); if `qty_received + qtyReceived > qty_ordered` AND `!confirm`: return `202 { requiresConfirmation: true, overReceiptQty }`; else: BEGIN; UPDATE po_line_items.qty_received; UPDATE inventory (optimistic lock — version check); INSERT po_receipts; INSERT inventory_history (PO_RECEIPT); if all lines fully received: UPDATE status='Closed'; else if status='Pending': UPDATE status='In_Progress'; INSERT audit_logs; COMMIT; restricted to `Stock_Clerk` and `Manager` roles (not `Purchasor`)
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.9_

  - [ ] 9.3 Implement procurement API routes
    - `GET /api/purchase-orders` — Purchasor/Manager/Admin; paginated; filter by supplier/branch/status
    - `POST /api/purchase-orders` — Purchasor/Manager; calls create
    - `GET /api/purchase-orders/:id` — Purchasor/Manager/Admin; includes line items + receipts
    - `PUT /api/purchase-orders/:id` — Purchasor/Manager; update notes (PendingApproval or Pending only)
    - `POST /api/purchase-orders/:id/approve` — Manager/Admin; calls approve; 403 for Purchasor
    - `POST /api/purchase-orders/:id/cancel` — Purchasor/Manager/Admin
    - `POST /api/purchase-orders/:id/receive` — Stock_Clerk/Manager only (not Purchasor); body: `{ lineItemId, qtyReceived, confirm? }`; 202 on over-receipt; 409 if status='PendingApproval'
    - _Requirements: 9.10_

  - [ ] 9.4 Implement PO list, Create form, Approve, and Receive stock UI
    - PO list: DataTable with po_number, supplier, branch, status badge (PendingApproval highlighted), created_at; filter by status
    - Create PO form: supplier select, branch/location selects, line item builder (book search + qty + unit_price); shows computed total and approval threshold warning if total exceeds threshold
    - Receive stock form: per-line qty_received input; over-receipt confirmation modal
    - TanStack Query hooks: `usePurchaseOrders`, `useCreatePO`, `useCancelPO`, `useReceivePO`
    - _Requirements: 9_

  - [ ] 9.5 Write integration tests for procurement service
    - Create PO, cancel (Pending only), partial receipt (status → In_Progress), full receipt (status → Closed), over-receipt requires confirmation, inventory incremented correctly
    - _Requirements: 9_

  **Definition of Done:**
  - PO state machine enforced (Pending → In_Progress → Closed, Cancelled from Pending only)
  - Inventory incremented atomically on receipt
  - Over-receipt returns 202 and requires explicit confirmation
  - Audit log entries on all state transitions

---

- [ ] 10. Manage Customers (Profiles, Store Credit, Loyalty Points)
  > Customer registry with encrypted PII, store credit balance, and loyalty points. Required before POS transactions.
  > _Slice 10 = Requirement 10 | Design: design.md §3.11_
  > _Security: AES-256-GCM column encryption for email + phone — see design.md §8.5_

  - [ ] 10.1 Create DB migration: customers, loyalty_history, store_credit_history
    - `customers (id SERIAL PK, full_name TEXT NOT NULL, email TEXT UNIQUE, phone TEXT UNIQUE, email_lookup TEXT, phone_lookup TEXT, notes TEXT, preferences JSONB, store_credit NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (store_credit >= 0), loyalty_points INTEGER NOT NULL DEFAULT 0 CHECK (loyalty_points >= 0), version INTEGER NOT NULL DEFAULT 0, is_active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT now(), CONSTRAINT at_least_one_contact CHECK (email IS NOT NULL OR phone IS NOT NULL))`
    - Indexes: `email_lookup`, `phone_lookup`
    - `loyalty_history (id BIGSERIAL PK, customer_id INTEGER REFERENCES customers(id), delta INTEGER NOT NULL, balance_after INTEGER NOT NULL, reason TEXT CHECK (reason IN ('ACCRUAL','REDEMPTION')), transaction_ref TEXT, created_at TIMESTAMPTZ DEFAULT now())` + index on `customer_id`
    - `store_credit_history (id BIGSERIAL PK, customer_id INTEGER REFERENCES customers(id), delta NUMERIC(14,2) NOT NULL, balance_after NUMERIC(14,2) NOT NULL, reason TEXT NOT NULL, reference_id TEXT, created_at TIMESTAMPTZ DEFAULT now())` + index on `customer_id`
    - Seed: insert 3–5 sample customers
    - _Requirements: 10_

  - [ ] 10.2 Implement customer.service.ts
    - `create(data, staffCtx)` — validate at least one of email/phone non-null (422 CONTACT_REQUIRED); encrypt email+phone with `lib/encryption`; compute `email_lookup` (first 3 chars + SHA-256 hash) and `phone_lookup`; INSERT customers; INSERT audit_logs; 409 DUPLICATE_CONTACT on unique violation
    - `update(id, data, staffCtx)` — re-encrypt if changed; recompute lookup columns; UPDATE customers; INSERT audit_logs
    - `deactivate(id, staffCtx)` — UPDATE is_active=false; INSERT audit_logs
    - `search(query)` — match via email_lookup or phone_lookup; decrypt for display
    - `adjustStoreCredit(id, delta, reason, referenceId, client)` — UPDATE customers SET store_credit=store_credit+$delta, version=version+1 WHERE id=$1 AND version=$v AND store_credit+$delta >= 0; if 0 rows: 422 INSUFFICIENT_STORE_CREDIT or 409 VERSION_CONFLICT; INSERT store_credit_history
    - Note: loyalty accrual is async (Phase 4 Task H1); for now, loyalty_points updated synchronously in POS completion using config.getLoyaltyAccrualRate() and config.getLoyaltyMinTransactionAmount()
    - _Requirements: 10.1, 10.2, 10.4, 10.5, 10.9_

  - [ ] 10.3 Implement customer API routes
    - `GET /api/customers` — any authenticated; paginated; `?q` (search by name/lookup), `is_active`
    - `POST /api/customers` — any authenticated; calls create
    - `GET /api/customers/:id` — any authenticated; decrypted email/phone for display
    - `PUT /api/customers/:id` — any authenticated
    - `POST /api/customers/:id/deactivate` — Admin/Manager
    - `GET /api/customers/:id/transactions` — any authenticated; paginated
    - `GET /api/customers/:id/orders` — any authenticated; paginated
    - `GET /api/customers/:id/loyalty-history` — any authenticated; paginated
    - _Requirements: 10_

  - [ ] 10.4 Implement Customer list and Detail UI
    - Customer list: DataTable with full_name, masked email/phone, store_credit, loyalty_points, is_active; search input
    - Customer detail: profile info + store_credit + loyalty_points + tabs (Transactions, Orders, Loyalty History, Store Credit History)
    - TanStack Query hooks: `useCustomerList`, `useCustomer`, `useCreateCustomer`, `useUpdateCustomer`, `useDeactivateCustomer`
    - _Requirements: 10_

  - [ ] 10.5 Write integration tests for customer service
    - Create with email only, phone only, both, neither (422); duplicate email (409); store credit never goes below 0 (422); search by email_lookup returns correct customer
    - _Requirements: 10_

  **Definition of Done:**
  - PII encrypted at rest; search works via lookup columns
  - Store credit balance never goes below 0
  - At least one contact field required
  - Audit log entries on all writes

---

- [ ] 11. Process Sales at POS (Create Transaction, Complete, Void)
  > Core revenue flow. Most complex concurrency scenario — optimistic inventory lock + pessimistic transaction lock.
  > _Slice 11 = Requirement 11 | Design: design.md §3.12, §4.1, §5.3_
  > _Concurrency: REPEATABLE READ isolation + SELECT FOR UPDATE on transaction row + optimistic lock on inventory_

  - [ ] 11.1 Create DB migration: transactions, transaction_line_items, transaction_payments
    - `transactions (id BIGSERIAL NOT NULL, branch_id INTEGER REFERENCES branches(id), location_id INTEGER REFERENCES locations(id), customer_id INTEGER REFERENCES customers(id), staff_id INTEGER NOT NULL, status TEXT DEFAULT 'draft' CHECK (status IN ('draft','completed','voided')), subtotal NUMERIC(14,2), discount_total NUMERIC(14,2) DEFAULT 0, tax_rate NUMERIC(6,4) NOT NULL, tax_amount NUMERIC(14,2), total NUMERIC(14,2), discount_reason TEXT, created_at TIMESTAMPTZ DEFAULT now(), completed_at TIMESTAMPTZ, PRIMARY KEY (id, created_at)) PARTITION BY RANGE (created_at)`
    - Create initial 3 monthly partitions for transactions
    - Indexes: `(branch_id, status)`, `(customer_id) WHERE customer_id IS NOT NULL`, `(completed_at) WHERE status='completed'`
    - `transaction_line_items (id BIGSERIAL PK, transaction_id BIGINT NOT NULL, book_id INTEGER REFERENCES books(id), quantity INTEGER NOT NULL CHECK (quantity > 0), unit_price NUMERIC(14,2) NOT NULL, discount_amount NUMERIC(14,2) DEFAULT 0, discount_reason TEXT, line_total NUMERIC(14,2) NOT NULL)` + index on `transaction_id`
    - `transaction_payments (id BIGSERIAL PK, transaction_id BIGINT NOT NULL, method TEXT NOT NULL CHECK (method IN ('cash','credit_card','debit_card','store_credit','loyalty_points','bank_transfer')), amount NUMERIC(14,2) NOT NULL CHECK (amount > 0), bank_account_id INTEGER REFERENCES bank_accounts(id), created_at TIMESTAMPTZ DEFAULT now())` + index on `transaction_id`
    - _Requirements: 11, 24.5_

  - [ ] 11.2 Implement pos.service.ts
    - `createDraft(branchId, locationId, customerId, staffCtx)` — validate branch is_active; get effective tax rate via config.service; INSERT transactions (status='draft', tax_rate=effectiveTaxRate); INSERT audit_logs; restricted to `Sales` and `Manager` roles
    - `addLine(txId, bookId, quantity, discountAmount, discountReason, staffCtx)` — validate book is_active (422 BOOK_INACTIVE); get effective price via catalog.service.getEffectivePrice; if discountAmount > 0: validate discountReason non-empty (400 DISCOUNT_REASON_REQUIRED); validate discountAmount <= config.getMaxLineDiscountPct(branchId, role) × unitPrice (422 DISCOUNT_EXCEEDS_ROLE_LIMIT); if discountAmount > config.getDiscountApprovalThresholdPct × unitPrice: set line flag `requires_approval=true`; INSERT transaction_line_items; recalculate subtotal/tax_amount/total on transaction
    - `removeLine(txId, lineId, staffCtx)` — DELETE transaction_line_items; recalculate totals
    - `complete(txId, payments, managerOverride, staffCtx)` — BEGIN REPEATABLE READ; SELECT transactions WHERE id=$1 FOR UPDATE; validate status='draft' (409 ALREADY_COMPLETED); validate SUM(payments.amount) = transaction.total (422 PAYMENT_SUM_MISMATCH); validate bank_account_id for bank_transfer payments (422 INVALID_BANK_ACCOUNT); validate store_credit balance if method='store_credit'; validate loyalty_points balance if method='loyalty_points'; validate allowed_payment_methods config for each method (422 PAYMENT_METHOD_NOT_ALLOWED); SELECT inventory FOR UPDATE for all line items; check each quantity >= line.quantity — if isNegativeStockAllowed()=false: 422 INSUFFICIENT_STOCK unless managerOverride; UPDATE inventory (optimistic version check → 409 VERSION_CONFLICT on 0 rows); INSERT transaction_payments; UPDATE transactions SET status='completed', completed_at=now(); INSERT inventory_history (SALE entries); if customer and loyalty_program enabled and transaction.total >= getLoyaltyMinTransactionAmount(): UPDATE customers.loyalty_points + INSERT loyalty_history (synchronous for now); INSERT audit_logs; COMMIT
    - `void(txId, reason, staffCtx)` — validate status='draft' (409 ALREADY_COMPLETED); UPDATE status='voided'; INSERT audit_logs
    - _Requirements: 11.1–11.13_

  - [ ] 11.3 Implement POS API routes
    - `POST /api/transactions` — Sales/Manager; body: `{ branchId, locationId, customerId? }`
    - `POST /api/transactions/:id/lines` — Sales/Manager; body: `{ bookId, quantity, discountAmount?, discountReason? }`
    - `DELETE /api/transactions/:id/lines/:lineId` — Sales/Manager
    - `POST /api/transactions/:id/complete` — Sales/Manager; body: `{ payments: [{ method, amount, bankAccountId? }], managerOverride?: { managerId, reason } }`; returns receipt payload
    - `POST /api/transactions/:id/void` — Sales/Manager; body: `{ reason }`
    - `GET /api/transactions` — any authenticated; paginated; filter by branch/status/date
    - `GET /api/transactions/:id` — any authenticated; includes line items + payments
    - _Requirements: 11_

  - [ ] 11.4 Implement POS screen UI
    - POS screen: book search (ISBN or title), line items table (qty, unit_price, discount, line_total), split payment panel (method + amount, running total vs remaining), complete/void buttons
    - Receipt modal: itemized lines, discounts, tax breakdown, payment method breakdown, transaction ID
    - Transaction list: DataTable with id, branch, status, total, created_at
    - TanStack Query hooks: `useCreateTransaction`, `useAddLine`, `useRemoveLine`, `useCompleteTransaction`, `useVoidTransaction`, `useTransactionList`
    - _Requirements: 11_

  - [ ] 11.5 Write integration tests for POS service
    - Complete transaction: inventory decremented, receipt returned, audit log created
    - Payment sum mismatch (422), insufficient stock (422), version conflict (409)
    - Completed transaction immutable (409 on second complete attempt)
    - Void draft transaction; void completed transaction (409)
    - Store credit and loyalty points deducted correctly
    - _Requirements: 11_

  - [ ]* 11.6 Write property-based tests for POS (Properties 29–34)
    - **Property 29:** Effective price = branch price if exists, else catalog default — `Validates: Req 11.2`
    - **Property 30:** Effective tax rate = branch override if exists, else system default — `Validates: Req 11.4`
    - **Property 31:** Split payment sum equals transaction total exactly — `Validates: Req 11.7`
    - **Property 32:** Inventory decremented by exactly sold quantity on completion — `Validates: Req 11.8`
    - **Property 33:** Insufficient stock blocks completion without manager override — `Validates: Req 11.9`
    - **Property 34:** Completed transaction is immutable — `Validates: Req 11.13`

  **Definition of Done:**
  - POS completion is atomic — no partial state on failure
  - Inventory decremented correctly with optimistic locking
  - Payment sum must equal transaction total exactly
  - Receipt returned on successful completion
  - Loyalty points updated synchronously

---

- [ ] P2. Phase 2 Checkpoint — Operations Validated
  - Run full integration test suite; zero failures
  - Manually test full flow: create supplier (Task 8) → create PO (Task 9) → receive stock → create customer (Task 10) → complete POS transaction (Task 11) → verify inventory decremented + audit log
  - Verify concurrent inventory update handled correctly (run two simultaneous adjustments, one should get 409)
  - Confirm no regressions from Phase 0 and Phase 1

---

## Phase 3 — Financial & Advanced Flows
> Goal: Orders, installment payments, returns, bank accounts, and merchant exchange fully operational.

---

- [ ] 12. Process Returns and Issue Refunds
  > Reverse a completed transaction. Includes return window enforcement, partial returns, and store credit issuance.
  > _Slice 12 = Requirement 12 | Design: design.md §3.13_

  - [ ] 12.1 Create DB migration: returns, return_line_items, refunds
    - `returns (id BIGSERIAL PK, original_tx_id BIGINT NOT NULL, branch_id INTEGER REFERENCES branches(id), location_id INTEGER REFERENCES locations(id), staff_id INTEGER NOT NULL, manager_auth_id INTEGER, created_at TIMESTAMPTZ DEFAULT now())` + index on `original_tx_id`
    - `return_line_items (id BIGSERIAL PK, return_id BIGINT REFERENCES returns(id), tx_line_id BIGINT REFERENCES transaction_line_items(id), quantity INTEGER NOT NULL CHECK (quantity > 0), refund_amount NUMERIC(14,2) NOT NULL)`
    - `refunds (id BIGSERIAL PK, return_id BIGINT REFERENCES returns(id), method TEXT NOT NULL CHECK (method IN ('original','store_credit','bank_transfer')), amount NUMERIC(14,2) NOT NULL CHECK (amount > 0), bank_account_id INTEGER REFERENCES bank_accounts(id), reason TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now())`
    - _Requirements: 12_

  - [ ] 12.2 Implement returns.service.ts
    - `processReturn(data, staffCtx)` — validate original_tx_id references completed transaction (422 INVALID_TRANSACTION_REFERENCE); get return_window_days via config.getReturnWindowDays(branchId); if `now() > completed_at + return_window_days` AND no manager_auth_id: 403 RETURN_WINDOW_EXCEEDED; compute total refund value; if refund value > config.getMaxReturnValueWithoutAuth() AND no manager_auth_id: 403 RETURN_VALUE_EXCEEDS_LIMIT; if out-of-window AND config.getRefundMethodAfterWindow() = 'store_credit_only' AND refundMethod != 'store_credit': 422 REFUND_METHOD_NOT_ALLOWED_AFTER_WINDOW; for each line: compute sum of previously returned qty; if sum + new qty > original qty: 422 QUANTITY_EXCEEDS_ORIGINAL; BEGIN; INSERT returns + return_line_items; UPDATE inventory (increment at receiving location); if refundMethod='store_credit': adjustStoreCredit + INSERT store_credit_history; if refundMethod='bank_transfer': validate bank_account_id; INSERT refunds; INSERT audit_logs; COMMIT
    - _Requirements: 12.1–12.8_

  - [ ] 12.3 Implement returns API routes + UI
    - `POST /api/returns` — Sales/Manager; body: `{ originalTxId, lines: [{txLineId, quantity}], refundMethod, bankAccountId?, reason, managerAuthId? }`
    - `GET /api/returns/:id`, `GET /api/transactions/:id/returns`
    - Return form: transaction lookup → line item checkboxes + qty inputs → refund method selector → manager auth modal if window exceeded
    - TanStack Query hooks: `useProcessReturn`, `useReturn`, `useTransactionReturns`
    - _Requirements: 12_

  - [ ] 12.4 Write integration tests for returns service
    - Partial return, full return, return window exceeded without auth (403), return window exceeded with manager auth (200), quantity overflow (422), double-return prevention (422), store credit issued correctly
    - _Requirements: 12_

  **Definition of Done:**
  - Return window enforced; manager auth recorded in audit log
  - Inventory incremented on return
  - Store credit balance updated atomically with refund record
  - Double-return and quantity overflow prevented

---

- [ ] 13. Manage Customer Orders (Create, Confirm, Fulfill, Cancel)
  > Multi-channel order management with stock reservation. Pessimistic locking on confirmation.
  > _Slice 13 = Requirement 13 | Design: design.md §3.14, §4.2, §5.1_
  > _Concurrency: SELECT FOR UPDATE on inventory rows during confirmation_

  - [ ] 13.1 Create DB migration: orders, order_line_items
    - `orders (id BIGSERIAL PK, order_number TEXT UNIQUE NOT NULL, customer_id INTEGER REFERENCES customers(id), branch_id INTEGER REFERENCES branches(id), location_id INTEGER REFERENCES locations(id), channel TEXT NOT NULL CHECK (channel IN ('in_store','phone','online')), status TEXT DEFAULT 'Pending' CHECK (status IN ('Pending','Confirmed','In_Progress','Fulfilled','Cancelled')), tax_rate NUMERIC(6,4) NOT NULL, subtotal NUMERIC(14,2), tax_amount NUMERIC(14,2), total NUMERIC(14,2), cancel_reason TEXT, created_by INTEGER NOT NULL, created_at TIMESTAMPTZ DEFAULT now())`
    - Indexes: `(customer_id, status)`, `(branch_id, status)`, `created_at`
    - `order_line_items (id BIGSERIAL PK, order_id BIGINT REFERENCES orders(id), book_id INTEGER REFERENCES books(id), quantity INTEGER NOT NULL CHECK (quantity > 0), unit_price NUMERIC(14,2) NOT NULL, qty_reserved INTEGER NOT NULL DEFAULT 0, is_backordered BOOLEAN DEFAULT false)` + index on `order_id`
    - _Requirements: 13_

  - [ ] 13.2 Implement orders.service.ts
    - `create(data, staffCtx)` — validate customer/branch is_active; validate books is_active; get effective prices + tax rate; generate unique order_number; INSERT orders + order_line_items; INSERT audit_logs
    - `confirm(orderId, staffCtx)` — BEGIN; SELECT inventory FOR UPDATE for all line items; for each line: if quantity >= requested: UPDATE inventory SET qty_reserved += qty; else: set is_backordered=true; UPDATE orders status='Confirmed'; INSERT audit_logs; COMMIT
    - `progress(orderId, staffCtx)` — validate status='Confirmed'; UPDATE status='In_Progress'; INSERT audit_logs
    - `fulfill(orderId, staffCtx)` — BEGIN REPEATABLE READ; SELECT inventory FOR UPDATE; UPDATE inventory SET quantity -= qty_reserved, version=version+1 WHERE version=$v (409 VERSION_CONFLICT on 0 rows); set qty_reserved=0; INSERT inventory_history (SALE); UPDATE orders status='Fulfilled'; INSERT audit_logs; COMMIT
    - `cancel(orderId, reason, staffCtx)` — validate status NOT 'Fulfilled' (409 ORDER_ALREADY_FULFILLED); release qty_reserved; UPDATE status='Cancelled', cancel_reason=$reason; INSERT audit_logs
    - _Requirements: 13.1–13.9_

  - [ ] 13.3 Implement order API routes + UI
    - `GET/POST /api/orders`, `GET /api/orders/:id`, `POST /api/orders/:id/confirm|progress|fulfill|cancel`
    - Order list: DataTable with order_number, customer, channel, status badge, total; filter by status/channel/branch
    - Order detail: line items with qty_reserved + is_backordered indicators; status action buttons; cancel reason input
    - Create order form: customer search, branch/location selects, channel select, line item builder
    - TanStack Query hooks: `useOrderList`, `useOrder`, `useCreateOrder`, `useConfirmOrder`, `useProgressOrder`, `useFulfillOrder`, `useCancelOrder`
    - _Requirements: 13_

  - [ ] 13.4 Write integration tests for orders service
    - Full lifecycle: create → confirm (stock reserved) → progress → fulfill (inventory decremented); cancel from each state; backorder set when stock unavailable; state machine violations (409)
    - _Requirements: 13_

  - [ ]* 13.5 Write property-based tests for orders (Properties 38–40)
    - **Property 38:** Order confirmation reserves stock; available (unreserved) stock reduced — `Validates: Req 13.3`
    - **Property 39:** Order status transitions follow allowed paths only — `Validates: Req 13.6`
    - **Property 40:** Order cancellation releases reserved inventory — `Validates: Req 13.7`

  **Definition of Done:**
  - Stock reservation uses SELECT FOR UPDATE (no overselling)
  - State machine enforced; invalid transitions return 409
  - Cancellation releases reserved inventory atomically
  - Backorder flag set when stock unavailable

---

- [ ] 14. Accept Payments and Installment Plans for Orders
  > Flexible payment collection with split payments, installment plans, and partial refunds. Most financially critical module.
  > _Slice 14 = Requirement 14 | Design: design.md §3.14, §5.2, §7.1, §7.2_
  > _Concurrency: SELECT FOR UPDATE on order row during payment recording_

  - [ ] 14.1 Create DB migration: order_payments, order_refunds, installment_plans, installments
    - `order_payments (id BIGSERIAL PK, order_id BIGINT REFERENCES orders(id), method TEXT NOT NULL CHECK (method IN ('cash','credit_card','debit_card','store_credit','loyalty_points','bank_transfer')), amount NUMERIC(14,2) NOT NULL CHECK (amount > 0), bank_account_id INTEGER REFERENCES bank_accounts(id), staff_id INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now())` + index on `order_id`
    - `order_refunds (id BIGSERIAL PK, order_id BIGINT REFERENCES orders(id), payment_id BIGINT REFERENCES order_payments(id), amount NUMERIC(14,2) NOT NULL CHECK (amount > 0), method TEXT NOT NULL, bank_account_id INTEGER REFERENCES bank_accounts(id), reason TEXT NOT NULL, staff_id INTEGER NOT NULL, created_at TIMESTAMPTZ DEFAULT now())` + index on `order_id`
    - `installment_plans (id SERIAL PK, order_id BIGINT REFERENCES orders(id) UNIQUE, deposit_amount NUMERIC(14,2) NOT NULL, total_amount NUMERIC(14,2) NOT NULL, created_by INTEGER NOT NULL, created_at TIMESTAMPTZ DEFAULT now())`
    - `installments (id SERIAL PK, plan_id INTEGER REFERENCES installment_plans(id), due_date DATE NOT NULL, amount NUMERIC(14,2) NOT NULL, paid_amount NUMERIC(14,2) NOT NULL DEFAULT 0, status TEXT DEFAULT 'pending' CHECK (status IN ('pending','partial','paid','overdue')))` + indexes on `plan_id`, `(due_date, status)`
    - _Requirements: 14_

  - [ ] 14.2 Implement payments.service.ts
    - `recordPayment(orderId, method, amount, bankAccountId, staffCtx)` — BEGIN; SELECT orders FOR UPDATE; compute outstanding = total - SUM(payments) + SUM(refunds); if amount > outstanding: 422 EXCEEDS_OUTSTANDING_BALANCE; validate method in config.getAllowedPaymentMethods(branchId) (422 PAYMENT_METHOD_NOT_ALLOWED); validate bank_account_id for bank_transfer; INSERT order_payments; INSERT audit_logs; COMMIT
    - `createInstallmentPlan(orderId, depositAmount, installments, staffCtx)` — validate depositAmount >= order.total × config.getMinDepositPct(branchId)/100 (422 DEPOSIT_BELOW_MINIMUM); validate installments.length <= config.getMaxInstallments() (422 EXCEEDS_MAX_INSTALLMENTS); validate SUM(installments.amount) = order.total - depositAmount (422 INSTALLMENT_SUM_MISMATCH); INSERT installment_plans + installments (status='pending'); INSERT audit_logs
    - `recordRefund(orderId, paymentId, amount, method, bankAccountId, reason, staffCtx)` — validate amount <= order_payments.amount (422 EXCEEDS_PAYMENT_AMOUNT); INSERT order_refunds; if method='store_credit': adjustStoreCredit; INSERT audit_logs
    - `getBalance(orderId)` — SELECT order.total - SUM(payments) + SUM(refunds)
    - _Requirements: 14.1–14.11_

  - [ ] 14.3 Implement payment API routes + UI
    - `GET/POST /api/orders/:id/payments`, `POST /api/orders/:id/installment-plan`, `GET /api/orders/:id/installment-plan`, `POST /api/orders/:id/refunds`, `GET /api/orders/:id/balance`
    - Payment panel on order detail: outstanding balance, add payment form, payment history list
    - Installment plan builder: deposit amount input (shows min required), installment rows (due_date + amount), sum validation indicator
    - Refund form: payment record select, amount input (max = payment amount), method select, reason
    - TanStack Query hooks: `useOrderPayments`, `useRecordPayment`, `useCreateInstallmentPlan`, `useInstallmentPlan`, `useRecordRefund`, `useOrderBalance`
    - _Requirements: 14_

  - [ ] 14.4 Write integration tests for payments service
    - Record payment, overpayment (422), installment plan validation (deposit below min, sum mismatch), partial refund (exceeds payment amount → 422), outstanding balance computed correctly, pessimistic lock prevents double-payment
    - _Requirements: 14_

  - [ ]* 14.5 Write property-based tests for payments (Properties 41–42)
    - **Property 41:** Installment plan: deposit ≥ min_pct × total; sum(installments) = total − deposit — `Validates: Req 14.3`
    - **Property 42:** Payment rejected when it would exceed outstanding balance — `Validates: Req 14.9`

  **Definition of Done:**
  - Outstanding balance never goes negative
  - Installment plan math validated on creation
  - Pessimistic lock prevents concurrent double-payment
  - Partial refund capped at original payment amount

---

- [ ] 15. Trade Books with Merchants (Exchange Orders, Settlement)
  > In-kind book trading with atomic inventory swap and trade value adjustment calculation.
  > _Slice 15 = Requirement 15 | Design: design.md §3.15, §4.5_
  > _Concurrency: REPEATABLE READ + SELECT FOR UPDATE on inventory during settlement_

  - [ ] 15.1 Create DB migration: merchants, exchange_agreements, exchange_orders, exchange_order_lines
    - `merchants (id SERIAL PK, name TEXT UNIQUE NOT NULL, contact_info JSONB NOT NULL, address TEXT NOT NULL, is_active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT now())`
    - `exchange_agreements (id SERIAL PK, merchant_id INTEGER REFERENCES merchants(id), basis TEXT NOT NULL CHECK (basis IN ('book_for_book','value_based')), terms TEXT, is_active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT now())`
    - `exchange_orders (id BIGSERIAL PK, agreement_id INTEGER REFERENCES exchange_agreements(id), branch_id INTEGER REFERENCES branches(id), src_location_id INTEGER REFERENCES locations(id), dst_location_id INTEGER REFERENCES locations(id), status TEXT DEFAULT 'Pending' CHECK (status IN ('Pending','Accepted','Settled','Cancelled')), trade_value_offered NUMERIC(14,2), trade_value_requested NUMERIC(14,2), adjustment_amount NUMERIC(14,2), adjustment_type TEXT CHECK (adjustment_type IN ('cash','store_credit')), created_by INTEGER NOT NULL, created_at TIMESTAMPTZ DEFAULT now())` + index on `(agreement_id, status)`
    - `exchange_order_lines (id BIGSERIAL PK, exchange_order_id BIGINT REFERENCES exchange_orders(id), direction TEXT NOT NULL CHECK (direction IN ('offered','requested')), book_id INTEGER REFERENCES books(id), quantity INTEGER NOT NULL CHECK (quantity > 0), trade_value NUMERIC(14,2) NOT NULL)` + index on `exchange_order_id`
    - _Requirements: 15_

  - [ ] 15.2 Implement exchange.service.ts
    - `createMerchant(data, staffCtx)` — INSERT merchants; INSERT audit_logs; 409 DUPLICATE_MERCHANT_NAME
    - `createAgreement(merchantId, data, staffCtx)` — validate merchant is_active; INSERT exchange_agreements; INSERT audit_logs
    - `createExchangeOrder(data, staffCtx)` — validate agreement is_active; validate all books is_active; compute trade_value_offered = SUM(offered lines); compute trade_value_requested = SUM(requested lines); adjustment_amount = ABS(offered - requested); if adjustment_amount > 0 AND data.adjustment_type = 'cash' AND !config.isExchangeCashAdjustmentAllowed(): 422 CASH_ADJUSTMENT_NOT_ALLOWED (must use store_credit); INSERT exchange_orders + exchange_order_lines; INSERT audit_logs
    - `accept(orderId, staffCtx)` — validate status='Pending'; UPDATE status='Accepted'; INSERT audit_logs; 409 INVALID_STATE_TRANSITION
    - `settle(orderId, staffCtx)` — BEGIN REPEATABLE READ; SELECT exchange_orders FOR UPDATE; validate status='Accepted'; SELECT inventory FOR UPDATE for all offered books at src_location; check each quantity >= line quantity (422 INSUFFICIENT_STOCK); UPDATE inventory (optimistic version check) for offered books (decrement) and requested books (increment); INSERT inventory_history (EXCHANGE_OUT, EXCHANGE_IN); UPDATE status='Settled'; INSERT audit_logs; COMMIT
    - `cancel(orderId, staffCtx)` — validate status IN ('Pending','Accepted'); UPDATE status='Cancelled'; INSERT audit_logs; 409 INVALID_STATE_TRANSITION
    - _Requirements: 15.1–15.10_

  - [ ] 15.3 Implement exchange API routes + UI
    - `GET/POST /api/merchants`, `GET/PUT /api/merchants/:id`, `GET/POST /api/merchants/:id/agreements`
    - `GET/POST /api/exchange-orders`, `GET /api/exchange-orders/:id`, `POST /api/exchange-orders/:id/accept|settle|cancel`
    - Merchant directory: DataTable with name, contact_info, is_active
    - Exchange order form: merchant + agreement select, offered/requested line builders, adjustment_amount display (auto-computed), adjustment_type select
    - Exchange order detail: status badge, offered/requested lines, trade value diff, settlement confirmation dialog
    - TanStack Query hooks: `useMerchantList`, `useExchangeOrders`, `useCreateExchangeOrder`, `useAcceptExchange`, `useSettleExchange`, `useCancelExchange`
    - _Requirements: 15_

  - [ ] 15.4 Write integration tests for exchange service
    - Create exchange order (trade value adjustment computed), accept, settle (inventory swapped atomically), settle with insufficient stock (422), cancel from Pending/Accepted, state machine violations (409)
    - _Requirements: 15_

  **Definition of Done:**
  - Trade value adjustment calculated correctly
  - Settlement is atomic — no partial inventory state
  - State machine enforced; Settled → any transition forbidden
  - Audit log entries on all state transitions

---

- [ ] P3. Phase 3 Checkpoint — Financial Flows Validated
  - Run full integration test suite; zero failures
  - Manually test: create order → confirm (stock reserved) → add installment plan → record deposit payment → fulfill order → verify inventory decremented
  - Manually test: complete POS transaction → process return → verify store credit issued + inventory restored
  - Manually test: create exchange order → accept → settle → verify inventory swapped at both locations
  - Confirm outstanding balance math is correct across all payment scenarios

---

## Phase 4 — System Hardening
> Goal: Production-ready. Add async infrastructure, observability, reporting, security hardening, and CI/CD. The system already works — this phase makes it scale and survive.

---

- [ ] 16. Generate Reports and Analytics
  > Business intelligence reports across all modules. Async generation for large datasets.
  > _Slice 16 = Requirement 16 | Design: design.md §6.8_
  > _Architecture: CQRS read path — all queries use db.replica_

  - [ ] 17.1 Add Redis to Docker Compose and implement lib/redis.ts
    - Add `redis: redis:7-alpine` service to Docker Compose with `appendonly yes`
    - Implement `lib/redis.ts` — ioredis singleton with connection error handling and reconnect strategy
    - Add `REDIS_URL` to `.env.example`
    - _Requirements: 26_

  - [ ] 17.2 Create DB migration: outbox table
    - `outbox (id BIGSERIAL PK, event_type TEXT NOT NULL, payload JSONB NOT NULL, status TEXT DEFAULT 'pending' CHECK (status IN ('pending','published','failed')), created_at TIMESTAMPTZ DEFAULT now(), published_at TIMESTAMPTZ)`
    - Index on `(status, created_at)`
    - _Requirements: 26.5_

  - [ ] 17.3 Implement lib/outbox.ts and refactor service layer to use outbox
    - `insertOutbox(client, eventType, payload)` — INSERT into outbox within caller's DB transaction
    - Refactor all service-layer audit_logs direct inserts to use outbox pattern instead: INSERT outbox within same transaction; Outbox Poller writes audit_logs asynchronously
    - Note: services that currently INSERT audit_logs directly continue to work; outbox is additive
    - _Requirements: 26.5_

  - [ ] 17.4 Implement BullMQ queue definitions and Outbox Poller worker
    - `queues/index.ts` — define queues: `notifications`, `report-generation`, `loyalty-accrual`, `audit-log-writes`, `bank-statement-import`, `dead-letter`
    - `workers/outboxPoller.ts` — every 1s: `SELECT id, event_type, payload FROM outbox WHERE status='pending' ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED`; route by event_type to BullMQ queue; UPDATE status='published'; mark 'failed' after 5 consecutive errors
    - _Requirements: 26.5_

  - [ ] 17.5 Implement Loyalty Worker (async loyalty accrual)
    - `workers/loyaltyAccrual.ts` — consumes `loyalty-accrual` queue; check if accrual already recorded for transaction_ref (idempotent); fetch `loyalty_accrual_rate` and `loyalty_min_transaction_amount` via config.service; if transaction.total < loyalty_min_transaction_amount: skip accrual; else compute `floor(transaction.total × loyalty_accrual_rate)` points; UPDATE customers.loyalty_points with optimistic locking; INSERT loyalty_history; retry 3× exp backoff; DLQ after 3 failures
    - Refactor pos.service.ts: remove synchronous loyalty update; emit `TransactionCompleted` outbox event instead
    - _Requirements: 10.6, 26.4_

  - [ ] 17.6 Implement Notification Worker and Installment Checker cron
    - `workers/notifications.ts` — consumes `notifications` queue; calls Email/SMS provider (configurable via `NOTIFICATION_PROVIDER_URL`); circuit breaker (50% error threshold, 30s reset); retry 3× exp backoff (1s, 2s, 4s); move to dead-letter after 3 failures
    - `workers/installmentChecker.ts` — daily cron at 00:00 UTC; fetch `installment_grace_period_days` from config; `UPDATE installments SET status='overdue' WHERE due_date + grace_period_days < now() AND status IN ('pending','partial') AND paid_amount < amount`; for each updated row: INSERT outbox payment reminder notification (inapp + outbound)
    - _Requirements: 14.7, 25.3, 26.3_

  - [ ] 17.7 Implement idempotency for financial endpoints
    - Create DB migration: `idempotency_keys (key TEXT PK, response_payload JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), expires_at TIMESTAMPTZ DEFAULT now() + INTERVAL '24 hours')` + index on `expires_at`
    - Implement `lib/idempotency.ts` — `withIdempotency(key, fn)`: check DB → execute → store result; return `{ result, replayed }`
    - Implement `middleware/idempotency.ts` — extract `Idempotency-Key` header; call `withIdempotency`; set `X-Idempotent-Replayed: true` header on replay
    - Apply to: `POST /api/transactions/:id/complete`, `POST /api/orders`, `POST /api/orders/:id/confirm|fulfill`, `POST /api/orders/:id/payments`, `POST /api/orders/:id/installment-plan`, `POST /api/returns`, `POST /api/exchange-orders/:id/settle`
    - Add nightly cleanup job: `DELETE FROM idempotency_keys WHERE expires_at < now()`
    - _Requirements: 20.5, 23.5_

  - [ ] 17.8 Implement Reconciliation Worker (async CSV import)
    - `workers/reconciliation.ts` — consumes `bank-statement-import` queue; processes CSV rows in single DB transaction; rolls back entire batch on any row failure; reports row-level error with row number; INSERT outbox on completion
    - Refactor bank account import endpoint: if rows > 1000, enqueue job and return `202 { jobId }`; else process synchronously
    - _Requirements: 25.5, 26.2_

  **Definition of Done:**
  - Outbox poller running; audit log entries written asynchronously
  - Loyalty accrual no longer blocks POS completion response
  - Idempotency prevents duplicate financial records on retry
  - Installment overdue status updated daily
  - Dead-letter queue visible in Admin UI

---

- [ ] H1. Add Async Infrastructure (BullMQ, Outbox Pattern, Workers)
  > Replace synchronous audit writes and loyalty accrual with guaranteed async delivery via outbox pattern.
  > _Cross-cutting hardening (deferred from Task 0A) | Requirements: 26 | Design: design.md §7_

  - [ ] H1.1 Add Redis to Docker Compose and implement lib/redis.ts
    - Add `redis: redis:7-alpine` service to Docker Compose with `appendonly yes`
    - Implement `lib/redis.ts` — ioredis singleton with connection error handling and reconnect strategy
    - Add `REDIS_URL` to `.env.example`
    - _Requirements: 26_

  - [ ] H1.2 Create DB migration: outbox table
    - `outbox (id BIGSERIAL PK, event_type TEXT NOT NULL, payload JSONB NOT NULL, status TEXT DEFAULT 'pending' CHECK (status IN ('pending','published','failed')), created_at TIMESTAMPTZ DEFAULT now(), published_at TIMESTAMPTZ)`
    - Index on `(status, created_at)`
    - _Requirements: 26.5_

  - [ ] H1.3 Implement lib/outbox.ts and refactor service layer
    - `insertOutbox(client, eventType, payload)` — INSERT into outbox within caller's DB transaction
    - Refactor all service-layer audit_logs direct inserts to use outbox pattern; Outbox Poller writes audit_logs asynchronously
    - _Requirements: 26.5_

  - [ ] H1.4 Implement BullMQ queue definitions and Outbox Poller worker
    - `queues/index.ts` — define queues: `notifications`, `report-generation`, `loyalty-accrual`, `audit-log-writes`, `bank-statement-import`, `dead-letter`
    - `workers/outboxPoller.ts` — every 1s: `SELECT ... FROM outbox WHERE status='pending' FOR UPDATE SKIP LOCKED LIMIT 100`; route by event_type to BullMQ; UPDATE status='published'; mark 'failed' after 5 errors
    - _Requirements: 26.5_

  - [ ] H1.5 Implement Loyalty Worker, Notification Worker, Installment Checker
    - `workers/loyaltyAccrual.ts` — consumes `loyalty-accrual` queue; idempotent; fetch `loyalty_accrual_rate`, `loyalty_min_transaction_amount`, and `loyalty_redemption_rate` via config.service; skip if transaction.total < min_transaction_amount; compute `floor(total × accrual_rate)` points; optimistic lock on customers; INSERT loyalty_history; retry 3× exp backoff; DLQ after 3 failures
    - `workers/notifications.ts` — consumes `notifications` queue; circuit breaker; retry 3× exp backoff; DLQ after 3 failures
    - `workers/installmentChecker.ts` — daily cron 00:00 UTC; UPDATE overdue installments; enqueue payment reminders
    - _Requirements: 10.6, 14.7, 25.3, 26.3, 26.4_

  - [ ] H1.6 Implement idempotency for financial endpoints
    - Create DB migration: `idempotency_keys (key TEXT PK, response_payload JSONB, expires_at TIMESTAMPTZ DEFAULT now() + INTERVAL '24 hours')` + index on `expires_at`
    - Implement `lib/idempotency.ts` — `withIdempotency(key, fn)`: check DB → execute → store result
    - Apply to: `POST /api/transactions/:id/complete`, `POST /api/orders`, `POST /api/orders/:id/confirm|fulfill|payments|installment-plan`, `POST /api/returns`, `POST /api/exchange-orders/:id/settle`
    - _Requirements: 20.5, 23.5_

  - [ ] H1.7 Create DB migration: in_app_notifications table
    - `in_app_notifications (id BIGSERIAL PK, staff_id INTEGER NOT NULL, notification_type TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, entity_type TEXT, entity_id TEXT, is_read BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT now())`
    - Index on `(staff_id, is_read, created_at DESC)`
    - No FK on `staff_id` — notifications retained after staff deactivation
    - _Requirements: 27.1_

  - [ ] H1.8 Implement lib/sseRegistry.ts and SSE endpoint
    - `lib/sseRegistry.ts` — in-memory `Map<staffId, Set<Response>>`; `register(staffId, res)` adds client and auto-removes on `res.on('close')`; `push(staffId, event)` writes `data: {json}\n\n` to all active connections for that staff
    - `routes/notifications.ts` — `GET /api/notifications/stream`: set headers (`Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`); call `sseRegistry.register(staffId, res)`; send heartbeat `": ping\n\n"` every 30s via `setInterval`; clear interval on close
    - `GET /api/notifications` — paginated list of `in_app_notifications` for authenticated staff; filter by `?isRead=false`
    - `PUT /api/notifications/:id/read` — UPDATE `is_read = true` WHERE `id=$1 AND staff_id=$staffId`
    - `PUT /api/notifications/read-all` — UPDATE `is_read = true` WHERE `staff_id=$staffId AND is_read = false`
    - _Requirements: 27.2, 27.4, 27.5_

  - [ ] H1.9 Implement InApp Notification Worker and Redis pub/sub for horizontal scaling
    - `workers/inAppNotifications.ts` — consumes `inapp-notifications` queue; INSERT into `in_app_notifications`; publish to Redis pub/sub channel `inapp:{staffId}` with the notification payload
    - Update `lib/sseRegistry.ts` — subscribe to Redis `inapp:{staffId}` on each API server instance; on message received: call `sseRegistry.push(staffId, payload)` to push to local SSE connections
    - This ensures SSE push works correctly when API servers are horizontally scaled (staff may be connected to a different instance than the one processing the job)
    - _Requirements: 27.2, 27.6, 27.7_

  - [ ] H1.10 Update Outbox Poller to route inapp events to inapp-notifications queue
    - Add routing rules for: `POApprovalRequired`, `ReturnAuthRequired`, `OverReceiptConfirmRequired`, `ReportReady`, `ReportFailed`, `InstallmentOverdue`, `OrderStatusChanged`, `ExchangeSettled`, `InventoryAdjusted`, `ReconciliationImportCompleted`
    - Each event routes to `inapp-notifications` queue (and optionally `notifications` for outbound email/SMS where applicable)
    - _Requirements: 27.3_

  - [ ] H1.11 Implement React SSE client hook and notification bell UI
    - `hooks/useNotifications.ts` — opens `EventSource('/api/notifications/stream')`; on message: appends to local notification list; auto-reconnects on error with exponential backoff
    - Notification bell component: badge showing unread count; dropdown listing recent notifications; click navigates to referenced entity; mark-as-read on click; mark-all-read button
    - _Requirements: 27.2, 27.4_

  - [ ] H1.12 Write integration tests for SSE notification flow
    - Test: InApp worker inserts notification row + pushes to SSE stream
    - Test: `GET /api/notifications` returns unread notifications
    - Test: `PUT /api/notifications/:id/read` marks as read
    - Test: SSE heartbeat sent every 30s
    - Test: disconnected client does not block notification delivery
    - _Requirements: 27_

  **Definition of Done:**
  - Outbox poller running; audit log entries written asynchronously
  - Loyalty accrual no longer blocks POS completion response
  - Idempotency prevents duplicate financial records on retry
  - Dead-letter queue visible in Admin UI
  - SSE stream delivers in-app notifications in real time
  - Notifications persisted in DB and retrievable on reconnect
  - Notification bell shows unread count; mark-as-read works

---

- [ ] H2. Add Rate Limiting, CSRF, and Security Hardening
  > Harden the API against abuse. Redis-backed rate limiting and CSRF protection.
  > _Cross-cutting hardening (deferred from Task 0A) | Requirements: 21 | Design: design.md §8_

  - [ ] H2.1 Implement Redis-backed rate limiting middleware
    - `middleware/rateLimit.ts` — login: `INCR rl:login:{ip}` + `EXPIRE 900`; if count > 10: 429 with `Retry-After`; API: `INCR rl:api:{staffId}` + `EXPIRE 60`; if count > 200: 429
    - _Requirements: 21.7, 21.8_

  - [ ] H2.2 Implement CSRF protection
    - `middleware/csrf.ts` — set `csrf-token` cookie on login; validate `X-CSRF-Token` header on mutating requests; 403 CSRF_INVALID on mismatch
    - Update React client to read cookie and send as `X-CSRF-Token` header
    - _Requirements: 21.9_

  - [ ] H2.3 Implement HMAC audit log signing
    - `lib/hmac.ts` — HMAC-SHA256 over `id|staffId|action|entityType|entityId|createdAt` using `AUDIT_SIGNING_KEY` env var
    - Add `hmac_signature TEXT` column to audit_logs; compute on each entry
    - `GET /api/audit-logs/:id/verify` — Admin only; recompute and compare; return `{ valid: boolean }`
    - _Requirements: 21.12_

  - [ ] H2.4 Add Redis token revocation cache
    - On deactivation: `SET rt:revoked:{staffId} true EX 604800`; check on every token refresh
    - _Requirements: 21.6_

  **Definition of Done:**
  - Login rate limit enforced; CSRF validated on all mutating requests
  - Audit log HMAC signatures computed and verifiable
  - Token revocation fast path via Redis

---

- [ ] H3. Add Observability (Structured Logging, Metrics, Tracing)
  > Production-grade observability. Replace console logging with Pino; add Prometheus metrics and OpenTelemetry tracing.
  > _Cross-cutting hardening (deferred from Task 0A) | Requirements: 22 | Design: design.md §9_

  - [ ] H3.1 Replace console logging with Pino structured logging
    - Install Pino; JSON format with `AsyncLocalStorage` request ID + trace ID propagation; PII masking
    - _Requirements: 22.1_

  - [ ] H3.2 Add Prometheus metrics endpoint
    - Install prom-client; expose `GET /metrics`; key metrics: request duration, request count, queue depth, active sessions, version conflicts, idempotency replays
    - Add Prometheus + Grafana to Docker Compose
    - _Requirements: 22.3_

  - [ ] H3.3 Add OpenTelemetry distributed tracing
    - `@opentelemetry/sdk-node` with auto-instrumentation for express, pg, ioredis; OTLP HTTP exporter
    - _Requirements: 22.4_

  - [ ] H3.4 Update GET /health to check all services
    - Check: primary DB, read replica, Redis, BullMQ queues; return `{ status, db: { primary, replica }, redis, queues }`
    - _Requirements: 22.2_

  - [ ] H3.5 Configure Prometheus alerting rules
    - HighP95Latency (>1s for 5min), HighErrorRate (>1% for 5min), QueueDepthHigh (>1000 for 1min)
    - _Requirements: 22.5, 22.6, 22.7_

  **Definition of Done:**
  - Every request produces structured JSON log with requestId, staffId, branchId, durationMs
  - `GET /metrics` returns Prometheus-compatible metrics; `GET /health` reflects real service status

---

- [ ] H4. Add Nginx, PgBouncer, and CI/CD Pipeline
  > Production deployment hardening. Nginx as reverse proxy, PgBouncer for connection pooling, automated CI/CD.
  > _Cross-cutting hardening (deferred from Task 0A) | Requirements: 19, 20, 21.1 | Design: design.md §10_

  - [ ] H4.1 Add Nginx reverse proxy to Docker Compose
    - `nginx.conf` — TLS 1.2/1.3, `least_conn` upstream, rate limit zones, SPA static file serving
    - _Requirements: 21.1_

  - [ ] H4.2 Add PgBouncer connection pooling
    - Transaction-mode pooling (200 client → 20 PG connections); update `DATABASE_URL` to point to PgBouncer
    - _Requirements: 19_

  - [ ] H4.3 Add table partitioning for transactions and audit_logs
    - Convert `transactions` and `audit_logs` to `PARTITION BY RANGE (created_at)` (migration + data migration)
    - Add partition creation script: runs on 25th of each month
    - _Requirements: 24.5_

  - [ ] H4.4 Set up CI/CD pipeline
    - `.github/workflows/ci.yml` — type-check → lint → unit tests → integration tests → build → push → deploy
    - Run migrations before starting new containers in deploy step
    - _Requirements: 20_

  **Definition of Done:**
  - Nginx serves React SPA and proxies API; PgBouncer handles connection pooling
  - Monthly partitions created automatically; CI pipeline runs on every push

---

- [ ] P4. Final System Validation Checkpoint
  - Run complete integration test suite across all phases; zero failures
  - Run property-based tests (all optional tests); review any failures
  - Load test: simulate 20 concurrent POS completions; verify no inventory corruption, all version conflicts handled correctly
  - Verify: audit log HMAC signatures valid on all entries
  - Verify: idempotency prevents duplicate records on retry
  - Verify: outbox poller delivers all pending events within 5 seconds
  - Verify: dashboard KPIs match direct DB queries
  - Verify: Nginx rate limiting blocks >10 failed logins per IP
  - Confirm all 54 correctness properties from design.md §13 are covered by tests

---

## Notes

**Task format:**
- `- [ ]` not started
- `- [-]` in progress
- `- [x]` completed
- `- [~]` queued
- `- [ ]*` optional task

**Concurrency reminders (implement exactly as specified):**
- Inventory mutations: optimistic locking (version counter) — Tasks 7, 9, 11, 13, 15
- Order stock reservation: pessimistic locking (SELECT FOR UPDATE) — Task 13
- Payment recording: pessimistic locking (SELECT FOR UPDATE on order row) — Task 14
- POS completion: REPEATABLE READ isolation — Task 11
- Outbox polling: SELECT FOR UPDATE SKIP LOCKED — Task H1

**Financial invariants (never violate):**
- SUM(transaction_payments.amount) = transaction.total exactly
- outstanding_balance = order.total - SUM(payments) + SUM(refunds) ≥ 0
- store_credit ≥ 0 at all times
- loyalty_points ≥ 0 at all times
- refund.amount ≤ original payment.amount per record

**Seed data strategy:**
- Each task includes seed data for immediate developer testing
- Seed script at `apps/api/src/db/seed.ts`; run with `npm run seed`
- Seed creates: 1 Super_Admin, 1 Admin, 1 Manager, 1 Finance_Officer, 1 Stock_Clerk, 1 Sales, 1 Purchasor staff; 2 branches; 2 locations per branch; 10 books; 3 suppliers; 5 customers
