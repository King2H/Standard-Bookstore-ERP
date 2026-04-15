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

- [x] 5. Manage Locations (Create, Rename, Assign Default Fulfillment)
  > Define stock areas within each branch. Required before inventory can be tracked.
  > _Slice 5 = Requirement 5 | Design: design.md §3.7_

  - [x] 5.1 Create DB migration: locations
    - `locations (id SERIAL PK, branch_id INTEGER REFERENCES branches(id), name TEXT NOT NULL, is_default_fulfillment BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT now(), UNIQUE (branch_id, name))`
    - Index on `branch_id`
    - Seed: insert one default location per seeded branch
    - _Requirements: 5_

  - [x] 5.2 Implement location.service.ts
    - `create(branchId, name, staffCtx)` — validate branch is_active; INSERT locations; INSERT audit_logs; 409 DUPLICATE_LOCATION_NAME on unique violation
    - `rename(id, name, staffCtx)` — UPDATE locations.name; INSERT audit_logs; 409 on duplicate name within branch
    - `setDefault(id, staffCtx)` — BEGIN; UPDATE locations SET is_default_fulfillment=false WHERE branch_id=$branchId; UPDATE SET is_default_fulfillment=true WHERE id=$id; INSERT audit_logs; COMMIT
    - `delete(id, staffCtx)` — check inventory.quantity > 0 or open orders assigned; 409 DEPENDENCY_CONFLICT; DELETE + INSERT audit_logs if clear
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

  - [x] 5.3 Implement location API routes
    - `GET /api/branches/:branchId/locations` — any authenticated
    - `POST /api/branches/:branchId/locations` — Admin/Manager; 403 for other roles
    - `PUT /api/branches/:branchId/locations/:id` — Admin/Manager; rename
    - `DELETE /api/branches/:branchId/locations/:id` — Admin/Manager; 409 DEPENDENCY_CONFLICT
    - `PUT /api/branches/:branchId/locations/:id/set-default` — Admin/Manager
    - _Requirements: 5.7_

  - [x] 5.4 Implement Location list UI per branch
    - Location list: table with name, is_default_fulfillment badge, inventory count; inline rename; set-default button; delete with dependency guard
    - TanStack Query hooks: `useLocations`, `useCreateLocation`, `useRenameLocation`, `useSetDefaultLocation`, `useDeleteLocation`
    - _Requirements: 5_

  - [x] 5.5 Write integration tests for location service
    - Create location, duplicate name (409), rename, set default (clears previous default), delete with inventory (409), delete clean location
    - _Requirements: 5_

  **Definition of Done:**
  - Locations CRUD working per branch
  - Only one default fulfillment location per branch at any time
  - Delete blocked when inventory exists
  - Audit log entries created on all writes

---

- [x] 6. Build the Book Catalog (Create, Search, Price Overrides)
  > Master catalog of all books. Required before inventory, POS, or orders can reference books.
  > _Slice 6 = Requirement 6 | Design: design.md §3.8_

  - [x] 6.1 Create DB migration: books, book_branch_prices, book_categories, book_tags, book_edit_history
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

  - [x] 3.3 Implement catalog API routes
    - `GET /api/books` — any authenticated; paginated; `?q`, `isbn`, `genre`, `category`, `tag`, `is_active`, `branchId`, `sortBy`, `sortDir`
    - `POST /api/books` — Admin/Manager; 409 DUPLICATE_ISBN; 403 for other roles
    - `GET /api/books/:id` — any authenticated; includes categories, tags, branch prices
    - `PUT /api/books/:id` — Admin/Manager
    - `POST /api/books/:id/deactivate` — Admin/Manager
    - `GET /api/books/:id/history` — Admin/Manager; paginated edit history
    - `GET /api/books/:id/prices` — any authenticated
    - `PUT /api/books/:id/prices/:branchId` — Admin/Manager
    - _Requirements: 6.10_

  - [x] 6.2 Implement catalog.service.ts
    - `create(data, staffCtx)` — validate ISBN-13 check digit (mod-10 algorithm); INSERT books + categories + tags; INSERT audit_logs; 409 DUPLICATE_ISBN
    - `update(id, data, staffCtx)` — diff changed bibliographic fields; INSERT book_edit_history row per changed field; UPDATE books; INSERT audit_logs
    - `deactivate(id, staffCtx)` — UPDATE books SET is_active=false; INSERT audit_logs
    - `setBranchPrice(bookId, branchId, price, staffCtx)` — UPSERT book_branch_prices; INSERT audit_logs
    - `search(query, filters, page)` — full-text via `search_vector @@ to_tsquery` for title/author; exact match for ISBN; filter by genre/category/tag/is_active; paginated
    - `getEffectivePrice(bookId, branchId)` — SELECT from book_branch_prices; fallback to books.default_price
    - _Requirements: 6.1–6.9_

  - [x] 6.3 Implement catalog API routes
    - `GET /api/books` — any authenticated; paginated; `?q`, `isbn`, `genre`, `category`, `tag`, `is_active`, `branchId`, `sortBy`, `sortDir`
    - `POST /api/books` — Admin/Manager; 409 DUPLICATE_ISBN; 403 for other roles
    - `GET /api/books/:id` — any authenticated; includes categories, tags, branch prices
    - `PUT /api/books/:id` — Admin/Manager
    - `POST /api/books/:id/deactivate` — Admin/Manager
    - `GET /api/books/:id/history` — Admin/Manager; paginated edit history
    - `GET /api/books/:id/prices` — any authenticated
    - `PUT /api/books/:id/prices/:branchId` — Admin/Manager
    - _Requirements: 6.10_

  - [x] 6.4 Implement Book list, Detail, and Edit UI
    - Book list: DataTable with isbn, title, authors, genre, default_price, is_active; full-text search input; filter panel
    - Book detail: all fields + categories/tags + branch price overrides table + edit history timeline
    - Create/Edit form: all bibliographic fields + category/tag multi-input
    - TanStack Query hooks: `useBookList`, `useBook`, `useCreateBook`, `useUpdateBook`, `useDeactivateBook`, `useBookHistory`, `useSetBranchPrice`
    - _Requirements: 6_

  - [x] 6.5 Write integration tests for catalog service
    - Create book, duplicate ISBN (409), update (edit history created), deactivate (rejected from new PO), full-text search returns correct results, branch price override takes precedence
    - _Requirements: 6_

  - [x] 6.6 Implement master data architecture (Authors, Categories, Publishers)
    - Migration `1700000011_master_data`: `publishers` table, `publisher_id` FK on books, `parent_id` on categories for hierarchy
    - `authors`, `categories`, `publishers` as independent CRUD entities with book-count reporting
    - Books reference master data by ID; backward-compat name-based upsert retained
    - API: `GET/POST /api/authors`, `PUT/DELETE /api/authors/:id`, same for `/categories` and `/publishers`
    - Catalog sub-navigation: Books | Authors | Categories | Publishers tabs
    - _Requirements: 6_

  - [x] 6.7 Implement book format and edition structured fields
    - Migration `1700000012_book_format_edition`: `book_formats` table (softcover, hardcover, leather_bound, cloth_bound, traditional_orthodox), `book_editions` table (first_edition, revised_edition, student_edition, annotated, special_religious)
    - Migration `1700000013_fix_price_pk`: `format_id` + `edition_id` on `books` (nullable FK); `book_branch_prices` PK extended to `(book_id, branch_id, format_id, edition_id)` with `NOT NULL DEFAULT 0` sentinel
    - Format and edition required on book creation; pricing can vary per format/edition/branch combination
    - API: `GET /api/book-formats`, `GET /api/book-editions`
    - Book form: Physical tab with enum dropdowns for format and edition; validation enforced before save
    - _Requirements: 6_

  - [x] 6.8 Production-grade Catalog UI
    - Compact single-row toolbar: KPI chips + debounced search + Category/Author/Genre/Status dropdowns
    - All filters wired to backend API and synced to URL query params (shareable state)
    - Sortable columns (Title, ISBN, Price, Added), bulk select + activate/deactivate
    - Row action menu: smart up/down positioning based on viewport space; `opacity-40` at rest for operational visibility
    - Tabbed create/edit drawer: Basic Info | Physical (format + edition) | Authors | Categories | Pricing
    - RBAC: Super_Admin excluded from operational catalog writes (Admin/Manager only)
    - _Requirements: 6_

  **Definition of Done:**
  - ISBN-13 check digit validated on create (optional ISBN, SKU as fallback)
  - Full-text search returns relevant results
  - Edit history entry created for each changed field
  - Format + edition required; pricing supports format/edition/branch variation
  - Master data (authors, categories, publishers) managed independently
  - All filters functional and URL-synced
  - 104 integration tests passing (9 test files)

