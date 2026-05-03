# Implementation Tasks — ERP Production Hardening

## Phase 1: Database Foundation

- [x] 1. Create migration `1700000033_erp_hardening.cjs`
  - [x] 1.1 Extend `orders.status` CHECK constraint to include new values
  - [x] 1.2 Map existing order statuses to new values (Pending→DRAFT, etc.)
  - [x] 1.3 Create `inventory_reservations` table with indexes
  - [x] 1.4 Add `damaged_quantity` column to `inventory` table
  - [x] 1.5 Extend `inventory_history.reference_type` constraint
  - [x] 1.6 Add `lifecycle_status`, `original_order_id`, `customer_id_v2` to `exchanges`
  - [x] 1.7 Map existing exchange statuses to new `lifecycle_status` values
  - [x] 1.8 Create `exchange_items` table (unified, additive)
  - [x] 1.9 Create `exchange_settlement_entries` table
  - [x] 1.10 Create `financial_transactions` table with idempotency_key UNIQUE constraint
  - [x] 1.11 Add `is_all_branches` column to `staff` table
  - [x] 1.12 Ensure `idempotency_keys` table exists (idempotent CREATE IF NOT EXISTS)

## Phase 2: Permission System

- [x] 2. Create `apps/api/src/lib/permissions.ts`
  - [x] 2.1 Define `Permission` type with all 9 permission codes
  - [x] 2.2 Define `ROLE_PERMISSIONS` mapping for all 7 roles
  - [x] 2.3 Implement `getPermissionsForRoles(roles: string[]): Permission[]`

- [x] 3. Update `apps/api/src/middleware/rbac.ts`
  - [x] 3.1 Keep existing `requireRole()` unchanged
  - [x] 3.2 Add `requirePermission(...permissions)` middleware
  - [x] 3.3 Fall back to role-derived permissions when JWT `permissions` array is absent

- [x] 4. Update `apps/api/src/middleware/auth.ts`
  - [x] 4.1 Extend `StaffPayload` interface to include optional `permissions?: string[]`

- [x] 5. Update `apps/api/src/modules/auth/auth.service.ts`
  - [x] 5.1 In `login()`: load all roles for the branch, compute permission union
  - [x] 5.2 Include `permissions` array in JWT payload (keep `role` field for compat)
  - [x] 5.3 In `refresh()`: re-derive permissions from stored `branch_id` and `role` (or load from DB)

## Phase 3: Order Lifecycle

- [x] 6. Update `apps/api/src/modules/orders/orders.service.ts`
  - [x] 6.1 Change `create()` to insert `status = 'DRAFT'`
  - [x] 6.2 Update `confirm()` to transition `DRAFT → CONFIRMED` and create `inventory_reservations`
  - [x] 6.3 Add `pay()` function: transitions `CONFIRMED → PAID`, creates `financial_transactions` record
  - [x] 6.4 Update `fulfill()` to accept `PAID` status, convert reservations to `deducted`, auto-transition to `COMPLETED`
  - [x] 6.5 Update `cancel()` to handle `DRAFT` (no reservation release) vs `CONFIRMED` (release reservations)
  - [x] 6.6 Add `computeOrderAllowedActions()` helper
  - [x] 6.7 Include `allowedActions` in all order response objects

- [x] 7. Update `apps/api/src/modules/orders/orders.routes.ts`
  - [x] 7.1 Replace `requireRole` with `requirePermission` on all order mutation routes
  - [x] 7.2 Add `POST /api/orders/:id/pay` route (triggers `CONFIRMED → PAID`)

## Phase 4: Exchange Lifecycle

- [x] 8. Update `apps/api/src/modules/exchanges/exchanges.service.ts`
  - [x] 8.1 Keep existing `createExchange()` unchanged (backward compat)
  - [x] 8.2 Add `initiateExchange()`: creates exchange with `lifecycle_status = 'INITIATED'`, accepts `exchange_items` with `type` and `condition`
  - [x] 8.3 Add `reviewExchange()`: transitions to `REVIEWED`, computes difference, validates `original_order_id` if provided
  - [x] 8.4 Add `approveExchange()`: transitions to `APPROVED`, locks values
  - [x] 8.5 Add `settleExchange()`: validates settlement entries balance, applies inventory changes atomically, creates `financial_transactions`, transitions to `SETTLED` then `COMPLETED`
  - [x] 8.6 Update `cancelExchange()` to check `lifecycle_status` in addition to legacy `status`
  - [x] 8.7 Add `computeExchangeAllowedActions()` helper
  - [x] 8.8 Include `allowedActions` and `lifecycleStatus` in all exchange response objects
  - [x] 8.9 Implement auto customer inheritance from `original_order_id`

