# Design Document — ERP Production Hardening

## Overview

This document describes the technical design for hardening the Bookstore ERP for production. All changes are **additive and backward-compatible**. No existing tables, columns, API contracts, or business logic are removed. The design extends the existing Node.js/Express API and React frontend.

The work is organised into eight focused areas:

1. Order Lifecycle State Machine
2. Inventory Reservation Lifecycle
3. Exchange Lifecycle State Machine
4. Exchange Item Model + Returned Item Classification
5. Exchange Payment Difference Engine + Hybrid Settlement
6. Permission-Based Access Control + JWT Permissions
7. Multi-Branch `is_all_branches` Support
8. `allowed_actions` in API Responses + POS Stock Visibility

---

## 1. Database Schema Additions (Additive Only)

### 1.1 Migration: `1700000033_erp_hardening.cjs`

All schema changes are in a single migration for atomicity.

```sql
-- 1. Extend orders.status enum (additive)
ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders
  ADD CONSTRAINT orders_status_check
  CHECK (status IN (
    'Pending','Confirmed','In_Progress','Fulfilled','Cancelled',  -- legacy
    'DRAFT','CONFIRMED','PAID','FULFILLED','COMPLETED','CANCELLED' -- new
  ));

-- 2. Map existing order statuses to new values
UPDATE orders SET status = 'DRAFT'      WHERE status = 'Pending';
UPDATE orders SET status = 'CONFIRMED'  WHERE status IN ('Confirmed','In_Progress');
UPDATE orders SET status = 'FULFILLED'  WHERE status = 'Fulfilled';
UPDATE orders SET status = 'CANCELLED'  WHERE status = 'Cancelled';
UPDATE orders SET status = 'COMPLETED'
  WHERE status = 'FULFILLED' AND payment_status = 'paid';

-- 3. Inventory reservations table (new)
CREATE TABLE IF NOT EXISTS inventory_reservations (
  id           BIGSERIAL PRIMARY KEY,
  order_id     BIGINT    NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  book_id      INTEGER   NOT NULL REFERENCES books(id),
  location_id  INTEGER   NOT NULL REFERENCES locations(id),
  quantity     INTEGER   NOT NULL CHECK (quantity > 0),
  status       TEXT      NOT NULL DEFAULT 'reserved'
                CHECK (status IN ('reserved','deducted','released')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inv_res_order ON inventory_reservations(order_id);
CREATE INDEX IF NOT EXISTS idx_inv_res_book_loc ON inventory_reservations(book_id, location_id)
  WHERE status = 'reserved';

-- 4. Add damaged_quantity to inventory (additive)
ALTER TABLE inventory
  ADD COLUMN IF NOT EXISTS damaged_quantity INTEGER NOT NULL DEFAULT 0;

-- 5. Extend inventory_history.reference_type (additive)
ALTER TABLE inventory_history
  DROP CONSTRAINT IF EXISTS inventory_history_reference_type_check;
ALTER TABLE inventory_history
  ADD CONSTRAINT inventory_history_reference_type_check
  CHECK (reference_type IN (
    'purchase_order','return','adjustment','transfer_in','transfer_out',
    'stock_in','stock_out','exchange_in','exchange_out',  -- existing
    'order','exchange_damaged'                            -- new
  ));

-- 6. Exchange lifecycle columns (additive)
ALTER TABLE exchanges
  ADD COLUMN IF NOT EXISTS lifecycle_status TEXT
    CHECK (lifecycle_status IN (
      'INITIATED','REVIEWED','APPROVED','SETTLED','COMPLETED','CANCELLED'
    )),
  ADD COLUMN IF NOT EXISTS original_order_id BIGINT REFERENCES orders(id),
  ADD COLUMN IF NOT EXISTS customer_id_v2    INTEGER REFERENCES customers(id);

-- Map existing exchange statuses
UPDATE exchanges SET lifecycle_status = 'INITIATED'  WHERE status = 'Initiated';
UPDATE exchanges SET lifecycle_status = 'INITIATED'  WHERE status = 'Evaluated';
UPDATE exchanges SET lifecycle_status = 'COMPLETED'  WHERE status = 'Completed';
UPDATE exchanges SET lifecycle_status = 'CANCELLED'  WHERE status = 'Cancelled';

-- 7. Unified exchange_items table (additive; old tables remain)
CREATE TABLE IF NOT EXISTS exchange_items (
  id           BIGSERIAL PRIMARY KEY,
  exchange_id  BIGINT    NOT NULL REFERENCES exchanges(id) ON DELETE CASCADE,
  book_id      INTEGER   NOT NULL REFERENCES books(id),
  quantity     INTEGER   NOT NULL CHECK (quantity > 0),
  unit_price   NUMERIC(12,2) NOT NULL,
  total_price  NUMERIC(12,2) NOT NULL,
  type         TEXT      NOT NULL CHECK (type IN ('returned','new')),
  condition    TEXT      NOT NULL DEFAULT 'resellable'
                CHECK (condition IN ('resellable','damaged')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_exchange_items_exchange ON exchange_items(exchange_id);

-- 8. Exchange settlement entries table (new)
CREATE TABLE IF NOT EXISTS exchange_settlement_entries (
  id              BIGSERIAL PRIMARY KEY,
  exchange_id     BIGINT    NOT NULL REFERENCES exchanges(id) ON DELETE CASCADE,
  entry_type      TEXT      NOT NULL
                    CHECK (entry_type IN ('cash_payment','cash_refund','item_value_adjustment')),
  amount          NUMERIC(12,2) NOT NULL,
  currency        TEXT      NOT NULL DEFAULT 'ETB',
  method          TEXT,  -- cash, bank_transfer, etc. (nullable for adjustments)
  note            TEXT,
  override_reason TEXT,  -- populated for item_value_adjustment overrides
  authorised_by   INTEGER REFERENCES staff(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_settlement_entries_exchange ON exchange_settlement_entries(exchange_id);

-- 9. Financial transactions table (new, additive alongside existing payments)
CREATE TABLE IF NOT EXISTS financial_transactions (
  id               BIGSERIAL PRIMARY KEY,
  type             TEXT      NOT NULL
                     CHECK (type IN ('payment','refund','adjustment')),
  order_id         BIGINT    REFERENCES orders(id),
  exchange_id      BIGINT    REFERENCES exchanges(id),
  idempotency_key  TEXT      UNIQUE NOT NULL,
  amount           NUMERIC(12,2) NOT NULL,
  currency         TEXT      NOT NULL DEFAULT 'ETB',
  method           TEXT,
  staff_id         INTEGER   NOT NULL REFERENCES staff(id),
  branch_id        INTEGER   NOT NULL REFERENCES branches(id),
  meta             JSONB     NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ft_must_reference_order_or_exchange
    CHECK (order_id IS NOT NULL OR exchange_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_ft_order    ON financial_transactions(order_id);
CREATE INDEX IF NOT EXISTS idx_ft_exchange ON financial_transactions(exchange_id);
CREATE INDEX IF NOT EXISTS idx_ft_idem     ON financial_transactions(idempotency_key);

-- 10. is_all_branches flag on staff (additive)
ALTER TABLE staff
  ADD COLUMN IF NOT EXISTS is_all_branches BOOLEAN NOT NULL DEFAULT false;

-- 11. Idempotency keys table (already exists via migration 28; ensure it exists)
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key              TEXT PRIMARY KEY,
  endpoint         TEXT NOT NULL,
  request_hash     TEXT NOT NULL,
  response_payload JSONB NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '24 hours')
);
```