---

- [x] 7. Track Inventory (Adjust Stock, Transfer Between Locations)
  > Stock levels per book per location. The most concurrency-critical module — optimistic locking implemented here.
  > _Slice 7 = Requirement 7 | Design: design.md §3.9, §5.1, §5.2_
  > _Concurrency: Optimistic locking (version counter) on all inventory mutations — see design.md §5.1_

  - [x] 7.1 Create DB migration: inventory and inventory_history
    - `inventory (book_id, location_id, quantity, reorder_point, version, updated_at)` — PK (book_id, location_id), CHECK quantity >= 0
    - Partial index: `WHERE quantity <= reorder_point` for low-stock queries
    - `inventory_history` — partitioned by RANGE (created_at); 4 initial monthly partitions
    - reason_code: damage | loss | return | correction | transfer_in | transfer_out | initial
    - Seed: initialize inventory rows for all active books × all locations (quantity=0)
    - _Requirements: 7, 24.6_

  - [x] 7.2 Implement inventory.service.ts
    - `initializeInventory(bookId, locationId)` — INSERT ON CONFLICT DO NOTHING
    - `adjustStock(opts)` — validates reason code; checks negative stock policy; optimistic lock via version; INSERT inventory_history; INSERT audit_logs; 409 VERSION_CONFLICT, 422 INSUFFICIENT_STOCK
    - `transferStock(opts)` — REPEATABLE READ + FOR UPDATE; atomic source decrement + destination increment; dual history rows (transfer_out + transfer_in); 409 VERSION_CONFLICT, 422 INSUFFICIENT_STOCK
    - `getLowStock(branchId)` — SELECT via partial index WHERE quantity <= reorder_point
    - `getInventoryHistory(opts)` — paginated; filter by book, location, reasonCode, date range
    - `setReorderPoint(bookId, locationId, reorderPoint, staffCtx)` — UPDATE + audit log
    - _Requirements: 7.1–7.8_

  - [x] 7.3 Implement inventory API routes
    - `GET /api/inventory` — any authenticated; paginated; `?q`, `locationId`, `bookId`, `lowStockOnly`
    - `GET /api/inventory/low-stock` — any authenticated; returns all items at/below reorder point
    - `GET /api/inventory/history` — any authenticated; paginated; filter by book/location/reason/date
    - `POST /api/inventory/adjust` — Admin/Manager/Stock_Clerk; 409 VERSION_CONFLICT, 422 INSUFFICIENT_STOCK
    - `POST /api/inventory/transfer` — Admin/Manager/Stock_Clerk; atomic; 409/422
    - `PUT /api/inventory/reorder-point` — Admin/Manager only
    - `POST /api/inventory/initialize` — Admin/Manager; idempotent
    - _Requirements: 7.9_

  - [x] 7.4 Implement Inventory UI (5 sub-pages)
    - **Stock Levels**: table with book, location, qty, reorder point, low-stock badge, inline reorder-point edit
    - **Adjust**: split-panel — book/location selector + adjustment form (delta, reason, notes, version)
    - **Transfer**: split-panel — source selector + transfer form (destination, quantity)
    - **History**: paginated log with reason/date filters; color-coded delta (+/-)
    - **Low Stock Alerts**: dedicated dashboard with deficit column; auto-refreshes every 60s; badge on tab
    - RBAC: Sales/Finance_Officer read-only; Stock_Clerk can adjust/transfer; Admin/Manager full access
    - _Requirements: 7_

  - [x] 7.5 Write integration tests for inventory service
    - List inventory, filter by locationId, unauthenticated 401
    - Adjust: success (correction), Stock_Clerk can adjust, Sales 403, VERSION_CONFLICT 409, invalid reason 400, zero delta 400
    - Transfer: success (atomic, both locations updated), insufficient stock 422, VERSION_CONFLICT 409
    - Low-stock endpoint returns items at/below reorder point
    - History endpoint with reasonCode filter
    - Reorder point: Admin can update, Stock_Clerk 403
    - Audit log entry created on adjust
    - 17 tests — all passing
    - _Requirements: 7_

  - [x] 7.6 Introduce Stock In / Stock Out as first-class operations
    - Migration `1700000015_inventory_movement_type`: adds `movement_type` CHECK constraint, `reference_type`, `reference_id` to `inventory_history`; backfills existing rows; index on `movement_type`
    - `stockIn()` — always positive; writes `movement_type='stock_in'`; accepts `referenceType`/`referenceId`; optimistic locking
    - `stockOut()` — enforces negative-stock policy; writes `movement_type='stock_out'`; accepts `referenceType`/`referenceId`; optimistic locking
    - `adjustStock()` unchanged — now writes `movement_type='adjustment'` (corrections only)
    - `transferStock()` unchanged — now writes `movement_type='transfer_in'`/`'transfer_out'`
    - `getInventoryHistory()` — new `movementType` filter parameter
    - API: `POST /api/inventory/stock-in` (Manager, Stock_Clerk), `POST /api/inventory/stock-out` (Manager, Stock_Clerk, Sales)
    - History API: `?movementType=` filter added
    - UI: Stock In tab (split-panel, reference type/ID, notes), Stock Out tab (real-time stock validation warning)
    - Stock Levels: quick `+ In` / `− Out` action buttons per row
    - History tab: `movementType` dropdown filter + color-coded `MovementBadge`
    - Future hooks: Procurement → `stockIn()`, POS/Orders → `stockOut()`, Returns → `stockIn()`
    - 12 new tests (29 inventory total, 133 total across 10 test files)
    - _Requirements: 7_

  **Definition of Done:**
  - Stock In / Stock Out available as explicit first-class operations
  - Adjust remains for admin corrections only (damage, loss, return, correction)
  - Inventory history clearly distinguishes all 5 movement types
  - Optimistic locking prevents concurrent quantity corruption (409 VERSION_CONFLICT)
  - Transfer is atomic — no partial state possible (REPEATABLE READ + FOR UPDATE)
  - All 133 integration tests passing (10 test files)

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

