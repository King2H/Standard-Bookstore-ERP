# Implementation Plan: Discount Architecture

## Overview

Extend the bookstore ERP's discount model from a single `discount_pct`-only field to a full three-axis system (type, mode, value) across all sales modules. The implementation follows a strict dependency order: database migration first, then the shared utility library, then service layers, then frontend. All changes are additive and backward-compatible.

## Tasks

- [x] 1. Database migration — add discount columns and seed config keys
  - Create `apps/api/src/db/migrations/1700000035_discount_architecture.cjs`
  - Add `discount_type TEXT NOT NULL DEFAULT 'Normal' CHECK (discount_type IN ('Normal','Merchant','Special'))` and `discount_mode TEXT NOT NULL DEFAULT 'Percentage' CHECK (discount_mode IN ('Percentage','Amount'))` to `transaction_line_items`, `order_line_items`, `return_line_items`, and `exchange_outgoing_items` using `ALTER TABLE … ADD COLUMN IF NOT EXISTS`
  - Add `discount_total NUMERIC(14,2) NOT NULL DEFAULT 0` to the `orders` header table using `ADD COLUMN IF NOT EXISTS`
  - Seed `default_discount_type`, `default_discount_mode`, `default_discount_value` into `system_config` using `INSERT … ON CONFLICT DO NOTHING`
  - Implement the `down` function to drop the added columns and delete the three config keys
  - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7_

- [x] 2. Shared discount utility library (`apps/api/src/lib/discount.ts`)
  - [x] 2.1 Create `apps/api/src/lib/discount.ts` with all exported types and pure functions
    - Export `DiscountType`, `DiscountMode`, `DiscountFields`, `LineItemBase` types
    - Implement `computeAmountFromPct(item, discountPct)`: `round(unitPrice × quantity × (discountPct / 100), 2)`
    - Implement `computePctFromAmount(item, discountAmount)`: `clamp(round((discountAmount / (unitPrice × quantity)) × 100, 4), 0, 100)`, returning 0 when `unitPrice × quantity === 0`
    - Implement `resolveDiscountFields(item, mode, value, type)`: calls the appropriate compute function, validates `discountAmount ≤ unitPrice × quantity`, throws `ValidationError` on violation
    - Implement `validateDiscountType(value)`: throws `ValidationError` for values outside `['Normal','Merchant','Special']`
    - Implement `validateDiscountMode(value)`: throws `ValidationError` for values outside `['Percentage','Amount']`
    - Implement `computeLineTotal(item, discountAmount)`: `unitPrice × quantity − discountAmount`
    - Implement `enforceDiscountCap(discountPct, maxPct)`: throws `BusinessError('DISCOUNT_EXCEEDS_LIMIT')` when `discountPct > maxPct`
    - Import `ValidationError` and `BusinessError` from `apps/api/src/lib/errors.ts`
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 6.7, 11.1_

  - [ ]* 2.2 Write unit tests for discount utility functions
    - Test `computeAmountFromPct` with concrete inputs including zero-price edge case
    - Test `computePctFromAmount` with concrete inputs including zero-price edge case
    - Test `resolveDiscountFields` for both modes, and for the `discountAmount > lineValue` rejection
    - Test `validateDiscountType` and `validateDiscountMode` with valid and invalid values
    - Test `enforceDiscountCap` at, below, and above the cap
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 6.7_

- [x] 3. Config service extensions (`apps/api/src/modules/config/config.service.ts`)
  - [x] 3.1 Add the three new keys to `CONFIG_SCHEMA` (or equivalent validation map)
    - `default_discount_type`: type `'string'`
    - `default_discount_mode`: type `'string'`
    - `default_discount_value`: type `'number'`
    - _Requirements: 1.1_

  - [x] 3.2 Extend `validateConfigValue` to call `validateDiscountType` / `validateDiscountMode` from `discount.ts` for the new string keys, and reject values `< 0` for `default_discount_value`
    - Import `validateDiscountType`, `validateDiscountMode` from `lib/discount.ts`
    - _Requirements: 1.2, 1.3, 1.4_

  - [x] 3.3 Add typed helper functions `getDefaultDiscountType`, `getDefaultDiscountMode`, `getDefaultDiscountValue`
    - Each calls `getEffectiveConfig` so branch-level overrides take precedence
    - Fallbacks: `'Normal'`, `'Percentage'`, `0`
    - Export all three helpers
    - _Requirements: 1.5, 1.6, 1.7, 1.8_

  - [ ]* 3.4 Write unit tests for config service extensions
    - Test each helper returns the correct fallback when the key is absent
    - Test `validateConfigValue` rejects invalid type/mode strings and negative values
    - _Requirements: 1.2, 1.3, 1.4, 1.6, 1.7, 1.8_