---

## 2. Permission System

### 2.1 Role-to-Permission Mapping

New file: `apps/api/src/lib/permissions.ts`

```typescript
export type Permission =
  | 'CREATE_SALE'
  | 'PROCESS_PAYMENT'
  | 'APPROVE_EXCHANGE'
  | 'PROCESS_REFUND'
  | 'ADJUST_PRICE'
  | 'MANAGE_INVENTORY'
  | 'VIEW_REPORTS'
  | 'MANAGE_STAFF'
  | 'MANAGE_BRANCH';

export const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  Super_Admin:     ['CREATE_SALE','PROCESS_PAYMENT','APPROVE_EXCHANGE','PROCESS_REFUND',
                    'ADJUST_PRICE','MANAGE_INVENTORY','VIEW_REPORTS','MANAGE_STAFF','MANAGE_BRANCH'],
  Admin:           ['CREATE_SALE','PROCESS_PAYMENT','APPROVE_EXCHANGE','PROCESS_REFUND',
                    'ADJUST_PRICE','MANAGE_INVENTORY','VIEW_REPORTS','MANAGE_STAFF','MANAGE_BRANCH'],
  Manager:         ['CREATE_SALE','PROCESS_PAYMENT','APPROVE_EXCHANGE','PROCESS_REFUND',
                    'ADJUST_PRICE','MANAGE_INVENTORY','VIEW_REPORTS','MANAGE_STAFF'],
  Finance_Officer: ['PROCESS_PAYMENT','PROCESS_REFUND','VIEW_REPORTS'],
  Stock_Clerk:     ['MANAGE_INVENTORY'],
  Sales:           ['CREATE_SALE','PROCESS_PAYMENT'],
  Purchasor:       ['MANAGE_INVENTORY','VIEW_REPORTS'],
};

export function getPermissionsForRoles(roles: string[]): Permission[] {
  const set = new Set<Permission>();
  for (const role of roles) {
    for (const perm of ROLE_PERMISSIONS[role] ?? []) set.add(perm);
  }
  return [...set];
}
```