- [ ] 8. Manage Suppliers (Register, Link to Publishers, Map to Books, Validate for Procurement)
  > Supplier registry with unified party model. Supports external vendors and publisher-as-supplier. Books can map to multiple suppliers. Stock In supports flexible reference types. Required before purchase orders can be created.
  > _Slice 8 = Requirement 8 | Design: design.md §3.10_

  - [x] 8.1 Create DB migration: suppliers with unified party model
    - `suppliers (id SERIAL PK, name TEXT UNIQUE NOT NULL, contact_info JSONB NOT NULL, lead_time_days INTEGER NOT NULL DEFAULT 7, pricing_terms TEXT, supplier_type TEXT NOT NULL DEFAULT 'external' CHECK (supplier_type IN ('external','publisher')), publisher_id INTEGER REFERENCES publishers(id), is_active BOOLEAN DEFAULT true, is_blacklisted BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT now())`
    - CHECK constraints: `publisher_supplier_requires_publisher_id` (supplier_type='publisher' → publisher_id NOT NULL), `external_supplier_no_publisher_id` (supplier_type='external' → publisher_id IS NULL)
    - `book_suppliers (book_id INTEGER REFERENCES books(id), supplier_id INTEGER REFERENCES suppliers(id), supplier_sku TEXT, is_primary BOOLEAN DEFAULT false, PRIMARY KEY (book_id, supplier_id))`
    - Indexes: `(supplier_id)` on book_suppliers, partial `(book_id, is_primary) WHERE is_primary = true`
    - Seed: insert 2–3 sample suppliers (mix of external and publisher-linked)
    - _Requirements: 8.1, 8.2, 8.9, 8.14_

  - [x] 8.2 Implement supplier.service.ts
    - `create(data, staffCtx)` — validate supplier_type rules (publisher_id required/forbidden); INSERT suppliers; INSERT audit_logs; 409 DUPLICATE_SUPPLIER_NAME
    - `update(id, data, staffCtx)` — re-validate supplier_type rules on update; UPDATE suppliers; INSERT audit_logs (does not affect existing POs)
    - `deactivate(id, staffCtx)` — UPDATE is_active=false; INSERT audit_logs
    - `blacklist(id, staffCtx)` — UPDATE is_blacklisted=true; INSERT audit_logs; Admin/Manager only
    - `delete(id, staffCtx)` — check for associated POs; 409 DEPENDENCY_CONFLICT if any; DELETE + INSERT audit_logs if clear
    - `getSuppliersForBook(bookId)` — SELECT from book_suppliers JOIN suppliers; ORDER BY is_primary DESC
    - `validateSupplierForProcurement(supplierId)` — 422 SUPPLIER_INACTIVE if is_active=false; 422 SUPPLIER_BLACKLISTED if is_blacklisted=true
    - `linkBookToSupplier(bookId, supplierId, supplierSku, isPrimary, staffCtx)` — UPSERT book_suppliers; if isPrimary=true: UPDATE book_suppliers SET is_primary=false WHERE book_id=$bookId AND supplier_id != $supplierId; INSERT audit_logs
    - `unlinkBookFromSupplier(bookId, supplierId, staffCtx)` — DELETE from book_suppliers; INSERT audit_logs
    - _Requirements: 8.1–8.14_

  - [x] 8.3 Implement supplier API routes
    - `GET /api/suppliers` — Admin/Manager/Purchasor; paginated; filter by supplier_type, is_active, is_blacklisted
    - `POST /api/suppliers` — Admin/Manager/Purchasor; validates supplier_type rules; 409 DUPLICATE_SUPPLIER_NAME
    - `GET /api/suppliers/:id` — Admin/Manager/Purchasor
    - `PUT /api/suppliers/:id` — Admin/Manager/Purchasor
    - `POST /api/suppliers/:id/deactivate` — Admin/Manager/Purchasor
    - `POST /api/suppliers/:id/blacklist` — Admin/Manager only
    - `DELETE /api/suppliers/:id` — Admin/Manager; 409 DEPENDENCY_CONFLICT
    - `GET /api/books/:bookId/suppliers` — any authenticated; returns linked suppliers sorted by is_primary
    - `POST /api/books/:bookId/suppliers` — Admin/Manager; body: `{ supplierId, supplierSku?, isPrimary? }`
    - `DELETE /api/books/:bookId/suppliers/:supplierId` — Admin/Manager
    - _Requirements: 8.6, 8.8, 8.11_

  - [x] 8.4 Update inventory migration for flexible reference types
    - Migration `1700000016_supplier_management`: ALTER TABLE inventory_history ADD COLUMN IF NOT EXISTS reference_type TEXT CHECK (reference_type IN ('purchase_order','return','adjustment','manual','initial_stock')); backfill existing rows with reference_type='manual' where reference_type IS NULL
    - Update `stockIn()` in inventory.service.ts to accept `referenceType` (required, defaults to 'manual') and validate that reference_type='purchase_order' requires a non-null reference_id
    - _Requirements: 8.15, 8.16, 8.17, 8.18_

  - [x] 8.5 Implement Supplier UI
    - Supplier list: DataTable with name, supplier_type badge (External / Publisher), linked publisher name (if publisher type), lead_time_days, is_active, is_blacklisted badge; filter by type/status
    - Create/Edit form: name, contact_info, lead_time_days, pricing_terms, Supplier Type dropdown (External / Publisher); if Publisher → show publisher dropdown from catalog publishers
    - Blacklist action: Admin/Manager only; confirmation dialog
    - Book form enhancement: "Suppliers" section — multi-select suppliers, mark one as primary; shows supplier_sku field per supplier
    - Stock In form update: Reference Type dropdown (purchase_order / return / adjustment / manual / initial_stock); Reference ID field shown only when reference_type='purchase_order'
    - TanStack Query hooks: `useSupplierList`, `useCreateSupplier`, `useUpdateSupplier`, `useDeactivateSupplier`, `useBlacklistSupplier`, `useBookSuppliers`, `useLinkBookSupplier`, `useUnlinkBookSupplier`
    - _Requirements: 8_

  - [x] 8.6 Write integration tests for supplier service
    - Create external supplier (no publisher_id), create publisher-type supplier (with publisher_id), publisher-type without publisher_id (422), external with publisher_id (422)
    - Duplicate name (409), update, deactivate, blacklist
    - validateSupplierForProcurement: active+clean passes, inactive fails (422), blacklisted fails (422)
    - getSuppliersForBook: returns linked suppliers sorted by is_primary
    - linkBookToSupplier: setting isPrimary=true clears previous primary
    - delete with POs (409), delete clean supplier
    - Stock In with reference_type='purchase_order' requires reference_id; other types allow null reference_id
    - _Requirements: 8_

  **Definition of Done:**
  - Authors remain purely bibliographic (no supplier link)
  - Publishers optionally act as suppliers via supplier_type='publisher' + publisher_id
  - Books can map to multiple suppliers; one can be marked primary
  - Blacklisted or inactive suppliers blocked from new POs
  - Stock In supports all 5 reference types (not just PO)
  - System ready for Procurement (Slice 9) without redesign
  - All integration tests passing

---