- [-] 4. POS service update (`apps/api/src/modules/pos/pos.service.ts`)
  - [ ] 4.1 Extend `LineItemInput` interface with `discountAmount?`, `discountType?`, `discountMode?` fields
    - _Requirements: 6.5, 11.4_

  - [ ] 4.2 Update `createTransaction` to load default discount settings and resolve per-line discount fields
    - After resolving `unitPrice`, call `getDefaultDiscountType`, `getDefaultDiscountMode`, `getDefaultDiscountValue` for the branch
    - For each item, use provided values or fall back to fetched defaults
    - Call `resolveDiscountFields` from `discount.ts` to compute both `discountPct` and `discountAmount`
    - Call `enforceDiscountCap` with the resolved `discountPct` and the role's `maxDiscPct`
    - Use `computeLineTotal` for each line; `grandTotal = sum(lineTotal)` with no tax component
    - Include `discount_type` and `discount_mode` in the `INSERT INTO transaction_line_items` statement
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 6.5, 8.1, 8.2, 8.3, 8.4, 11.4_

  - [ ]* 4.3 Write unit tests for POS service discount logic
    - Test that defaults are applied when no explicit discount is provided
    - Test that explicit per-item values override defaults
    - Test that `DISCOUNT_EXCEEDS_LIMIT` is thrown when cap is exceeded
    - Test backward compatibility: `discountPct`-only payload still works
    - _Requirements: 3.2, 3.5, 6.5, 6.7, 11.4_

- [ ] 5. Orders service update (`apps/api/src/modules/orders/orders.service.ts`)
  - [ ] 5.1 Extend `OrderLineInput` interface with `discountPct?`, `discountType?`, `discountMode?` fields
    - _Requirements: 6.6, 11.5_

  - [ ] 5.2 Update `create` to load defaults, resolve discount fields, and store `discount_total` on the header
    - Fetch default discount settings for the branch
    - For each item, call `resolveDiscountFields`; preserve existing `max_line_discount_pct` cap check
    - `lineTotal = unitPrice × quantity − discountAmount` (no tax)
    - `total = sum(lineTotal)`; `discount_total = sum(discountAmount)`
    - Include `discount_type` and `discount_mode` in `INSERT INTO order_line_items`
    - Include `discount_total` in `INSERT INTO orders`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 8.1, 8.3, 10.2_

  - [ ] 5.3 Update `updateOrder` (and any partial-fulfilment path) to recalculate and UPDATE `discount_total` on the header whenever line items change
    - _Requirements: 10.5_

  - [ ]* 5.4 Write unit tests for orders service discount logic
    - Test default application, explicit override, `discount_total` stored on header
    - Test backward compatibility: `discountAmount`-only payload still works
    - _Requirements: 4.2, 4.3, 4.4, 10.2, 11.5_

- [ ] 6. Returns service update (`apps/api/src/modules/returns/returns.service.ts`)
  - [ ] 6.1 Update `createReturn` to read `discount_type` and `discount_mode` from the source `transaction_line_item` and persist them on `return_line_items`
    - Fall back to `'Normal'` / `'Percentage'` for legacy rows where the columns are NULL
    - Include `discount_type` and `discount_mode` in `INSERT INTO return_line_items`
    - Do not change `lineRefundAmount` calculation (uses existing `discount_pct`)
    - Preserve all existing return window, refund method, and authorisation checks
    - _Requirements: 5.1, 5.3, 8.1, 8.3, 11.2, 11.3_

  - [ ]* 6.2 Write unit tests for returns service discount persistence
    - Test that `discount_type` and `discount_mode` are copied from the source line item
    - Test fallback values for legacy rows with NULL columns
    - _Requirements: 5.1, 11.2, 11.3_