### 2.2 Updated `requirePermission` Middleware

Updated `apps/api/src/middleware/rbac.ts` — adds `requirePermission` while keeping `requireRole` for backward compatibility:

```typescript
import { Request, Response, NextFunction } from 'express';
import { Role } from '@bms/shared';
import { ForbiddenError } from '../lib/errors.js';
import { Permission, ROLE_PERMISSIONS } from '../lib/permissions.js';

// ── Existing requireRole — kept for backward compatibility ────────────────────
export function requireRole(...allowedRoles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.staff) return next(new ForbiddenError('Authentication required'));
    if (!allowedRoles.includes(req.staff.role)) {
      return next(new ForbiddenError(`Role '${req.staff.role}' is not permitted`));
    }
    next();
  };
}

// ── New requirePermission — checks JWT permissions array ──────────────────────
export function requirePermission(...required: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.staff) return next(new ForbiddenError('Authentication required'));

    // Use permissions array from JWT if present; fall back to role-derived permissions
    const effective: Permission[] = req.staff.permissions?.length
      ? req.staff.permissions as Permission[]
      : ROLE_PERMISSIONS[req.staff.role] ?? [];

    const missing = required.filter(p => !effective.includes(p));
    if (missing.length > 0) {
      return next(new ForbiddenError(
        `Permission denied. Missing: ${missing.join(', ')}`,
        { code: 'PERMISSION_DENIED', missing }
      ));
    }
    next();
  };
}
```

### 2.3 JWT Payload Update

Updated `apps/api/src/modules/auth/auth.service.ts` — login and refresh now include `permissions`:

```typescript
// At login: load all roles for the branch, compute union of permissions
const rolesRes = await db.query(
  'SELECT role FROM staff_branch_roles WHERE staff_id = $1 AND branch_id = $2',
  [staff.id, branchId]
);
const roles = rolesRes.rows.map(r => r.role as string);
const permissions = getPermissionsForRoles(roles);
const primaryRole = roles[0] ?? 'Sales';

const accessToken = jwt.sign(
  { staffId: staff.id, role: primaryRole, branchId, permissions },
  getJwtSecret(),
  { expiresIn: ACCESS_TOKEN_TTL },
);
```

The `role` field is retained for backward compatibility. The `permissions` array is compact (short string codes).

### 2.4 `req.staff` Type Extension

Updated `apps/api/src/middleware/auth.ts` — extend `StaffPayload`:

```typescript
export interface StaffPayload {
  staffId: number;
  role: string;        // primary role (backward compat)
  branchId: number;
  permissions?: string[]; // full permission set (new)
}
```

---

## 3. Order Lifecycle

### 3.1 Status Transitions

```
DRAFT ──confirm──► CONFIRMED ──payment_paid──► PAID ──fulfill──► FULFILLED ──auto──► COMPLETED
  │                    │
  └──cancel──► CANCELLED  └──cancel──► CANCELLED
```

### 3.2 `allowed_actions` Computation

```typescript
function computeOrderAllowedActions(
  status: string,
  permissions: Permission[]
): string[] {
  const can = (p: Permission) => permissions.includes(p);
  switch (status) {
    case 'DRAFT':     return [
      ...(can('CREATE_SALE') ? ['confirm','cancel'] : []),
      'view',
    ];
    case 'CONFIRMED': return [
      ...(can('PROCESS_PAYMENT') ? ['take_payment'] : []),
      ...(can('CREATE_SALE') ? ['cancel'] : []),
      'view',
    ];
    case 'PAID':      return [
      ...(can('PROCESS_PAYMENT') ? ['fulfill'] : []),
      'view',
    ];
    case 'FULFILLED': return ['view'];
    case 'COMPLETED': return ['view','print'];
    case 'CANCELLED': return ['view'];
    default:          return ['view'];
  }
}
```

### 3.3 Service Changes (Additive)

`orders.service.ts` changes:
- `create()`: inserts with `status = 'DRAFT'` instead of `'Pending'`
- `confirm()`: transitions `DRAFT → CONFIRMED`, creates `inventory_reservations` rows
- New `pay()`: transitions `CONFIRMED → PAID` (called by payment webhook/service)
- `fulfill()`: transitions `PAID → FULFILLED`, converts reservations to `deducted`, then auto-transitions to `COMPLETED`
- `cancel()`: handles `DRAFT` (no reservation release) and `CONFIRMED` (releases reservations)
- All responses include `allowedActions` field

### 3.4 Inventory Reservation in `confirm()`

```typescript
// In confirm(), after status update:
for (const item of order.lineItems ?? []) {
  // Check available = quantity - active reservations
  const availRes = await client.query(`
    SELECT i.quantity - COALESCE(SUM(r.quantity),0) AS available
    FROM inventory i
    LEFT JOIN inventory_reservations r
      ON r.book_id = i.book_id AND r.location_id = $2 AND r.status = 'reserved'
    WHERE i.book_id = $1 AND i.location_id = $2
    GROUP BY i.quantity
  `, [item.bookId, locationId]);
  const available = parseFloat(availRes.rows[0]?.available ?? '0');
  if (available < item.quantity) {
    throw new BusinessError('INSUFFICIENT_STOCK', `Insufficient stock for book ${item.bookId}`);
  }
  await client.query(`
    INSERT INTO inventory_reservations (order_id, book_id, location_id, quantity, status)
    VALUES ($1, $2, $3, $4, 'reserved')
  `, [orderId, item.bookId, locationId, item.quantity]);
}
```

---

## 4. Exchange Lifecycle

### 4.1 Status Transitions

```
INITIATED ──review──► REVIEWED ──approve──► APPROVED ──settle──► SETTLED ──auto──► COMPLETED
    │                     │                     │
    └──cancel──► CANCELLED └──cancel──► CANCELLED └──cancel──► CANCELLED
```

### 4.2 Service Architecture

The existing `createExchange()` function (single-step, immediately completes) is **kept intact** for backward compatibility. New lifecycle functions are added alongside it:

- `initiateExchange()` — creates with `lifecycle_status = 'INITIATED'`
- `reviewExchange()` — transitions to `REVIEWED`, computes difference
- `approveExchange()` — transitions to `APPROVED`, locks values
- `settleExchange()` — validates settlement entries, applies inventory + finance atomically, transitions to `SETTLED` then `COMPLETED`
- `cancelExchange()` — extended to check `lifecycle_status`

### 4.3 Settlement Validation