- [x] 9. Procure Stock via Purchase Orders (Full Lifecycle — Draft → GRN → Inventory)
  > Full procurement lifecycle: draft → approval → ordered → GRN (partial/full receive) → closed. GRN is the sole authoritative source of stock_in for purchased inventory. Supports flexible receiving destination (direct-to-branch or centralized). Clean separation from Payments (Slice 14).
  > _Slice 9 = Requirement 9 | Design: design.md §3.10, §4.3_
  > _Concurrency: Inline inventory update within GRN transaction — no nested transaction issues_

  - [x] 9.1 Create DB migrations: purchase_orders, po_line_items, po_receipts, po_receipt_items + receiving location refinement
    - Migration `1700000018`: `purchase_orders (id BIGSERIAL PK, branch_id, supplier_id, status CHECK IN ('draft','pending_approval','approved','ordered','partially_received','received','closed','cancelled'), total_amount NUMERIC(14,2), currency TEXT, expected_delivery_date DATE, notes TEXT, created_by, approved_by, created_at, updated_at)`
    - `po_line_items (id BIGSERIAL PK, po_id, book_id, format_id, edition_id, quantity, unit_cost, received_quantity, CONSTRAINT received_lte_ordered)`
    - `po_receipts (id BIGSERIAL PK, po_id, location_id, received_by, received_at, notes)`
    - `po_receipt_items (id BIGSERIAL PK, receipt_id, po_line_item_id, quantity_received)`
    - Migration `1700000019`: adds `receiving_branch_id`, `receiving_location_id`, `financial_status TEXT CHECK IN ('unpaid','partial','paid') DEFAULT 'unpaid'` to `purchase_orders`; backfills existing POs with branch's default fulfillment location
    - Seed: 2 sample draft POs
    - _Requirements: 9_

  - [x] 9.2 Implement procurement.service.ts
    - `createPO()` — validate supplier (active, not blacklisted), validate books active, calculate total_amount; accept `receivingBranchId`/`receivingLocationId` (auto-resolves to default fulfillment location if not provided); INSERT draft PO + line items, audit log
    - `updatePO()` — draft only; recalculate totals; replace line items; update receiving location with validation
    - `submitForApproval()` — draft → pending_approval (if total > threshold) or auto-approved (if ≤ threshold)
    - `approvePO()` — pending_approval → approved; sets approved_by
    - `markAsOrdered()` — approved → ordered
    - `receivePO(id, locationId | null, items, notes, staffCtx)` — TRANSACTIONAL: validate receivable status; resolve effective location (provided locationId OR PO's receiving_location_id); validate no over-receipt per line; UPDATE received_quantity; inline inventory update (INSERT inventory row if missing, UPDATE quantity, INSERT inventory_history with movement_type='stock_in' reference_type='purchase_order'); INSERT po_receipts + po_receipt_items; auto-set status to partially_received or received; audit log
    - `closePO()` — received → closed
    - `cancelPO()` — draft/pending_approval/approved only; blocked if any receipts exist
    - `getById()` / `list()` — full PO with line items, receipts, receiving location name, financial_status
    - _Requirements: 9_

  - [x] 9.3 Implement procurement API routes (10 endpoints)
    - `GET/POST /api/purchase-orders` — list (Admin/Manager/Purchasor/Stock_Clerk/Finance_Officer), create (Admin/Manager/Purchasor)
    - `GET/PUT /api/purchase-orders/:id` — detail / update draft
    - `POST /api/purchase-orders/:id/submit` — Admin/Manager/Purchasor
    - `POST /api/purchase-orders/:id/approve` — Admin/Manager only
    - `POST /api/purchase-orders/:id/order` — Admin/Manager/Purchasor
    - `POST /api/purchase-orders/:id/receive` — Admin/Manager/Stock_Clerk; body: `{ locationId? (optional, falls back to PO's receiving_location_id), items: [{ poLineItemId, quantityReceived }], notes? }`
    - `POST /api/purchase-orders/:id/close` — Admin/Manager
    - `POST /api/purchase-orders/:id/cancel` — Admin/Manager/Purchasor
    - _Requirements: 9_

  - [x] 9.4 Implement ProcurementPage.tsx (4 sub-views)
    - PO List: table with ID, supplier, status badge, total, expected date; filter by status/supplier; "New PO" button
    - PO Detail: header info (incl. receiving location name + payment status badge), line items table (ordered/received/remaining), GRN history, action buttons per status
    - Receive Goods (GRN form): location selector filtered to PO's receiving branch (pre-selects PO's receiving_location_id or default fulfillment), per-line quantity inputs with max=remaining, notes
    - Create/Edit PO form: supplier selector (active + not blacklisted), receiving branch + receiving location dropdowns (location filtered by branch), line item builder (book select + qty + unit cost), running total
    - RBAC: canWrite (Admin/Manager/Purchasor), canApprove (Admin/Manager), canReceive (Admin/Manager/Stock_Clerk)
    - Wired into Layout nav and App.tsx routing
    - _Requirements: 9_

  - [x] 9.5 Write integration tests for procurement service (16 tests)
    - Create PO → correct total_amount
    - Submit below threshold → auto-approved
    - Submit above threshold → pending_approval
    - Approve (Admin) → approved
    - Purchasor cannot approve (403)
    - Partial receive → partially_received + inventory updated
    - Over-receive → 422 OVER_RECEIPT
    - Full receive → received
    - Cancel draft → succeeds
    - Cancel after receipt → rejected (PO_INVALID_STATUS)
    - Inventory history: movement_type=stock_in, reference_type=purchase_order
    - Finance_Officer can list POs
    - Stock_Clerk can list but not create
    - Manager can approve
    - PO can be received at a specific non-default location
    - Receiving location defaults to PO's receiving_location_id when not specified in GRN
    - _Requirements: 9_

  **Definition of Done:**
  - Full PO lifecycle working (draft → closed)
  - Flexible receiving destination: direct-to-branch or centralized (Option A/B)
  - GRN correctly updates inventory inline within transaction at the resolved location
  - Partial receiving supported; status auto-transitions
  - Over-receipt rejected (422)
  - Cancel blocked after any receipt
  - financial_status field tracks payment readiness (unpaid/partial/paid) — payment logic deferred to Slice 14
  - No direct DB mutation outside service layer
  - 16 integration tests passing
  - Locations dropdown in GRN form uses PO's receiving branch (not hardcoded Main Branch)
  - GRN form fetches full PO detail (including line items) with `staleTime: 0` to avoid stale cache
  - Stock In reference type `purchase_order` shows PO dropdown instead of free-text input

---

- [x] 10. Manage Customers (Production-Grade ERP — CRUD, Groups, Loyalty, Store Credit)
  > Customer is a core financial entity. Supports POS (Slice-11), Orders (Slice-13), Returns (Slice-12), and future Payments (Slice-14). Config-driven loyalty. No PII encryption (phone/email stored plain — no AES overhead for operational lookup).
  > _Slice 10 = Requirement 10 | Design: design.md §3.11_

  - [x] 10.1 Create DB migration: customers, customer_groups, loyalty_accounts, loyalty_history, store_credit_accounts, store_credit_history
    - `customers (id SERIAL PK, branch_id INTEGER REFERENCES branches(id), customer_code TEXT UNIQUE NOT NULL, full_name TEXT NOT NULL, phone TEXT, email TEXT, gender TEXT CHECK (gender IN ('male','female','other')), date_of_birth DATE, address TEXT, city TEXT, is_active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT now(), created_by INTEGER)`
    - Indexes: `(phone)`, `(email)`, `(customer_code)`, `(branch_id, is_active)`
    - `customer_groups (id SERIAL PK, name TEXT UNIQUE NOT NULL, description TEXT, discount_pct NUMERIC(5,2) DEFAULT 0)`
    - `customer_group_membership (customer_id INTEGER REFERENCES customers(id), group_id INTEGER REFERENCES customer_groups(id), PRIMARY KEY (customer_id, group_id))`
    - `loyalty_accounts (customer_id INTEGER PRIMARY KEY REFERENCES customers(id), points_balance NUMERIC(14,2) DEFAULT 0, lifetime_points NUMERIC(14,2) DEFAULT 0, updated_at TIMESTAMPTZ DEFAULT now())`
    - `loyalty_history (id BIGSERIAL PK, customer_id INTEGER REFERENCES customers(id), transaction_ref TEXT, points_delta NUMERIC(14,2) NOT NULL, reason TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now())`
    - `store_credit_accounts (customer_id INTEGER PRIMARY KEY REFERENCES customers(id), balance NUMERIC(14,2) DEFAULT 0 CHECK (balance >= 0))`
    - `store_credit_history (id BIGSERIAL PK, customer_id INTEGER REFERENCES customers(id), ref_type TEXT, ref_id TEXT, amount NUMERIC(14,2) NOT NULL, direction TEXT NOT NULL CHECK (direction IN ('credit','debit')), created_at TIMESTAMPTZ DEFAULT now())`
    - Seed: 3 sample customers with loyalty + store credit accounts
    - _Requirements: 10_

  - [x] 10.2 Implement customer.service.ts + loyalty.service.ts + storeCredit.service.ts
    - `createCustomer(data, staffCtx)` — auto-generate `customer_code` (CUS-XXXX, zero-padded sequential); enforce unique phone/email (409 DUPLICATE_CONTACT); INSERT customers; INSERT loyalty_accounts + store_credit_accounts; INSERT audit_logs
    - `updateCustomer(id, data, staffCtx)` — UPDATE customers; INSERT audit_logs
    - `deactivateCustomer(id, staffCtx)` — UPDATE is_active=false; INSERT audit_logs (future: block if active orders)
    - `getCustomerById(id)` — JOIN loyalty_accounts + store_credit_accounts + group memberships
    - `searchCustomers(query, filters, page)` — search by name ILIKE, phone, email, customer_code; paginated
    - `accruePoints(customerId, transactionAmount, transactionRef, staffCtx)` — use `config.getLoyaltyAccrualRate()` + `config.getLoyaltyMinTransactionAmount()`; skip if below threshold; UPDATE loyalty_accounts; INSERT loyalty_history
    - `redeemPoints(customerId, points, transactionRef, staffCtx)` — validate balance; UPDATE loyalty_accounts; INSERT loyalty_history
    - `creditStoreCredit(customerId, amount, refType, refId, staffCtx)` — UPDATE store_credit_accounts; INSERT store_credit_history (direction='credit')
    - `debitStoreCredit(customerId, amount, refType, refId, staffCtx)` — validate balance >= amount (422 INSUFFICIENT_STORE_CREDIT); UPDATE store_credit_accounts; INSERT store_credit_history (direction='debit')
    - _Requirements: 10_

  - [x] 10.3 Implement customer API routes (12 endpoints)
    - `GET /api/customers` — all authenticated; paginated; `?q`, `branchId`, `isActive`, `groupId`
    - `POST /api/customers` — Admin/Manager/Sales
    - `GET /api/customers/:id` — all authenticated; full profile with loyalty + store credit
    - `PUT /api/customers/:id` — Admin/Manager/Sales
    - `POST /api/customers/:id/deactivate` — Admin/Manager
    - `GET /api/customer-groups` / `POST /api/customer-groups` — Admin/Manager
    - `GET /api/customers/:id/loyalty` — all authenticated
    - `GET /api/customers/:id/loyalty/history` — all authenticated; paginated
    - `POST /api/customers/:id/loyalty/redeem` — Sales; body: `{ points, transactionRef? }`
    - `GET /api/customers/:id/store-credit` — all authenticated
    - `GET /api/customers/:id/store-credit/history` — all authenticated; paginated
    - `POST /api/customers/:id/store-credit/adjust` — Admin/Finance_Officer; body: `{ amount, direction, refType?, refId? }`
    - _Requirements: 10_

  - [x] 10.4 Implement CustomersPage.tsx (4 sub-views)
    - Customer List: search (name/phone/code), table (code, name, phone, loyalty pts, credit balance, status), "New Customer" button
    - Customer Profile: personal info form (name, phone, email, gender, DOB, address, city, branch, group), edit/deactivate actions
    - Loyalty Tab: points balance, lifetime earned, redeem form, history timeline
    - Store Credit Tab: current balance, credit/debit history, manual adjustment form (Admin/Finance_Officer only)
    - RBAC: all roles view; Admin/Manager/Sales create+edit; Admin/Manager deactivate; Admin/Finance_Officer adjust store credit; Sales redeem loyalty
    - Wired into Layout nav and App.tsx routing
    - _Requirements: 10_

  - [x] 10.5 Write integration tests for customer service (10+ tests)
    - Create customer → loyalty + store credit accounts auto-created
    - customer_code auto-increments (CUS-0001, CUS-0002)
    - Duplicate phone → 409 DUPLICATE_CONTACT
    - Duplicate email → 409 DUPLICATE_CONTACT
    - Loyalty accrual: below threshold → no points; above threshold → correct points
    - Loyalty redeem: insufficient balance → 422
    - Store credit debit: insufficient balance → 422 INSUFFICIENT_STORE_CREDIT
    - Store credit credit → balance increases
    - Search by name, phone, customer_code
    - Deactivate customer → is_active=false
    - _Requirements: 10_

  **Definition of Done:**
  - Customer CRUD with auto-generated customer_code
  - Loyalty accounts auto-created on customer creation; config-driven accrual
  - Store credit enforces non-negative balance
  - Customer groups for segmentation (discount_pct ready for POS Slice-11)
  - Clean standalone UI (not embedded in POS)
  - Forward-compatible: customers.id referenced by transactions, orders, returns
  - All integration tests passing