- [ ] 7. Exchanges service update (`apps/api/src/modules/exchanges/exchanges.service.ts`)
  - [ ] 7.1 Update `createExchange` / `settleExchange` to load default discount settings and resolve discount fields for outgoing items
    - Fetch default discount settings for the branch
    - For each outgoing item, if no explicit discount is provided, apply defaults via `resolveDiscountFields`
    - Include `discount_type` and `discount_mode` in `INSERT INTO exchange_outgoing_items`
    - Preserve all existing settlement type, net balance, and cash adjustment checks
    - _Requirements: 5.2, 5.4, 8.1, 8.3_

  - [ ]* 7.2 Write unit tests for exchanges service discount logic
    - Test default application and explicit override for outgoing items
    - _Requirements: 5.2, 5.4_

- [ ] 8. Payments service update (`apps/api/src/modules/payments/payments.service.ts`)
  - [ ] 8.1 Update `getOrderBalance` to read `discount_total` from the `orders` header and compute `netPayable = orderTotal − discountTotal`
    - Replace `outstanding = orderTotal - totalPaid + totalRefunded` with `outstanding = netPayable - totalPaid + totalRefunded`
    - Update `computeOrderPaymentStatus` to use `netPayable` instead of `orderTotal` when comparing against `totalPaid`
    - Add `discountTotal` and `netPayable` fields to the `getOrderBalance` response shape
    - _Requirements: 10.1, 10.3, 10.4, 10.6, 10.7_

  - [ ]* 8.2 Write unit tests for payments service balance calculation
    - Test `getOrderBalance` with a non-zero `discount_total` returns correct `outstanding` and `netPayable`
    - Test that no additional discount or tax is applied on top of `netPayable`
    - _Requirements: 10.1, 10.3, 10.6_

- [ ] 9. Reports service update (`apps/api/src/modules/reports/reports.service.ts`)
  - [ ] 9.1 Add `SalesSummary` interface and extend the sales report query to aggregate `discount_amount` grouped by `discount_type`
    - Add `SalesSummary` interface with `totalSales`, `totalDiscountAmount`, `discountByType: { Normal, Merchant, Special }`
    - Extend the existing sales report SQL (or add a new `getSalesSummary` function) to UNION `transaction_line_items` and `order_line_items` discount aggregations grouped by `discount_type`
    - Add a `/api/reports/sales-summary` endpoint (or `?summary=true` query parameter) that returns the condensed `SalesSummary` shape
    - Extend the existing `/api/reports/sales` response with a `discountByType` field
    - _Requirements: 8.5, 8.6, 9.4, 9.5_

  - [ ]* 9.2 Write unit tests for reports service discount aggregation
    - Test `getSalesSummary` with a known set of line items returns correct `discountByType` sums
    - _Requirements: 8.6, 9.5_

- [ ] 10. Checkpoint — verify service layer
  - Ensure all tests pass for tasks 1–9, ask the user if questions arise.