- [x] 9. Update `apps/api/src/modules/exchanges/exchanges.routes.ts`
  - [x] 9.1 Add `POST /api/exchanges/initiate` [requirePermission('CREATE_SALE')]
  - [x] 9.2 Add `POST /api/exchanges/:id/review` [requirePermission('APPROVE_EXCHANGE')]
  - [x] 9.3 Add `POST /api/exchanges/:id/approve` [requirePermission('APPROVE_EXCHANGE')]
  - [x] 9.4 Add `POST /api/exchanges/:id/settle` [requirePermission('APPROVE_EXCHANGE')] with idempotency key support
  - [x] 9.5 Replace `requireRole` with `requirePermission` on existing exchange routes

## Phase 5: Financial Transactions

- [x] 10. Create `apps/api/src/modules/financialTransactions/financialTransactions.service.ts`
  - [x] 10.1 Implement `createTransaction()` with idempotency key check
  - [x] 10.2 Implement `listTransactions()` with order_id / exchange_id filters
  - [x] 10.3 Enforce `order_id OR exchange_id` constraint at service layer

- [x] 11. Create `apps/api/src/modules/financialTransactions/financialTransactions.routes.ts`
  - [x] 11.1 `POST /api/financial-transactions` [requirePermission('PROCESS_PAYMENT')]
  - [x] 11.2 `GET /api/financial-transactions` [requirePermission('VIEW_REPORTS')]

- [x] 12. Register financial transactions router in `apps/api/src/app.ts`

## Phase 6: Inventory Reservation + Stock Visibility

- [x] 13. Update `apps/api/src/modules/inventory/inventory.service.ts`
  - [x] 13.1 Update available stock calculation to subtract active reservations
  - [x] 13.2 Add `createReservation()` helper
  - [x] 13.3 Add `releaseReservations()` helper (for order cancellation)
  - [x] 13.4 Add `deductReservations()` helper (for order fulfilment)

- [x] 14. Update `apps/api/src/modules/catalog/catalog.service.ts`
  - [x] 14.1 Update `searchBooks()` stock_quantity subquery to subtract active reservations

## Phase 7: Multi-Branch Support

- [x] 15. Update `apps/api/src/middleware/branchCtx.ts`
  - [x] 15.1 When `is_all_branches = true` and `?branchId` param provided, use that branch
  - [x] 15.2 When `is_all_branches = true` and no param, allow all-branch queries

- [x] 16. Update `apps/api/src/modules/reports/reports.service.ts`
  - [x] 16.1 Accept optional `branchId` param; when absent and `is_all_branches = true`, query all branches

## Phase 8: Frontend

- [x] 17. Update `apps/web/src/pages/OrdersPage.tsx`
  - [x] 17.1 Replace status display with new lifecycle status labels
  - [x] 17.2 Render action buttons from `allowedActions` array
  - [x] 17.3 Add Confirm, Take Payment, Fulfill, Cancel, Print actions

- [x] 18. Update `apps/web/src/pages/ExchangesPage.tsx`
  - [x] 18.1 Add multi-step exchange creation form (Initiate → Review → Approve → Settle)
  - [x] 18.2 Add settlement entry form with multi-entry support
  - [x] 18.3 Add returned item condition selector (Resellable / Damaged)
  - [x] 18.4 Render `allowedActions` buttons per exchange

- [x] 19. Update `apps/web/src/pages/POSPage.tsx`
  - [x] 19.1 Show available stock quantity (net of reservations) under each book
  - [x] 19.2 Show "Out of stock" badge when available = 0

- [x] 20. Update `apps/web/src/lib/auth.ts`
  - [x] 20.1 Parse `permissions` array from JWT in `restoreSession()` and `login()`
  - [x] 20.2 Store permissions in app state

- [x] 21. Update `apps/web/src/App.tsx`
  - [x] 21.1 Add `userPermissions` state alongside `userRole`
  - [x] 21.2 Pass `userPermissions` to pages that need fine-grained action visibility

## Phase 9: Property-Based Tests

- [x] 22. Add property-based tests in `apps/api/src/tests/`
  - [x] 22.1 Order status monotonicity: status can only advance or go to CANCELLED
  - [x] 22.2 Inventory conservation: deducted reservations match inventory_history deltas
  - [x] 22.3 Settlement balance: settlement entries sum equals exchange net_balance
  - [x] 22.4 Financial traceability: every financial_transactions row has order_id or exchange_id
  - [x] 22.5 Idempotency: duplicate idempotency_key produces same response, one DB row
  - [x] 22.6 Permission union: staff with multiple roles gets union of all permissions
  - [x] 22.7 Reservation availability: available_stock ≥ 0 after any confirm