---

- [x] 11. POS — Point of Sale Transactions (Atomic, ETB-only, Inventory-integrated)
  > Real-time transaction engine. Currency locked to ETB. Atomic inventory decrement with optimistic locking. Config-driven discounts and tax. Customer loyalty + store credit integration.
  > _Slice 11 = Requirement 11 | Design: design.md §3.12_
  > _Currency: ETB (Ethiopian Birr) — enforced at DB and service layer_

  - [x] 11.1 Create DB migration: transactions, transaction_line_items, transaction_payments
    - `transactions (id BIGSERIAL PK, branch_id INTEGER NOT NULL, location_id INTEGER NOT NULL, customer_id INTEGER REFERENCES customers(id), staff_id INTEGER NOT NULL, transaction_number TEXT UNIQUE NOT NULL, subtotal NUMERIC(14,2) NOT NULL, discount_total NUMERIC(14,2) DEFAULT 0, tax_total NUMERIC(14,2) DEFAULT 0, grand_total NUMERIC(14,2) NOT NULL, currency TEXT NOT NULL DEFAULT 'ETB', status TEXT CHECK (status IN ('completed','voided')) DEFAULT 'completed', created_at TIMESTAMPTZ DEFAULT now())`
    - Indexes: `(branch_id, status)`, `(customer_id)`, `(created_at DESC)`
    - `transaction_line_items (id BIGSERIAL PK, transaction_id BIGINT REFERENCES transactions(id), book_id INTEGER NOT NULL, quantity INTEGER NOT NULL CHECK (quantity > 0), unit_price NUMERIC(14,2) NOT NULL, discount_pct NUMERIC(5,2) DEFAULT 0, discount_amount NUMERIC(14,2) DEFAULT 0, line_total NUMERIC(14,2) NOT NULL)`
    - `transaction_payments (id BIGSERIAL PK, transaction_id BIGINT REFERENCES transactions(id), method TEXT CHECK (method IN ('cash','bank','store_credit','loyalty_points')), amount NUMERIC(14,2) NOT NULL, reference TEXT, created_at TIMESTAMPTZ DEFAULT now())`
    - Seed: no seed data needed
    - _Requirements: 11_

  - [x] 11.2 Implement pos.service.ts
    - `createTransaction(payload, staffCtx)` — ATOMIC single-step transaction creation:
      1. Validate books active; fetch prices via `catalog.getEffectivePrice(bookId, branchId)`
      2. Apply config discount rules: `getMaxLineDiscountPct(branchId, role)` — reject if exceeded
      3. Calculate line totals; subtotal; tax via `config.getTaxRate(branchId)`; grand_total
      4. Validate payments sum == grand_total (422 PAYMENT_SUM_MISMATCH)
      5. Validate store_credit balance if method='store_credit' (422 INSUFFICIENT_STORE_CREDIT)
      6. Validate loyalty_points balance if method='loyalty_points' (422 INSUFFICIENT_LOYALTY_POINTS)
      7. BEGIN; FOR UPDATE inventory rows; check stock (422 INSUFFICIENT_STOCK); UPDATE inventory (stock_out); INSERT inventory_history
      8. INSERT transactions + line_items + payments
      9. If customer: accruePoints(subtotal); debitStoreCredit if used; redeemPoints if used
      10. INSERT audit_logs; COMMIT
      11. Generate transaction_number: `POS-YYYYMMDD-XXXX`
    - `voidTransaction(id, staffCtx)` — validate status='completed'; reverse inventory (stock_in); reverse loyalty/credit; UPDATE status='voided'; INSERT audit_logs
    - `getById(id)` — full transaction with line items + payments
    - `list(opts)` — paginated; filter by branchId, customerId, staffId, dateFrom, dateTo, status
    - _Requirements: 11_

  - [x] 11.3 Implement POS API routes (4 endpoints)
    - `POST /api/pos/transactions` — Sales/Manager; body: `{ branchId, locationId, customerId?, items: [{bookId, quantity, discountPct?}], payments: [{method, amount, reference?}] }`
    - `GET /api/pos/transactions` — all authenticated; paginated; filters
    - `GET /api/pos/transactions/:id` — all authenticated
    - `POST /api/pos/transactions/:id/void` — Manager/Admin; body: `{ reason }`
    - _Requirements: 11_

  - [x] 11.4 Implement POSPage.tsx (single-screen POS terminal)
    - Layout: 3-column (product search | cart | summary+payment)
    - Left: book search (title/ISBN), results list with "Add" button, quantity input
    - Center: cart table (book, qty ±, unit price, discount%, line total, remove), customer selector (search/select/quick-create)
    - Right: subtotal, discount, tax, grand total (ETB), payment section (method tabs: Cash/Store Credit/Loyalty), amount input, "Complete Sale" button
    - Location selector in top bar (branch-locked, location selectable)
    - Receipt modal on success: transaction number, itemized lines, totals, payment breakdown
    - RBAC: Sales/Manager can create; Manager/Admin can void
    - Wired into Layout nav and App.tsx routing
    - _Requirements: 11_

  - [x] 11.5 Write integration tests for POS service (8+ tests)
    - Successful transaction → inventory decremented, transaction created
    - Insufficient stock → 422 INSUFFICIENT_STOCK
    - Payment sum mismatch → 422 PAYMENT_SUM_MISMATCH
    - Discount exceeds role limit → 422
    - Store credit payment → balance deducted
    - Loyalty points payment → balance deducted + accrual on subtotal
    - Void transaction → inventory restored, status='voided'
    - Grand total = subtotal - discount + tax (consistency check)
    - _Requirements: 11_

  **Definition of Done:**
  - Single-step atomic transaction (no draft state)
  - Currency locked to ETB
  - Inventory decremented via stock_out with inventory_history
  - Config-driven tax and discount rules applied
  - Customer loyalty + store credit integrated
  - Void reverses all inventory and customer effects
  - All integration tests passing
  - **Post-implementation fixes applied:**
    - `branchId` read from `getCurrentBranchId()` (in-memory session) — not `localStorage` — so location dropdown correctly scopes to the logged-in branch
    - `list()` SQL fixed: `LIMIT $N OFFSET $N+1` placeholders (was generating raw numbers, breaking history tab)
    - `GET /api/audit-logs` SQL fixed: same `$N` placeholder bug + `entity_type` condition missing `$` prefix
    - Audit log entity filter extended to include `transaction` and `purchase_order`
    - Payment UX: "Fill ETB X.XX" quick-fill button + auto-default to remaining balance on empty Add click

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