- [ ] 11. Property-based tests for discount utility (`apps/api/src/lib/discount.ts`)
  - [ ]* 11.1 Write property test for discount type validation (Property 1)
    - **Property 1: Discount type validation rejects all non-enum strings**
    - Use `fc.string()` filtered to exclude `['Normal','Merchant','Special']`; assert `validateDiscountType` throws `ValidationError`
    - **Validates: Requirements 1.2**

  - [ ]* 11.2 Write property test for discount mode validation (Property 2)
    - **Property 2: Discount mode validation rejects all non-enum strings**
    - Use `fc.string()` filtered to exclude `['Percentage','Amount']`; assert `validateDiscountMode` throws `ValidationError`
    - **Validates: Requirements 1.3**

  - [ ]* 11.3 Write property test for negative discount value rejection (Property 3)
    - **Property 3: Negative discount value is always rejected**
    - Use `fc.float({ max: -0.01 })`; assert config write throws `ValidationError`
    - **Validates: Requirements 1.4**

  - [ ]* 11.4 Write property test for percentage-mode round-trip (Property 4)
    - **Property 4: Percentage-mode discount amount round-trip**
    - Use `fc.record({ unitPrice: fc.float({min:0.01,max:9999}), quantity: fc.integer({min:1,max:100}), discountPct: fc.float({min:0,max:100}) })`
    - Assert `|computeAmountFromPct(item, discountPct) - expected| ≤ 0.01`
    - **Validates: Requirements 7.1, 7.6**

  - [ ]* 11.5 Write property test for amount-mode round-trip (Property 5)
    - **Property 5: Amount-mode discount percentage round-trip**
    - Derive `discountAmount` from `unitPrice × quantity × random ∈ [0,1]`
    - Assert `|computeAmountFromPct(item, computePctFromAmount(item, amt)) - amt| ≤ 0.01`
    - **Validates: Requirements 7.2, 7.6**

  - [ ]* 11.6 Write property test for discount amount cap (Property 6)
    - **Property 6: Discount amount never exceeds line value**
    - Generate `discountAmount > unitPrice × quantity`; assert `resolveDiscountFields` throws `ValidationError`
    - **Validates: Requirements 7.4**

  - [ ]* 11.7 Write property test for grand total formula (Property 7)
    - **Property 7: Grand total formula (no tax)**
    - Generate random cart items; assert `grandTotal = sum(computeLineTotal(item, discountAmount))`
    - **Validates: Requirements 3.6, 4.6**

  - [ ]* 11.8 Write property test for discount cap enforcement (Property 8)
    - **Property 8: Discount cap enforcement**
    - Generate `discountPct > maxPct`; assert `enforceDiscountCap` throws `BusinessError('DISCOUNT_EXCEEDS_LIMIT')`
    - **Validates: Requirements 6.7, 11.7**

  - [ ]* 11.9 Write property test for outstanding balance (Property 9)
    - **Property 9: Outstanding balance uses net payable**
    - Generate random `total`, `discountTotal`, `totalPaid`, `totalRefunded`; assert `outstanding = max(0, total − discountTotal − totalPaid + totalRefunded)`
    - **Validates: Requirements 10.1, 10.3**

  - [ ]* 11.10 Write property test for discount aggregation by type (Property 10)
    - **Property 10: Discount aggregation by type**
    - Generate random line items with known `discount_type` and `discount_amount`; assert `discountByType` sums match manual aggregation
    - **Validates: Requirements 8.6, 9.5**

- [ ] 12. Integration tests
  - [ ]* 12.1 Write integration test for migration idempotency
    - Assert all four line item tables have `discount_type` and `discount_mode` columns after migration
    - Assert `orders` table has `discount_total` column
    - Assert running the migration a second time does not throw
    - Assert the three config keys exist in `system_config`
    - _Requirements: 12.1, 12.2, 12.3, 12.5_

  - [ ]* 12.2 Write integration test for POS transaction creation with discount persistence
    - Create a transaction with explicit `discountType` and `discountMode`; assert they are persisted on `transaction_line_items`
    - Create a transaction without explicit discount fields; assert defaults from config are applied
    - _Requirements: 3.2, 8.1, 8.3_

  - [ ]* 12.3 Write integration test for order creation with `discount_total` on header
    - Create an order; assert `discount_total` on the `orders` header equals the sum of line item `discount_amount` values
    - _Requirements: 4.6, 10.2_

  - [ ]* 12.4 Write integration test for payments balance with non-zero `discount_total`
    - Create an order with a known `discount_total`; call `getOrderBalance`; assert `outstanding = netPayable − totalPaid`
    - _Requirements: 10.1, 10.3, 10.4_

  - [ ]* 12.5 Write integration test for reports discount aggregation
    - Insert line items with known `discount_type` and `discount_amount` values; call `getSalesSummary`; assert `discountByType` sums are correct
    - _Requirements: 8.6, 9.5_

- [ ] 13. Checkpoint — verify all backend tests pass
  - Ensure all tests pass for tasks 1–12, ask the user if questions arise.

