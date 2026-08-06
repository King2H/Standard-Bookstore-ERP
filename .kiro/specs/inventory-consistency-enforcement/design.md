# Inventory Consistency Enforcement — Bugfix Design

## Overview

The ERP system currently allows every module (POS, Orders, Procurement, Returns,
Exchanges, and the Inventory module's own direct API endpoints) to write
`UPDATE inventory SET quantity = ...` directly, each with its own ad-hoc availability
check. This produces silent divergence: a confirmed order's reservation is invisible to
the POS, a procurement receipt bypasses notification hooks, and audit records are
incomplete or structurally inconsistent across modules.

The fix introduces a single `InventoryTransactionService` in
`apps/api/src/modules/inventory/inventoryTransaction.service.ts` that is the **only**
code path permitted to issue `UPDATE inventory SET quantity = ...`. Every calling module
replaces its inline SQL with a call to one of four methods: `deductStock`, `addStock`,
`adjustStock`, or `transferStock`. The service enforces reservation-aware availability,
row-level `SELECT FOR UPDATE` locking, complete `inventory_history` records, and
non-fatal notification hooks uniformly for all callers.

---

## Glossary

- **Bug_Condition (C)**: `X.usedCentralizedService = false` for any inventory mutation
  originating from `pos.service`, `orders.service`, `procurement.service`,
  `returns.service`, `exchanges.service`, or the inline paths inside `inventory.service`.
- **Property (P)**: After the fix, every inventory mutation produces
  `qty_after = qty_before ± delta`, with `available ≥ requested` validated under lock,
  and a complete `inventory_history` record persisted in the same transaction.
- **Preservation**: All non-inventory behaviors (payment flow, loyalty, store credit,
  receivables, optimistic-locking API contracts, graceful degradation when migration 33
  has not run) must remain byte-for-byte equivalent.
- **InventoryTransactionService**: The new module at
  `apps/api/src/modules/inventory/inventoryTransaction.service.ts`.
- **available_quantity**: `inventory.quantity - SUM(inventory_reservations.quantity WHERE
  status = 'reserved' AND book_id = X AND location_id = Y)`. Used for all deduction
  checks.
- **SELECT FOR UPDATE**: PostgreSQL advisory row lock acquired before reading
  `inventory.quantity` to prevent concurrent oversell within a single DB transaction.
- **Optimistic locking (version)**: The `inventory.version` INTEGER column incremented on
  every mutation. Used by API-facing callers (`stockIn`, `stockOut`, `adjustStock`,
  `transferStock`) to detect mid-flight concurrent modifications.
- **inventory_reservations**: Table introduced in migration 1700000033 that tracks soft
  reservations created at order confirmation and released/promoted at fulfillment or
  cancellation.
- **movement_type**: One of `stock_in | stock_out | transfer_in | transfer_out |
  adjustment` — stored in `inventory_history`.
- **reference_type**: One of the values whitelisted by the DB CHECK constraint (last
  extended in migration 1700000037): `purchase_order`, `return`, `adjustment`, `manual`,
  `initial_stock`, `sale`, `void`, `pos_return`, `order`, `exchange_in`, `exchange_out`,
  `exchange_damaged`, `order_confirmed`, `order_cancelled`. A new value `transfer` will
  be added via a new migration to support `transferStock` reference traceability.

---

## Bug Details

### Bug Condition

The bug manifests whenever an inventory mutation is issued from outside the centralized
service. The calling service reads `inventory.quantity` (possibly without subtracting
active reservations), constructs its own `UPDATE`, and writes its own `inventory_history`
record — each with slightly different field conventions.

**Formal Specification:**

```
FUNCTION isBugCondition(X)
  INPUT: X of type InventoryMutation
  OUTPUT: boolean

  RETURN X.caller IN (
    'pos.service.createTransaction',          -- line ~556: direct UPDATE inventory
    'orders.service.confirm',                 -- line ~361: direct UPDATE inventory
    'orders.service.cancel',                  -- line ~430+: direct UPDATE inventory
    'procurement.service.receivePO',          -- line ~618+: inline stock-in
    'returns.service.createReturn',           -- line ~96+: direct UPDATE inventory
    'exchanges.service.createExchange',       -- line ~311+: direct UPDATE inventory
    'exchanges.service.settleExchange',       -- line ~490+: direct UPDATE inventory
    'inventory.service.stockIn',              -- inline UPDATE (duplicates central logic)
    'inventory.service.stockOut',             -- inline UPDATE (skips reservation check)
    'inventory.service.adjustStock',          -- inline UPDATE (missing ref fields)
    'inventory.service.transferStock'         -- inline UPDATE (skips reservation check)
  )
  AND X.usedCentralizedService = false
END FUNCTION
```

### Examples

- **POS oversell**: Location "Main Shop" has `quantity = 3`, and order #42 has already
  reserved 2 units (status = 'reserved'). `available = 1`. A POS cashier attempts to
  sell 2 units. Current behavior: POS reads raw `quantity = 3`, check passes, sale goes
  through. Correct behavior: available check = 1, sale rejected with `INSUFFICIENT_STOCK`.

- **Double-deduction guard**: Order confirmed (stock deducted to 5), then fulfilled.
  Current behavior at fulfillment: `qty_fulfilled` updated, reservations marked
  'deducted'. Correct behavior: NO second deduction. The current orders path is already
  fixed for this, but the centralized service makes this guarantee structural.

- **Incomplete audit record**: `procurement.service.receivePO` writes
  `inventory_history` with `reason_code = 'stock_in'` but without `movement_type`
  passed to the insert (uses a positional INSERT that includes it). However
  `reference_type = 'purchase_order'` is set only on the inline path; if routed through
  `inventory.service.stockIn`, that function requires the caller to explicitly pass
  `referenceType`. Correct behavior: centralized service enforces all fields at compile
  time via its typed interface.

- **adjustStock missing reference fields**: Any call to `adjustStock` always persists
  `reference_type = NULL`, `reference_id = NULL`. This makes damage/loss adjustments
  untraceable. Correct behavior: centralized `adjustStock` accepts and persists
  `referenceType` and `referenceId`.

---

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**

- POS `createTransaction` payment flow (store credit deduction, loyalty accrual, credit
  sale receivable, outbox events) must remain identical; only the inventory deduction
  lines are replaced.
- Orders `confirm` / `fulfill` / `cancel` lifecycle transitions, receivable creation,
  and outbox events remain unchanged; only inventory mutations are delegated.
- `stockIn` and `stockOut` continue to accept the same HTTP request shape
  (`/inventory/stock-in`, `/inventory/stock-out`) and return the same `InventoryRow`
  response. Optimistic locking contract (`version` required, `VERSION_CONFLICT` thrown)
  is preserved.
- `adjustStock` and `transferStock` continue to require `version`, enforce same-branch
  validation (transfers), reject zero-delta (adjustments), and emit outbox events
  non-fatally.
- Graceful degradation: when `inventory_reservations` table does not exist (migration 33
  not applied), all paths fall back to raw `inventory.quantity` for availability checks,
  exactly as they do today.
- Negative-stock config (`isNegativeStockAllowed()`) continues to be respected by all
  deduction paths.
- `inventory_history.reference_type` CHECK constraint values already whitelisted in
  migrations 1700000017 → 1700000037 are not changed.

**Scope:**

All inputs that do NOT involve `inventory.quantity` mutations (reads, order number
generation, customer lookups, payment processing, loyalty, receivables, audit logs) are
completely unaffected by this fix.

---

## Hypothesized Root Cause

Based on reading the source files, the root causes are structural:

1. **No shared mutation layer**: Each module was written independently. `pos.service.ts`
   (~line 556), `orders.service.ts` (~line 361), `returns.service.ts` (~line 96),
   `exchanges.service.ts` (~line 311 and ~490), and `procurement.service.ts` (~line 618)
   each contain their own `UPDATE inventory SET quantity = ...` and their own
   `INSERT INTO inventory_history ...` with slightly different column sets.

2. **POS ignores reservations**: `pos.service.createTransaction` acquires
   `SELECT FOR UPDATE` on the inventory row, then checks `qtyBefore < item.quantity`
   against raw `quantity` without subtracting `SUM(inventory_reservations.quantity WHERE
   status = 'reserved')`. This is the direct cause of the POS/Orders oversell window.

3. **`inventory.service.stockOut` ignores reservations**: `stockOut` pre-checks
   `available = inventory.quantity` directly (~line 730 in inventory.service.ts), not
   calling `getAvailableStock()`, so manual stock-out via the API can consume reserved
   units.

4. **`adjustStock` / `transferStock` omit reference fields**: Both functions hardcode
   `reference_type = null` and `reference_id = null` in their `inventory_history`
   INSERT, making corrections and transfers untraceable to source documents.

5. **`transferStock` skips reservation check on source**: It locks the source row
   (`SELECT FOR UPDATE`) and checks `srcQty >= quantity`, but does not subtract active
   reservations, so a transfer can remove stock already soft-reserved for a confirmed
   order at the source location.

---

## Correctness Properties

Property 1: Bug Condition — All Mutations Route Through Centralized Service

_For any_ inventory mutation X where `isBugCondition(X)` holds (i.e., the calling module
previously wrote `UPDATE inventory SET quantity = ...` directly), the fixed code SHALL
route that mutation through `InventoryTransactionService`, resulting in:
- `qty_after = qty_before - delta` (deduction) or `qty_before + delta` (addition)
- `available = qty_before - active_reservations >= requested_quantity` (deductions only)
- a complete `inventory_history` row with all 9 required fields non-null
- `inventory.version` incremented by exactly 1

**Validates: Requirements 2.1, 2.2, 2.3, 2.14**

Property 2: Preservation — Non-Inventory Behaviors Unchanged

_For any_ system action X where `isBugCondition(X)` does NOT hold (DRAFT order creation,
payment recording, loyalty accrual, receivable creation, `adjustStock` / `transferStock`
API calls with valid version, etc.), the fixed code SHALL produce the same observable
result as the original code: same HTTP response shape, same DB rows written for
non-inventory tables, same outbox events emitted, same error codes thrown.

**Validates: Requirements 3.1, 3.3, 3.4, 3.5, 3.6, 3.8, 3.9, 3.13, 3.14, 3.15, 3.16**

Property 3: Consistency Scenario — POS Cannot Oversell Reserved Stock

_For any_ concurrent scenario where `active_reservations(book_id, location_id) > 0` and
a POS transaction requests `quantity > available`, the fixed `createTransaction` SHALL
throw `BusinessError('INSUFFICIENT_STOCK', ...)` before committing any DB change.

**Validates: Requirements 2.2, 2.3, 2.4**

Property 4: Consistency Scenario — Order Lifecycle Inventory Accounting

_For any_ order that transitions DRAFT → CONFIRMED → FULFILLED → (optionally) CANCELLED,
the net inventory impact SHALL be:
- DRAFT create: `Δ = 0`
- CONFIRMED: `Δ = -quantity` (deducted once)
- FULFILLED: `Δ = 0` additional (no second deduction)
- CANCELLED after CONFIRMED: `Δ = +quantity` (restored exactly once)

**Validates: Requirements 2.5, 2.6, 2.7, 2.8**

Property 5: Consistency Scenario — inventory_history Completeness

_For any_ inventory mutation routed through the centralized service, the persisted
`inventory_history` row SHALL have non-null values for `book_id`, `location_id`,
`qty_before`, `qty_after`, `delta`, `movement_type`, `reason_code`, `reference_type`,
`reference_id`, and `staff_id`.

**Validates: Requirements 2.14, 2.21, 2.22**

---

## Fix Implementation

### New File

**`apps/api/src/modules/inventory/inventoryTransaction.service.ts`**

This file exports four functions. All four accept a `pg.PoolClient` so they can
participate in the caller's existing transaction.

```typescript
// Core interface — callers pass their already-open client
// so the mutation is atomic with the surrounding business logic.

export interface DeductStockInput {
  client: pg.PoolClient;
  bookId: number;
  locationId: number;
  quantity: number;           // positive
  movementType: 'stock_out';
  referenceType: string;      // e.g. 'sale', 'order_confirmed', 'exchange_out'
  referenceId: string | number;
  notes?: string | null;
  staffId: number;
}

export interface AddStockInput {
  client: pg.PoolClient;
  bookId: number;
  locationId: number;
  quantity: number;           // positive
  movementType: 'stock_in';
  referenceType: string;      // e.g. 'purchase_order', 'pos_return', 'exchange_in', 'order_cancelled'
  referenceId: string | number;
  notes?: string | null;
  staffId: number;
}

export interface AdjustStockInput {
  client: pg.PoolClient;
  bookId: number;
  locationId: number;
  delta: number;              // positive or negative
  reasonCode: ReasonCode;     // 'damage' | 'loss' | 'return' | 'correction'
  referenceType?: string | null;
  referenceId?: number | null;
  notes?: string | null;
  version: number;            // optimistic lock token
  staffId: number;
}

export interface TransferStockInput {
  client: pg.PoolClient;
  bookId: number;
  fromLocationId: number;
  toLocationId: number;
  quantity: number;           // positive
  fromVersion: number;        // optimistic lock token for source row
  transferBatchId: string;    // caller-generated ID for pairing history rows
  staffId: number;
}
```

**`deductStock(input: DeductStockInput): Promise<void>`**

1. `SELECT quantity, version FROM inventory WHERE book_id = $1 AND location_id = $2 FOR UPDATE`
2. `SELECT COALESCE(SUM(quantity), 0) FROM inventory_reservations WHERE book_id = $1 AND location_id = $2 AND status = 'reserved'` (skip if table absent — feature flag)
3. `available = quantity - reserved`. If `available < input.quantity` → throw `BusinessError('INSUFFICIENT_STOCK', ...)`
4. `UPDATE inventory SET quantity = quantity - $delta, version = version + 1, updated_at = now() WHERE book_id = $1 AND location_id = $2`
5. `INSERT INTO inventory_history (book_id, location_id, qty_before, qty_after, delta, movement_type, reason_code, reference_type, reference_id, notes, staff_id) VALUES (...)`

**`addStock(input: AddStockInput): Promise<void>`**

1. `INSERT INTO inventory ... ON CONFLICT DO NOTHING` (ensure row exists)
2. `SELECT quantity, version FROM inventory ... FOR UPDATE`
3. `UPDATE inventory SET quantity = quantity + $delta, version = version + 1, ...`
4. `INSERT INTO inventory_history ...`

**`adjustStock(input: AdjustStockInput): Promise<void>`**

Delegates to deductStock or addStock after the version check, or performs the UPDATE
directly with `WHERE version = $version` (CAS update). Accepts optional `referenceType`
and `referenceId` and passes them through to `inventory_history`.

**`transferStock(input: TransferStockInput): Promise<void>`**

1. Lock both rows (lower `location_id` first).
2. Read source. If `srcVersion !== input.fromVersion` → `ConflictError('VERSION_CONFLICT')`.
3. Compute `source_available = srcQty - SUM(active reservations at fromLocationId)`. If `< quantity` → throw `INSUFFICIENT_STOCK`.
4. Deduct source, add to destination.
5. Two `inventory_history` rows: `movement_type = 'transfer_out'` / `'transfer_in'`, both with `reference_type = 'transfer'` and `reference_id = transferBatchId`.

### Changes to Existing Files

**`apps/api/src/modules/pos/pos.service.ts`**

Replace the inline inventory block (~lines 556–571):
```typescript
// BEFORE: direct UPDATE + INSERT inventory_history
// AFTER:
await deductStock({
  client,
  bookId: item.bookId,
  locationId: data.locationId,
  quantity: item.quantity,
  movementType: 'stock_out',
  referenceType: 'sale',
  referenceId: txId,
  staffId: staffCtx.staffId,
});
```
Remove the manual `invSnapshots` array and `FOR UPDATE` block — `deductStock` handles
locking internally. The availability check now automatically subtracts reservations.

**`apps/api/src/modules/orders/orders.service.ts`**

`confirm()` (~line 340–400): Replace the per-line `SELECT FOR UPDATE` + `UPDATE
inventory` + `INSERT inventory_history` block with:
```typescript
await deductStock({
  client, bookId: item.bookId, locationId,
  quantity: item.quantity, movementType: 'stock_out',
  referenceType: 'order_confirmed', referenceId: orderId,
  notes: `Order confirmation – order ${String(orderId)}`,
  staffId: staffCtx.staffId,
});
```
The existing `inventory_reservations` INSERT and `qty_reserved` UPDATE remain unchanged.

`cancel()` (~line 430–480): Replace the restore block with:
```typescript
await addStock({
  client, bookId: item.bookId, locationId,
  quantity: item.qtyReserved, movementType: 'stock_in',
  referenceType: 'order_cancelled', referenceId: orderId,
  staffId: staffCtx.staffId,
});
```

**`apps/api/src/modules/procurement/procurement.service.ts`**

`receivePO()` (~line 618–650): Replace the inline `INSERT INTO inventory ON CONFLICT DO
NOTHING` + `SELECT FOR UPDATE` + `UPDATE inventory` + `INSERT INTO inventory_history`
block with:
```typescript
await addStock({
  client, bookId, locationId: effectiveLocationId,
  quantity: item.quantityReceived, movementType: 'stock_in',
  referenceType: 'purchase_order', referenceId: String(id),
  staffId: staffCtx.staffId,
});
```

**`apps/api/src/modules/returns/returns.service.ts`**

`createReturn()` (~line 96): Replace the `SELECT quantity FROM inventory FOR UPDATE` +
`UPDATE inventory` + `INSERT inventory_history` block with:
```typescript
await addStock({
  client, bookId: line.bookId, locationId,
  quantity: line.quantity, movementType: 'stock_in',
  referenceType: 'pos_return', referenceId: String(data.transactionId),
  notes: `Return of ${line.quantity} unit(s)`,
  staffId: staffCtx.staffId,
});
```

**`apps/api/src/modules/exchanges/exchanges.service.ts`**

`createExchange()` inventory block (~lines 311–335): Replaced with `addStock` for
incoming items (referenceType = `'exchange_in'`) and `deductStock` for outgoing items
(referenceType = `'exchange_out'`).

`settleExchange()` inventory block (~line 490+): Same pattern — `addStock` for
resellable returned items, `deductStock` for new items being handed out.

**`apps/api/src/modules/inventory/inventory.service.ts`**

- `stockIn`: After the optimistic lock check, replace the inline `UPDATE inventory` +
  `INSERT inventory_history` with `addStock({ client, ..., referenceType, referenceId })`.
- `stockOut`: Replace availability pre-check and inline `UPDATE` with `deductStock`.
  The pre-check now uses `available = quantity - active_reservations`.
- `adjustStock`: Delegate to the centralized `adjustStock` (pass through `referenceType`
  and `referenceId` from the new optional input fields).
- `transferStock`: Delegate to the centralized `transferStock`, passing a
  `transferBatchId = crypto.randomUUID()` generated by the caller.

### New Migration

**`apps/api/src/db/migrations/1700000039_inventory_transfer_reference_type.cjs`**

Extends the `inventory_history_reference_type_check` constraint to include `'transfer'`:

```sql
ALTER TABLE inventory_history
  DROP CONSTRAINT IF EXISTS inventory_history_reference_type_check;
ALTER TABLE inventory_history
  ADD CONSTRAINT inventory_history_reference_type_check
  CHECK (reference_type IS NULL OR reference_type IN (
    'purchase_order', 'return', 'adjustment', 'manual', 'initial_stock',
    'sale', 'void', 'pos_return', 'order',
    'exchange_in', 'exchange_out', 'exchange_damaged',
    'order_confirmed', 'order_cancelled',
    'transfer'
  ));
```

---

## Testing Strategy

### Validation Approach

The testing strategy is two-phased: first write exploratory tests that exercise the bug
condition on the **unfixed** code to confirm the root causes, then write fix-checking and
preservation-checking tests to gate the final implementation.

### Exploratory Bug Condition Checking

**Goal**: Surface concrete counterexamples demonstrating each consistency failure on the
unfixed code. Confirm or refute the hypothesized root causes.

**Test Plan**: Write unit/integration tests that directly call the unfixed service
functions and assert the broken behavior. If a test does NOT fail on unfixed code, the
root cause hypothesis for that scenario must be re-evaluated.

**Test Cases**:

1. **POS Oversell (Reservation Blind Spot)**: Set `inventory.quantity = 3`,
   insert an `inventory_reservations` row for 2 units (`status = 'reserved'`). Call
   `createTransaction` requesting 2 units. On unfixed code the check passes (3 ≥ 2).
   Expected counterexample: sale completes, available stock is now -1 in effect.

2. **Incomplete inventory_history Record**: Call `adjustStock` with a valid delta and
   reason. On unfixed code: query `inventory_history` and assert `reference_type IS
   NULL`. Expected counterexample: field is null for every adjustment record.

3. **Transfer Ignores Source Reservations**: Set source `quantity = 5`, active
   reservations = 4 (available = 1). Call `transferStock(quantity = 3)`. On unfixed code
   the check `srcQty(5) >= 3` passes. Expected counterexample: transfer succeeds, the 4
   reserved units now have only 2 backing them in inventory.

4. **Procurement Inline Stock-In Bypasses Hooks**: Receive a PO receipt via `receivePO`.
   On unfixed code, assert that no outbox event for `inventory.stock_in` is emitted
   (because the inline path doesn't call `insertOutbox` for inventory). Expected
   counterexample: outbox table has no `inventory.stock_in` row.

5. **stockOut Ignores Reservations**: Set `quantity = 2`, reservations = 2
   (available = 0). Call `stockOut(quantity = 1)` via the Inventory API. On unfixed code
   the pre-check reads raw `quantity = 2 ≥ 1`, passes. Expected counterexample: stock-out
   succeeds, consuming a reserved unit.

**Expected Counterexamples**:
- Tests 1 and 5: availability check reads raw `quantity` instead of
  `quantity - active_reservations`.
- Test 2: `adjustStock` passes `null` for both `reference_type` and `reference_id` in
  the INSERT.
- Test 3: `transferStock` availability check does not subtract reservations.
- Test 4: inline procurement path does not call `insertOutbox` for `inventory.stock_in`.

### Fix Checking

**Goal**: Verify that for all inputs where `isBugCondition(X)` holds, the fixed function
produces the expected behavior.

**Pseudocode:**

```
FOR ALL X WHERE isBugCondition(X) DO
  result := fixedFunction(X)
  ASSERT qty_after = qty_before - delta          // deductions
  ASSERT qty_after = qty_before + delta          // additions
  ASSERT available >= requested_before_deduction
  ASSERT inventoryHistoryRowExists(X, allFieldsNonNull = true)
  ASSERT inventory.version = version_before + 1
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where `isBugCondition(X)` does NOT hold, the fixed
functions produce the same result as the original functions.

**Pseudocode:**

```
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT fixedFunction(X) = originalFunction(X)
END FOR
```

**Testing Approach**: Property-based testing with `fast-check` is strongly recommended
for the preservation suite because it:
- Generates hundreds of random order line-up configurations and payment combinations
  automatically
- Catches edge cases in discount/tax calculation that manual test authors might miss
- Provides strong guarantees over the entire non-buggy input domain

**Test Plan**: Run the full existing test suite on both unfixed and fixed code; assert
no regressions. Then add property-based tests for the 5 consistency scenarios.

**Test Cases**:

1. **Payment Flow Preservation**: For any valid POS sale (random items, prices,
   payment methods), assert that `transaction`, `transaction_line_items`,
   `transaction_payments`, and `audit_logs` rows are identical before and after
   replacing inline inventory SQL with `deductStock`. Verify `pos.sale_completed`
   outbox event is still emitted.

2. **Order Lifecycle Preservation**: For any DRAFT → CONFIRMED → FULFILLED sequence,
   assert no double-deduction: `SUM(abs(delta)) from inventory_history WHERE
   reference_type = 'order_confirmed' AND reference_id = orderId` = total ordered
   quantity. Verify FULFILLED transition writes zero inventory_history rows.

3. **Optimistic Locking Preservation (`stockIn` / `stockOut` / `adjustStock`)**: For
   any call with a stale `version`, assert `VERSION_CONFLICT` is still thrown. For any
   call with the correct `version`, assert the response shape is identical to the current
   implementation.

4. **DRAFT Order Zero-Impact Preservation**: For any order created in DRAFT status,
   assert `inventory.quantity` is unchanged and no `inventory_history` row exists for
   that order.

5. **Negative-Stock Policy Preservation**: When `isNegativeStockAllowed() = true`, for
   any deduction that would produce a negative quantity, assert the operation still
   succeeds and `inventory.quantity` is clamped to 0.

### Unit Tests

Location: `apps/api/src/modules/inventory/__tests__/inventoryTransaction.service.test.ts`

- `deductStock` — happy path, INSUFFICIENT_STOCK, VERSION_CONFLICT (not applicable for
  internal calls), missing inventory row
- `addStock` — happy path, row auto-creation, history field completeness
- `adjustStock` — zero delta rejection, version mismatch, referenceType/referenceId
  persistence
- `transferStock` — cross-branch rejection, deadlock-safe lock ordering, reservation
  check on source, paired history row `reference_id` matches

### Property-Based Tests

Location: `apps/api/src/modules/inventory/__tests__/inventoryTransaction.pbt.test.ts`

Using `fast-check`:

- **Property 1 (Bug Condition)**: For any `(bookId, locationId, quantity, reservations)`
  where `available = quantity - reservations`, assert that `deductStock(request ≤
  available)` always succeeds and `deductStock(request > available)` always throws
  `INSUFFICIENT_STOCK`.

- **Property 2 (Preservation — payment flow)**: For any random valid POS transaction
  input, assert that payment records, loyalty events, and receivable rows are identical
  whether inventory is updated via the old inline path or the new `deductStock` call
  (mock the DB layer, compare side-effects).

- **Property 3 (Order lifecycle delta)**: For any sequence of DRAFT → CONFIRMED →
  FULFILLED, generate random line-item quantities. Assert net inventory delta after
  FULFILLED = -(sum of line item quantities), with exactly one `inventory_history` record
  per line item for the confirmation event.

- **Property 4 (history completeness)**: For any valid call to `deductStock` or
  `addStock`, assert all 10 required fields in the resulting `inventory_history` row
  are non-null.

- **Property 5 (transfer source available)**: For any `(quantity, srcQty,
  reservations)`, assert `transferStock` succeeds iff
  `srcQty - reservations >= quantity`, and that both history rows share the same
  `reference_id`.

### Integration Tests

Location: `apps/api/src/modules/inventory/__tests__/inventoryConsistency.integration.test.ts`

- Full POS sale → verify `inventory.quantity` decremented by exact sale quantity at
  correct `location_id` only
- Full order CONFIRMED → CANCELLED → verify quantity exactly restored, no double entry
- Concurrent POS transactions on last unit → one succeeds, one throws
  `INSUFFICIENT_STOCK`
- Procurement receipt → verify `inventory.low_stock` outbox event emitted when
  `qty_after > reorder_point` (stock cleared from low state)
- Return processing → verify quantity restored at transaction's `location_id`, not at
  a different location