- [x] 12. Process Returns and Issue Refunds
  > Reverse a completed transaction. Includes return window enforcement, partial returns, and store credit issuance.
  > _Slice 12 = Requirement 12 | Design: design.md §3.13_

  - [x] 12.1 Create DB migration: returns, return_line_items, refunds
  - [x] 12.2 Implement returns.service.ts
  - [x] 12.3 Implement returns API routes + UI
  - [x] 12.4 Write integration tests for returns service

  **Definition of Done:**
  - Return window enforced; refund method restricted after window (store_credit_only policy)
  - Approval required for refunds exceeding max_return_value_without_auth
  - Inventory incremented on return via `pos_return` reference_type
  - Store credit balance updated atomically with refund record
  - Double-return and quantity overflow prevented (OVER_RETURN)
  - Loyalty points reversed proportionally on return
  - Refund cannot exceed amount paid on transaction
  - 8 integration tests passing
  - Returns page wired into Layout + App.tsx (Sales, Manager, Finance_Officer, Admin)
  - **Post-implementation fixes:**
    - Manager/Admin self-approve automatically (`isPrivileged` check) — no `APPROVAL_REQUIRED` error for privileged roles
    - Transaction search fixed: uses `transactionNumber` API filter instead of client-side pagination match
    - `pos.service.ts` list() `$N` placeholder bug fixed for all WHERE conditions + `transactionNumber` filter added
    - Returns UI: approval section simplified — Manager/Admin see confirmation banner; Sales see policy hint

---

- [x] 13. Manage Customer Orders (Create, Confirm, Fulfill, Cancel)
  > Multi-channel order management with stock reservation. Pessimistic locking on confirmation.
  > Currency locked to ETB. Supports partial fulfillment, split payments, and returns linkage.
  > _Slice 13 = Requirement 13 | Design: design.md §3.14, §4.2, §5.1_
  > _Concurrency: SELECT FOR UPDATE on inventory rows during confirmation_

  - [x] 13.1 Create DB migration: orders, order_line_items
  - [x] 13.2 Implement orders.service.ts
  - [x] 13.3 Implement order API routes + UI
  - [x] 13.4 Write integration tests for orders service
    - `orders (id BIGSERIAL PK, order_number TEXT UNIQUE NOT NULL, customer_id INTEGER REFERENCES customers(id), branch_id INTEGER REFERENCES branches(id), location_id INTEGER REFERENCES locations(id), channel TEXT NOT NULL CHECK (channel IN ('in_store','phone','online')), status TEXT DEFAULT 'Pending' CHECK (status IN ('Pending','Confirmed','In_Progress','Fulfilled','Cancelled')), payment_status TEXT DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','partial','paid','refunded')), currency TEXT NOT NULL DEFAULT 'ETB', subtotal NUMERIC(14,2), discount_amount NUMERIC(14,2) DEFAULT 0, tax_rate NUMERIC(6,4) NOT NULL, tax_amount NUMERIC(14,2), total NUMERIC(14,2), cancel_reason TEXT, created_by INTEGER NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now())`
    - Indexes: `(customer_id, status)`, `(branch_id, status)`, `created_at`
    - `order_line_items (id BIGSERIAL PK, order_id BIGINT REFERENCES orders(id), book_id INTEGER REFERENCES books(id), quantity INTEGER NOT NULL CHECK (quantity > 0), unit_price NUMERIC(14,2) NOT NULL, discount_amount NUMERIC(14,2) DEFAULT 0, total_price NUMERIC(14,2) NOT NULL, qty_reserved INTEGER NOT NULL DEFAULT 0, qty_fulfilled INTEGER NOT NULL DEFAULT 0, is_backordered BOOLEAN DEFAULT false)` + index on `order_id`
    - _Requirements: 13_

  - [ ] 13.2 Implement orders.service.ts
    - `create(data, staffCtx)` — validate customer/branch is_active; validate books is_active; get effective prices + tax rate from config; generate unique order_number (ORD-YYYYMMDD-XXXX); INSERT orders + order_line_items; INSERT audit_logs; idempotency: check for duplicate order_number on retry
    - `confirm(orderId, staffCtx)` — BEGIN; SELECT inventory FOR UPDATE for all line items; for each line: if quantity >= requested: UPDATE inventory SET qty_reserved += qty; else: set is_backordered=true; UPDATE orders status='Confirmed'; INSERT audit_logs; COMMIT
    - `progress(orderId, staffCtx)` — validate status='Confirmed'; UPDATE status='In_Progress'; INSERT audit_logs
    - `fulfill(orderId, staffCtx)` — BEGIN REPEATABLE READ; SELECT inventory FOR UPDATE; UPDATE inventory SET quantity -= qty_reserved, version=version+1; set qty_fulfilled=qty_reserved, qty_reserved=0; INSERT inventory_history (reference_type='order'); UPDATE orders status='Fulfilled'; INSERT audit_logs; COMMIT; 409 VERSION_CONFLICT on concurrent modification
    - `cancel(orderId, reason, staffCtx)` — validate status NOT 'Fulfilled' (409 ORDER_ALREADY_FULFILLED); release qty_reserved back to inventory; UPDATE status='Cancelled', cancel_reason=$reason; INSERT audit_logs
    - `updatePaymentStatus(orderId, paymentStatus)` — called by Payments module (Slice 14); UPDATE orders.payment_status
    - `getById(id)` — full order with line items
    - `list(opts)` — paginated; filter by status, payment_status, channel, branchId, customerId
    - _Requirements: 13.1–13.9_

  - [ ] 13.3 Implement order API routes + UI
    - `GET/POST /api/orders`, `GET /api/orders/:id`, `POST /api/orders/:id/confirm|progress|fulfill|cancel`
    - Order list: DataTable with order_number, customer, channel, status badge, payment_status badge, total; filter by status/channel/branch
    - Order detail: line items with qty_reserved + qty_fulfilled + is_backordered indicators; status action buttons; cancel reason input
    - Create order form: customer search, branch/location selects, channel select, line item builder with book search
    - RBAC: Sales/Manager create; Manager/Admin confirm/fulfill/cancel
    - _Requirements: 13_

  - [ ] 13.4 Write integration tests for orders service
    - Full lifecycle: create → confirm (stock reserved) → progress → fulfill (inventory decremented)
    - Cancel from each state; backorder set when stock unavailable; state machine violations (409)
    - Duplicate order_number idempotency; currency enforced as ETB
    - _Requirements: 13_

  **Definition of Done:**
  - Stock reservation uses SELECT FOR UPDATE (no overselling)
  - State machine enforced; invalid transitions return 409
  - Cancellation releases reserved inventory atomically
  - Backorder flag set when stock unavailable
  - payment_status tracked; updated by Payments module
  - Currency locked to ETB

---

- [x] 14. Accept Payments and Installment Plans for Orders
  > Flexible payment collection with split payments, partial payments, and refunds. Tightly integrated with Order Management.
  > _Slice 14 = Requirement 14 | Design: design.md §3.14, §5.2, §7.1, §7.2_

  - [x] 14.1 Create DB migration: order_payments, order_refunds
  - [x] 14.2 Implement payments.service.ts
  - [x] 14.3 Implement payment API routes + UI
  - [x] 14.4 Write integration tests for payments service

  **Definition of Done:**
  - Payment reference format: PAY-YYYYMMDD-XXXX; currency locked to ETB
  - Payment methods: cash, bank, mobile, card, store_credit, loyalty_points, other (extensible for Slice 15)
  - Payment status lifecycle: pending → success → refunded / partially_refunded
  - Total payment cannot exceed order total (422 EXCEEDS_ORDER_TOTAL)
  - Refund cannot exceed payment amount (422 EXCEEDS_PAYMENT_AMOUNT)
  - Order payment_status auto-updated: unpaid → partial → paid → refunded
  - Split payments supported (multiple payments per order, different methods)
  - Outstanding balance endpoint: GET /api/orders/:id/balance
  - Payments UI: list with status/method badges, inline refund form; Record Payment tab with order lookup + balance display
  - RBAC: Sales/Manager/Admin create payments; Manager/Admin process refunds
  - Migration 1700000026: creates order_payments, order_refunds tables
  - 8 integration tests passing