- [ ] 14. Frontend — Settings page (`apps/web/src/pages/SettingsPage.tsx`)
  - [ ] 14.1 Add three new entries to `CONFIG_META` for `default_discount_type`, `default_discount_mode`, `default_discount_value` under the `Discounts` tab
    - `default_discount_type`: label `'Default Discount Type'`, type `'string'`, tab `'Discounts'`
    - `default_discount_mode`: label `'Default Discount Mode'`, type `'string'`, tab `'Discounts'`
    - `default_discount_value`: label `'Default Discount Value'`, type `'number'`, tab `'Discounts'`, min `0`
    - _Requirements: 2.1, 2.4_

  - [ ] 14.2 Extend `ConfigRowItem` (or equivalent rendering logic) to render a `<select>` for `default_discount_type` (options: `Normal`, `Merchant`, `Special`) and `default_discount_mode` (options: `Percentage`, `Amount`) instead of a plain text input
    - Detect by key name; do not add a new `type: 'enum'` to the schema
    - _Requirements: 2.2, 2.3_

  - [ ] 14.3 Verify that branch override panel allows Managers and Admins to set branch-level overrides for all three new keys via the existing branch override mechanism
    - No new mechanism needed; confirm the existing branch override UI picks up the new `CONFIG_META` entries automatically
    - _Requirements: 2.5_

  - [ ] 14.4 Verify that server-returned validation errors for the new keys are surfaced via the existing Toast component
    - No new error handling code needed if the existing save handler already passes server errors to Toast; confirm and add if missing
    - _Requirements: 2.6_

  - _Requirements: 13.2_

- [ ] 15. Frontend — POS page (`apps/web/src/pages/POSPage.tsx`)
  - [ ] 15.1 Extend `CartItem` interface with `discountType: DiscountType`, `discountMode: DiscountMode`, `discountPct: number`, `discountAmount: number` fields
    - Import `DiscountType` and `DiscountMode` types (or redefine locally as string literals)
    - _Requirements: 6.1_

  - [ ] 15.2 On mount, fetch effective config for the current branch and store `defaultDiscountType`, `defaultDiscountMode`, `defaultDiscountValue` in component state
    - _Requirements: 3.1_

  - [ ] 15.3 Update `addToCart` to initialise new items with the fetched defaults and call `recalcItem` immediately
    - _Requirements: 3.2, 3.3, 3.4, 3.5_

  - [ ] 15.4 Update `recalcItem` to handle both `Percentage` and `Amount` modes using integer-cent arithmetic, and update `calcCart` to remove any tax component (`grandTotal = subtotal − discountTotal`)
    - _Requirements: 7.1, 7.2, 7.3, 3.6_

  - [ ] 15.5 Add per-line-item UI controls to each cart row: a dropdown for `discountType`, a toggle for `discountMode` (`%` / `ETB`), and the existing discount value input (label changes based on mode)
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [ ] 15.6 Update the transaction creation payload to include `discountType`, `discountMode`, `discountPct`, `discountAmount` per item
    - _Requirements: 6.5_

  - _Requirements: 13.3_

- [ ] 16. Frontend — Dashboard page (`apps/web/src/pages/DashboardPage.tsx`)
  - [ ] 16.1 Add `SalesSummary` interface and a `useQuery` (or equivalent fetch) for `/api/reports/sales-summary` with the same date/branch filters as other reports
    - _Requirements: 9.1, 9.4_

  - [ ] 16.2 Add a `Discounts` section to the dashboard layout using existing `KpiCard` and `Section` components
    - One `KpiCard` for `totalDiscountAmount`
    - Three `KpiCard` components for `Normal`, `Merchant`, and `Special` discount totals from `discountByType`
    - _Requirements: 9.1, 9.2, 9.3, 9.6_

  - _Requirements: 13.4_

- [ ] 17. Final checkpoint — ensure all tests pass
  - Ensure all tests pass end-to-end, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP
- Each task references specific requirements for traceability
- The dependency order is: migration → discount utility → config service → service layers → payments → reports → property tests → integration tests → frontend
- Property tests use [fast-check](https://github.com/dubzzz/fast-check) with a minimum of 100 iterations per property
- All grand total formulas are `subtotal − discountTotal` with no tax component
- Backward-compatible: `discountPct`-only (POS) and `discountAmount`-only (Orders) legacy payloads continue to work