```typescript
function validateSettlementEntries(
  entries: SettlementEntry[],
  difference: number  // positive = customer pays, negative = store refunds
): void {
  const sum = entries.reduce((acc, e) => {
    if (e.entryType === 'cash_payment')         return acc + e.amount;
    if (e.entryType === 'cash_refund')          return acc - e.amount;
    if (e.entryType === 'item_value_adjustment') return acc + e.amount; // signed
    return acc;
  }, 0);
  if (Math.abs(sum - difference) > 0.01) {
    throw new BusinessError('SETTLEMENT_UNBALANCED',
      `Settlement entries sum to ${sum.toFixed(2)} but difference is ${difference.toFixed(2)}`
    );
  }
}
```

### 4.4 Atomic Settlement in `settleExchange()`

```
BEGIN TRANSACTION
  1. Validate settlement entries balance
  2. Check idempotency key
  3. For each returned item (condition=resellable): increase inventory.quantity
  4. For each returned item (condition=damaged): increase inventory.damaged_quantity
  5. For each new item: decrease inventory.quantity (check available >= quantity)
  6. Insert inventory_history rows
  7. Insert exchange_settlement_entries rows
  8. Insert financial_transactions rows (one per cash entry)
  9. UPDATE exchanges SET lifecycle_status = 'SETTLED'
  10. UPDATE exchanges SET lifecycle_status = 'COMPLETED'
  11. Insert audit_log entries
  12. Insert outbox events
COMMIT
```

### 4.5 `allowed_actions` for Exchanges

```typescript
function computeExchangeAllowedActions(
  status: string,
  permissions: Permission[]
): string[] {
  const can = (p: Permission) => permissions.includes(p);
  switch (status) {
    case 'INITIATED': return [
      ...(can('APPROVE_EXCHANGE') ? ['review','cancel'] : []),
      ...(can('CREATE_SALE') ? ['cancel'] : []),
      'view',
    ];
    case 'REVIEWED':  return [
      ...(can('APPROVE_EXCHANGE') ? ['approve','adjust','cancel'] : []),
      'view',
    ];
    case 'APPROVED':  return [
      ...(can('APPROVE_EXCHANGE') ? ['settle','cancel'] : []),
      'view',
    ];
    case 'SETTLED':   return ['view'];
    case 'COMPLETED': return ['view','print'];
    case 'CANCELLED': return ['view'];
    default:          return ['view'];
  }
}
```

---

## 5. Financial Transactions

### 5.1 `financial_transactions` Table

The new `financial_transactions` table sits alongside the existing `payments` table. Existing payment endpoints are unchanged. New order/exchange finance flows write to `financial_transactions`.

Every record MUST have either `order_id` or `exchange_id` (enforced by DB constraint).

### 5.2 Idempotency

All payment and settlement endpoints accept an `Idempotency-Key` header. The existing `withIdempotency()` helper in `apps/api/src/lib/idempotency.ts` is used unchanged. The `financial_transactions.idempotency_key` column provides a second layer of deduplication at the DB level via the `UNIQUE` constraint.

---

## 6. API Route Changes

### 6.1 Orders Routes (Additive)

```
POST   /api/orders                    → create (status=DRAFT)
POST   /api/orders/:id/confirm        → confirm (DRAFT→CONFIRMED) [requirePermission('CREATE_SALE')]
POST   /api/orders/:id/fulfill        → fulfill (PAID→FULFILLED→COMPLETED) [requirePermission('PROCESS_PAYMENT')]
POST   /api/orders/:id/cancel         → cancel [requirePermission('CREATE_SALE')]
GET    /api/orders/:id                → includes allowedActions[]
```

Existing routes (`/progress`, etc.) remain and continue to work.

### 6.2 Exchange Routes (Additive)

```
POST   /api/exchanges/initiate        → initiateExchange [requirePermission('CREATE_SALE')]
POST   /api/exchanges/:id/review      → reviewExchange [requirePermission('APPROVE_EXCHANGE')]
POST   /api/exchanges/:id/approve     → approveExchange [requirePermission('APPROVE_EXCHANGE')]
POST   /api/exchanges/:id/settle      → settleExchange [requirePermission('APPROVE_EXCHANGE')]
POST   /api/exchanges/:id/cancel      → cancelExchange [requirePermission('APPROVE_EXCHANGE')]
GET    /api/exchanges/:id             → includes allowedActions[]
```