---

- [x] 15. Trade Books with Merchants (Exchange Orders, Settlement)
  > In-kind book trading with atomic inventory swap and net balance settlement calculation.
  > _Slice 15 = Requirement 15 | Design: design.md §3.15, §4.5_
  > _Concurrency: BEGIN + SELECT FOR UPDATE on inventory during exchange creation_

  - [x] 15.1 Create DB migration: exchanges, exchange_incoming_items, exchange_outgoing_items
  - [x] 15.2 Implement exchanges.service.ts
  - [x] 15.3 Implement exchange API routes + UI
  - [x] 15.4 Write integration tests for exchange service

  **Definition of Done:**
  - Exchange reference format: EXC-YYYYMMDD-XXXX; currency locked to ETB
  - Incoming items increase stock; outgoing items decrease stock — atomic within single transaction
  - net_balance = total_outgoing_value − total_incoming_value; settlement_type auto-derived (Even / Customer_Pays / Store_Refunds)
  - State machine: Evaluated → Completed (on creation) or Cancelled
  - Inventory history recorded with reference_type = exchange_in / exchange_out
  - Audit log entries on create and cancel
  - Migration 1700000027: exchanges, exchange_incoming_items, exchange_outgoing_items; extends inventory_history reference_type check
  - 8 integration tests passing

---

- [x] P3. Phase 3 Checkpoint — Financial Flows Validated
  - Run full integration test suite; zero failures
  - Manually test: create order → confirm (stock reserved) → add installment plan → record deposit payment → fulfill order → verify inventory decremented
  - Manually test: complete POS transaction → process return → verify store credit issued + inventory restored
  - Manually test: create exchange order → accept → settle → verify inventory swapped at both locations
  - Confirm outstanding balance math is correct across all payment scenarios

---

## Phase 4 — System Hardening
> Goal: Production-ready. Add async infrastructure, observability, reporting, security hardening, and CI/CD. The system already works — this phase makes it scale and survive.

---

- [x] 16. Generate Reports and Analytics
  > API-first reporting engine aggregating data across all modules. Read-only, no business logic.
  > _Slice 16 = Requirement 16 | Design: design.md §6.8_

  - [x] 16.1 Implement reports.service.ts (6 report functions)
  - [x] 16.2 Implement report API routes (6 endpoints)
  - [x] 16.3 Write integration tests for reports (10 tests)

  **Definition of Done:**
  - GET /api/reports/sales — order revenue + POS revenue, by period, by branch
  - GET /api/reports/payments — collected/refunded/pending, by method, by period
  - GET /api/reports/exchanges — totals, by settlement type, by period
  - GET /api/reports/inventory — stock summary, low-stock list, top-selling books, movement by period
  - GET /api/reports/customers — totals, repeat customers, top spenders, new by period
  - GET /api/reports/kpis — daily/monthly revenue, AOV, active customers, low-stock alerts, pending orders, exchanges today
  - Common filters: branchId, dateFrom, dateTo, groupBy (day/week/month)
  - RBAC: Manager/Admin only; Sales → 403
  - Empty date ranges return zeros, not errors
  - 10 integration tests passing

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