## Phase 10: Multi-Role / Multi-Branch Auth Refactor

- [x] 23. Refactor authentication to industry-standard multi-role, multi-branch model
  - [x] 23.1 Add `POST /api/auth/pre-login` — validates credentials, returns available branches (no CSRF required)
  - [x] 23.2 Add `GET /api/auth/branches` — returns branches for authenticated user (for branch switcher)
  - [x] 23.3 Add `POST /api/auth/switch-branch` — issues new access token for a different branch
  - [x] 23.4 Add `getBranchesForUser()` to auth.service.ts — supports `is_all_branches` flag
  - [x] 23.5 Add `switchBranch()` to auth.service.ts — recomputes permissions for new branch
  - [x] 23.6 Include `roles` array (all roles for active branch) in JWT alongside `role` (primary)
  - [x] 23.7 Update `auth.ts` middleware to decode `roles` array from JWT
  - [x] 23.8 Update `express.d.ts` to add `roles?: string[]` to `req.staff`

- [x] 24. Update frontend login flow (two-step smart login)
  - [x] 24.1 Rewrite `LoginPage.tsx` — step 1: credentials only; step 2: branch picker
  - [x] 24.2 Auto-select branch when user has only one branch
  - [x] 24.3 Show branch picker with roles per branch when user has multiple branches
  - [x] 24.4 Show 🌐 indicator for `is_all_branches` staff

- [x] 25. Add branch switcher to top navigation
  - [x] 25.1 Add branch switcher dropdown to `Layout.tsx` top bar
  - [x] 25.2 Show all accessible branches with roles per branch
  - [x] 25.3 On branch switch: recompute permissions, invalidate all React Query caches
  - [x] 25.4 Replace single role badge with all-roles tags (informational display)

- [x] 26. Update App.tsx session management
  - [x] 26.1 Add `userRoles` state (all roles for active branch)
  - [x] 26.2 Add `activeBranchId` state
  - [x] 26.3 Add `handleSwitchBranch()` handler
  - [x] 26.4 Add `switchBranch()` to `auth.ts` frontend library
  - [x] 26.5 Admin/Super_Admin land on Dashboard (not Settings)

- [x] 27. Staff management: All Branches access flag
  - [x] 27.1 Add `PUT /api/staff/:id/all-branches` endpoint
  - [x] 27.2 Return `isAllBranches` in `GET /staff` and `GET /staff/me`
  - [x] 27.3 Add All Branches toggle to staff creation form
  - [x] 27.4 Show 🌐 All Branches badge in staff list branch column
  - [x] 27.5 Add 🌐 toggle button in staff list actions column
  - [x] 27.6 Migration `1700000034_staff_all_branches_flag.cjs` — safety guard for `is_all_branches` column

## Phase 11: Bug Fixes and Stability

- [x] 28. Fix CSRF and authentication errors
  - [x] 28.1 Add `/api/auth/pre-login` to CSRF exempt paths
  - [x] 28.2 Skip server logout call when no access token exists (prevents 401 on load)
  - [x] 28.3 Fix session restore: remove `sessionStorage` gate that caused F5 logout
  - [x] 28.4 Set refresh token cookie `maxAge` to 8 hours (covers full work shift)

- [x] 29. Fix catalog `GET /api/books` 500 error
  - [x] 29.1 Fix missing `$` prefix on parameter placeholders in `stock_quantity` subquery
  - [x] 29.2 Both `inventory_reservations` and `inventory` subqueries now use `$${locParam}` correctly

- [x] 30. Fix React key warning in OrdersPage
  - [x] 30.1 Replace anonymous `<>` fragment with `<React.Fragment key={order.id}>`
  - [x] 30.2 Add `import React from 'react'`

- [x] 31. Fix form visibility for multi-role users
  - [x] 31.1 `canCreate()` in OrdersPage now checks `userPermissions` for `CREATE_SALE` first
  - [x] 31.2 `canCreate()` in ExchangesPage now checks `userPermissions` for `CREATE_SALE` first
  - [x] 31.3 Users with `Stock_Clerk + Sales` roles can now see New Order / Exchange forms

- [x] 32. Fix `is_all_branches` column resilience
  - [x] 32.1 Seed adds column via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` before data operations
  - [x] 32.2 `GET /staff` and `GET /staff/me` fetch `is_all_branches` in a separate try/catch
  - [x] 32.3 `PUT /api/staff/:id/all-branches` self-heals missing column on first call