Existing `POST /api/exchanges` (single-step) remains unchanged.

### 6.3 Financial Transactions Routes (New)

```
POST   /api/financial-transactions    → create [requirePermission('PROCESS_PAYMENT')]
GET    /api/financial-transactions    → list [requirePermission('VIEW_REPORTS')]
```

---

## 7. Multi-Branch `is_all_branches`

### 7.1 Branch Context Middleware

Updated `apps/api/src/middleware/branchCtx.ts`:

```typescript
// If staff.is_all_branches = true AND request includes ?branchId=X, use X
// If staff.is_all_branches = true AND no branchId param, allow all-branch queries
// Otherwise, enforce req.staff.branchId
```

### 7.2 Report Filters

All report endpoints accept an optional `branchId` query param. When `is_all_branches = true` and `branchId` is omitted, the query runs across all branches.

---

## 8. POS Stock Visibility

### 8.1 Available Stock in Book Search

The catalog `searchBooks()` function already returns `stock_quantity`. The query is updated to subtract active reservations:

```sql
(
  SELECT COALESCE(SUM(inv.quantity), 0)
       - COALESCE(SUM(res.quantity), 0)
  FROM inventory inv
  LEFT JOIN inventory_reservations res
    ON res.book_id = inv.book_id
    AND res.location_id = inv.location_id
    AND res.status = 'reserved'
  WHERE inv.book_id = b.id
    AND CASE
      WHEN $locParam::integer IS NOT NULL THEN inv.location_id = $locParam::integer
      WHEN $branchParam::integer IS NOT NULL THEN inv.location_id IN (
        SELECT id FROM locations WHERE branch_id = $branchParam::integer
      )
      ELSE false
    END
) AS stock_quantity
```

---

## 9. Frontend Changes

### 9.1 OrdersPage

- Replace status badges with lifecycle-aware action buttons driven by `allowedActions`
- Show `DRAFT / CONFIRMED / PAID / FULFILLED / COMPLETED / CANCELLED` labels
- Action buttons: Confirm, Take Payment, Fulfill, Cancel, Print

### 9.2 ExchangesPage

- New multi-step form: Initiate → Review → Approve → Settle
- Settlement form: multi-entry with entry_type selector, amount, method, note
- Show `allowed_actions` buttons per exchange row
- Returned item condition selector: Resellable / Damaged

### 9.3 POSPage

- Stock quantity shown under each book (already partially implemented)
- Show "Out of stock" badge when available = 0

### 9.4 Auth / JWT

- `apps/web/src/lib/auth.ts` — `restoreSession()` already parses `branchId` from JWT; extend to also read `permissions` array
- Store `permissions` in app state alongside `userRole`
- Pass `permissions` to pages that need fine-grained action visibility

---

## 10. Correctness Properties (Property-Based Testing)

The following properties MUST hold and SHALL be validated by property-based tests:

1. **Order status monotonicity**: An order's status can only advance forward in the state machine or move to CANCELLED. It can never go backward (e.g., COMPLETED → PAID).
2. **Inventory conservation**: For any order, `SUM(reservations.quantity WHERE status='deducted') = SUM(inventory_history.delta WHERE reference_type='order' AND reference_id=order_id)`.
3. **Settlement balance**: For any settled exchange, `SUM(settlement_entries.amount * sign) = exchange.net_balance` within ETB 0.01.
4. **Financial traceability**: Every `financial_transactions` row has either `order_id IS NOT NULL` or `exchange_id IS NOT NULL`.
5. **Idempotency**: Submitting the same `idempotency_key` twice produces the same response and exactly one `financial_transactions` row.
6. **Permission union**: A staff member with roles A and B has `permissions(A) ∪ permissions(B)` — never a subset.
7. **Reservation availability**: `available_stock = inventory.quantity - SUM(reservations.quantity WHERE status='reserved')` is always ≥ 0 after any confirm operation.