- [x] 17. Dashboard & UI (Analytics Presentation Layer)
  > Presentation-only dashboard consuming Reporting APIs (Slice 16). No business logic, no direct DB access.
  > _Slice 17 = Requirement 17 | Design: design.md §7.4_

  - [x] 17.1 Implement DashboardPage.tsx — consumes all 6 /reports/* endpoints
  - [x] 17.2 Wire Dashboard into App.tsx and Layout.tsx nav

  **Definition of Done:**
  - DashboardPage renders 7 KPI cards (daily revenue, monthly revenue, AOV, active customers, low-stock alerts, pending orders, exchanges today)
  - Sales trend line chart (by period); sales by branch bar chart
  - Payment method pie chart; payment collected vs refunded bar chart
  - Exchange summary with settlement type distribution
  - Inventory panel: stock summary, top-selling books, low-stock alerts list
  - Customer panel: summary stats, top customers by spend
  - Stock movement bar chart
  - Filter bar: dateFrom, dateTo, groupBy (day/week/month), clear
  - All panels show loading skeleton / error state / empty state gracefully
  - RBAC: Manager/Admin see dashboard; other roles see access-denied message
  - Dashboard nav item added to sidebar (Admin, Manager only)
  - Manager/Admin land on Dashboard after login
  - Uses recharts (already installed) — no new dependencies

---

## Post-MVP Hardening — Targeted Improvements
> Goal: Close the highest-impact gaps identified in BMS_MVP_Evaluation_1.md. Financial correctness, security baseline, and architectural alignment without rewriting existing modules.

---

- [x] H0. Post-MVP Hardening (Migration 1700000028)
  > Single migration covering all structural changes for hardening items P1–P5.
  > _Cross-cutting | References: BMS_MVP_Evaluation_1.md_

  - [x] H0.1 Create DB migration: 1700000028_hardening
    - `idempotency_keys (key TEXT PK, endpoint TEXT, request_hash TEXT, response_payload JSONB, created_at TIMESTAMPTZ, expires_at TIMESTAMPTZ DEFAULT now() + INTERVAL '24 hours')` + index on `expires_at`
    - `outbox (id BIGSERIAL PK, event_type TEXT, payload JSONB, status TEXT DEFAULT 'pending', created_at TIMESTAMPTZ, published_at TIMESTAMPTZ)` + index on `(status, created_at)`
    - `customers`: ADD COLUMNS `email_encrypted TEXT`, `phone_encrypted TEXT`, `email_lookup TEXT`, `phone_lookup TEXT` + indexes on lookup columns
    - `installment_plans (id BIGSERIAL PK, order_id BIGINT REFERENCES orders(id), total_amount NUMERIC(14,2), deposit_amount NUMERIC(14,2), num_installments INTEGER, currency TEXT DEFAULT 'ETB', notes TEXT, created_by INTEGER, created_at TIMESTAMPTZ)`
    - `installments (id BIGSERIAL PK, plan_id BIGINT REFERENCES installment_plans(id), order_id BIGINT REFERENCES orders(id), due_date DATE, amount NUMERIC(14,2), paid_amount NUMERIC(14,2) DEFAULT 0, status TEXT DEFAULT 'pending' CHECK (status IN ('pending','partial','paid','overdue')), paid_at TIMESTAMPTZ, created_at TIMESTAMPTZ)` + indexes on `(plan_id)`, `(order_id)`, `(status, due_date)`
    - `merchants (id SERIAL PK, name TEXT UNIQUE NOT NULL, contact_info JSONB, address TEXT, is_active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ)`
    - `exchanges`: ADD COLUMN `merchant_id INTEGER REFERENCES merchants(id)` (nullable)
    - `order_payments`: ADD COLUMN `bank_account_id INTEGER REFERENCES bank_accounts(id)` (nullable)
    - `order_refunds`: ADD COLUMN `bank_account_id INTEGER REFERENCES bank_accounts(id)` (nullable)

  **Definition of Done:**
  - Migration applies cleanly; all 28 migrations pass
  - All existing tests continue to pass after migration

---

- [x] H1. Bank Transfer Validation + Reconciliation Linkage (P1)
  > Enforce bank_account_id on bank transfer payments/refunds; auto-create reconciliation entries.
  > _Fixes: BMS_MVP_Evaluation_1.md Slices 4, 12, 14 gaps_

  - [x] H1.1 Enforce bank_account_id in payments.service.ts createPayment
    - When `paymentMethod = 'bank'`: require `bankAccountId`; validate account is active and belongs to current branch; return `422 INVALID_BANK_ACCOUNT` on failure
    - Auto-INSERT `bank_reconciliation (bank_account_id, payment_ref_id, amount, direction='in', status='uncleared')` within same transaction
  - [x] H1.2 Enforce bank_account_id in payments.service.ts createRefund
    - Accept optional `bankAccountId`; auto-INSERT `bank_reconciliation (bank_account_id, refund_ref_id, amount, direction='out', status='uncleared')` when provided
  - [x] H1.3 Update payments.routes.ts to pass bankAccountId from request body
  - [x] H1.4 Update existing payments tests to use non-bank methods (mobile) where bank_account_id not available

  **Definition of Done:**
  - POST /api/payments with paymentMethod='bank' and no bankAccountId → 400
  - POST /api/payments with paymentMethod='bank' and wrong-branch bankAccountId → 422 INVALID_BANK_ACCOUNT
  - Successful bank payment auto-creates bank_reconciliation entry (direction='in', status='uncleared')
  - Refund with bankAccountId auto-creates bank_reconciliation entry (direction='out', status='uncleared')
  - All existing payment tests pass

---

- [x] H2. PostgreSQL-Backed Idempotency (P1)
  > Prevent duplicate financial records on client retries using Idempotency-Key header.
  > _Fixes: BMS_MVP_Evaluation_1.md Cross-Cutting Gap #2_

  - [x] H2.1 Implement lib/idempotency.ts
    - `withIdempotency(key, endpoint, requestHash, fn)` — check idempotency_keys table; if found: return stored response; if not: execute fn(), store result, return
    - Opportunistic cleanup of expired keys (1% of requests)
    - `hashBody(body)` — SHA256 of JSON-serialized request body
  - [x] H2.2 Apply idempotency to POST /api/payments
    - Read `Idempotency-Key` header; call `withIdempotency`; set `X-Idempotent-Replayed: true` on replay; return 200 on replay, 201 on first write

  **Definition of Done:**
  - Duplicate POST /api/payments with same Idempotency-Key returns stored response + X-Idempotent-Replayed: true header
  - No duplicate payment record created on retry
  - Requests without Idempotency-Key work normally

---

- [x] H3. Customer PII Encryption (P2)
  > Encrypt customer email/phone at rest using AES-256-GCM; add SHA256 lookup hashes for search.
  > _Fixes: BMS_MVP_Evaluation_1.md Slice 10 gap_

  - [x] H3.1 Implement lib/piiEncryption.ts
    - `encryptPii(value)` — AES-256-GCM encrypt using COLUMN_ENCRYPTION_KEY; returns null for null input
    - `decryptPii(ciphertext)` — decrypt; returns null on failure
    - `piiLookupHash(value)` — SHA256 of lowercased/trimmed value; returns null for null input
  - [x] H3.2 Update customer.service.ts createCustomer
    - Write `email_encrypted`, `phone_encrypted`, `email_lookup`, `phone_lookup` on INSERT
    - Uniqueness checks use `phone_lookup = $hash OR phone = $plaintext` (backward compatible)
  - [x] H3.3 Update customer.service.ts mapCustomerRow
    - Prefer decrypted value from `*_encrypted` columns; fall back to plaintext columns
  - [x] H3.4 Update customer.service.ts searchCustomers
    - Search includes `phone_lookup = $hash OR email_lookup = $hash` for exact-match on encrypted values

  **Definition of Done:**
  - New customers have email_encrypted, phone_encrypted, email_lookup, phone_lookup populated
  - API returns decrypted values transparently (no API change)
  - Search by exact email/phone works via lookup hash
  - Existing customers with plaintext-only columns continue to work (backward compatible)
  - 5 PII encryption tests passing

---

- [x] H4. In-Memory Rate Limiting (P2)
  > Protect login endpoint from brute-force attacks using sliding window rate limiter.
  > _Fixes: BMS_MVP_Evaluation_1.md Cross-Cutting Gap #2_

  - [x] H4.1 Implement middleware/rateLimit.ts
    - In-memory sliding window counter per IP; no Redis required
    - `loginRateLimit`: 10 requests per 15 minutes per IP
    - `apiRateLimit`: 200 requests per minute per IP (available for future use)
    - Returns 429 with `Retry-After` header on limit exceeded
    - Auto-cleanup of expired entries every 5 minutes
  - [x] H4.2 Apply loginRateLimit to POST /api/auth/login

  **Definition of Done:**
  - POST /api/auth/login rate-limited to 10 req/15min per IP
  - 429 response includes Retry-After header
  - X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset headers on all responses

---

- [x] H5. Installment Plans — Minimal Viable Version (P3)
  > Scheduled payment plans for orders with config-driven deposit and installment count limits.
  > _Fixes: BMS_MVP_Evaluation_1.md Slice 14 gap_

  - [x] H5.1 Implement payments/installments.service.ts
    - `createPlan(data, staffCtx)` — validate order exists and not cancelled/paid; check no existing plan; enforce `max_installments` from config; enforce `min_deposit_pct` from config; generate monthly installment schedule; INSERT installment_plans + installments; INSERT audit_log
    - `getPlanById(id)` — fetch plan with all installments
    - `getPlanByOrder(orderId)` — fetch plan for an order (returns null if none)
    - `recordInstallmentPayment(installmentId, amount, staffCtx)` — validate amount ≤ remaining; UPDATE installment status (pending → partial → paid); recompute order.payment_status; INSERT audit_log
  - [x] H5.2 Implement payments/installments.routes.ts
    - `POST /api/orders/:id/installment-plan` — create plan (Sales, Manager, Admin, Finance_Officer)
    - `GET /api/orders/:id/installment-plan` — get plan for order
    - `GET /api/installment-plans/:id` — get plan by ID
    - `POST /api/installments/:id/pay` — record installment payment

  **Definition of Done:**
  - Installment plan created with correct schedule (monthly due dates, last installment absorbs rounding)
  - min_deposit_pct enforced from config (422 DEPOSIT_TOO_LOW if below minimum)
  - max_installments enforced from config (422 EXCEEDS_MAX_INSTALLMENTS if exceeded)
  - Duplicate plan for same order rejected (422 PLAN_EXISTS)
  - Installment payment updates status: pending → partial → paid
  - Order payment_status updated after each installment payment
  - 5 installment tests passing

---

- [x] H6. Merchant Foundation (P4)
  > Add merchants table and nullable merchant_id on exchanges to prepare for future merchant-to-merchant exchange.
  > _Partial fix: BMS_MVP_Evaluation_1.md Slice 15 gap_

  - [x] H6.1 Create merchants table (via migration 1700000028)
    - `merchants (id SERIAL PK, name TEXT UNIQUE NOT NULL, contact_info JSONB, address TEXT, is_active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ)`
  - [x] H6.2 Add nullable merchant_id to exchanges table
    - Existing direct exchange flows unchanged; merchant_id is optional

  **Definition of Done:**
  - merchants table exists and is queryable
  - exchanges.merchant_id column exists (nullable); existing exchanges unaffected
  - No breaking changes to existing exchange API or tests

---

- [x] H7. Outbox Table Foundation (P5)
  > Create outbox table as the foundation for future async event delivery.
  > _Partial fix: BMS_MVP_Evaluation_1.md Cross-Cutting Gap #1_

  - [x] H7.1 Create outbox table (via migration 1700000028)
    - `outbox (id BIGSERIAL PK, event_type TEXT, payload JSONB, status TEXT DEFAULT 'pending', created_at TIMESTAMPTZ, published_at TIMESTAMPTZ)` + index on `(status, created_at)`
  - Note: Workers (BullMQ, Outbox_Poller) remain deferred to future hardening phase

  **Definition of Done:**
  - outbox table exists and is queryable
  - Ready for worker implementation without further schema changes

---

- [x] H8. Hardening Integration Tests
  > 15 new integration tests covering all hardening items.

  - [x] H8.1 PII encryption round-trip tests (5 tests)
  - [x] H8.2 Bank transfer validation tests (3 tests)
  - [x] H8.3 Idempotency tests (2 tests)
  - [x] H8.4 Installment plan tests (5 tests)

  **Definition of Done:**
  - 20 test files, 253 tests, all passing
  - All 238 pre-hardening tests continue to pass

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