---

## 11. Multi-Role / Multi-Branch Auth Refactor (May 2026)

### 11.1 Overview

The authentication model was refactored to align with industry-standard ERP practice (SAP-like permission aggregation). The key principle: **no profile switching, no role switching** — permissions are always the union of all roles assigned to the staff member for their active branch.

### 11.2 New API Endpoints

```
POST  /api/auth/pre-login      — Step 1: validate credentials, return available branches
GET   /api/auth/branches       — Return branches for authenticated user (branch switcher)
POST  /api/auth/switch-branch  — Issue new access token for a different branch
```

`/api/auth/pre-login` is exempt from CSRF validation (called before any session cookie exists).

### 11.3 Updated JWT Payload

```typescript
interface JwtPayload {
  staffId:     number;
  role:        string;    // primary role (backward compat — first role by ID)
  roles:       string[];  // ALL roles for the active branch (new)
  branchId:    number;
  permissions: string[];  // union of all role permissions for the branch
}
```

### 11.4 Two-Step Login Flow

```
Step 1: POST /api/auth/pre-login
  ← { staffId, branches: [{ branchId, branchName, roles, isAllBranches }], autoSelectBranchId }

  If autoSelectBranchId is set → skip step 2, call login directly
  If multiple branches → show branch picker UI

Step 2: POST /api/auth/login
  → { username, password, branchId }
  ← { accessToken, expiresIn, mustChangePassword, csrfToken }
```

### 11.5 Branch Switcher

After login, the top navigation bar shows a branch dropdown. On selection:
1. `POST /api/auth/switch-branch { branchId }` → new access token
2. Frontend updates `accessToken`, `currentBranchId`, `userRole`, `userRoles`, `userPermissions`
3. All React Query caches are invalidated (`queryClient.invalidateQueries()`)
4. Landing page is re-applied based on new role context

### 11.6 `is_all_branches` Staff

Staff with `is_all_branches = true`:
- See all active branches in the login picker and branch switcher
- Can access any branch's data without a per-branch role assignment
- `branchCtx` middleware skips role assignment check for these staff
- Admin and Super_Admin have `is_all_branches = true` by default (set in seed + migration 34)

### 11.7 Permission-Based Form Visibility

All form visibility gates use `userPermissions` (the union array) rather than a single role name:

```typescript
// Before (broken for multi-role users):
const canCreate = (r?: Role) => ['Sales', 'Manager', 'Admin'].includes(r ?? '');

// After (correct for multi-role users):
const canCreate = (r?: Role, perms?: string[]) =>
  (perms && perms.includes('CREATE_SALE')) ||
  ['Sales', 'Manager', 'Admin', 'Super_Admin'].includes(r ?? '');
```

This ensures a user with `Stock_Clerk + Sales` roles sees the New Order and Exchange forms because they hold `CREATE_SALE` in their permission union.

### 11.8 Staff Management: All Branches Flag

New endpoint: `PUT /api/staff/:id/all-branches { isAllBranches: boolean }`

- Only Admin/Super_Admin can call this
- Sets `staff.is_all_branches` column
- Writes audit log entry
- Frontend: 🌐 toggle button in staff list actions column; amber badge in branch column

### 11.9 Catalog Stock Query Fix

The `searchBooks()` stock_quantity subquery had missing `$` prefixes on parameter placeholders:

```sql
-- Before (invalid SQL — embeds raw number):
WHEN ${locParam}::integer IS NOT NULL THEN ...

-- After (correct PostgreSQL parameterized query):
WHEN $${locParam}::integer IS NOT NULL THEN ...
```

Both the `inventory_reservations` and `inventory` subqueries are now correctly parameterized.

### 11.10 Session Persistence

- Refresh token cookie: `maxAge = 8 hours` (covers a full work shift)
- `restoreSession()` always attempts silent token refresh on app load
- No `sessionStorage` gate — the refresh token cookie is the sole source of truth
- Inactivity timer: 15 minutes idle → 1-minute warning → auto-logout
