# Requirements Document

## Introduction

This feature enhances the bookstore ERP's discount architecture to support configurable default discount settings (type, mode, and value) at the system level, automatic loading of those defaults when creating POS transactions, Orders, Returns, and Exchanges, and per-line-item override capability. It also adds dual-entry discount input (percentage ↔ amount with automatic cross-calculation), full discount audit recording for reporting and revenue calculations, and a migration strategy that preserves all existing discount data and behavior.

The existing `discount_pct`-only model on `transaction_line_items`, `order_line_items`, and `exchange_line_items` is extended — not replaced — so all current calculations, reports, and authorization flows continue to work without modification.

**Tax exclusion:** Tax is explicitly out of scope for this feature. No tax fields, tax calculations, or tax-related UI will be added or modified. Any existing `tax_total` or `tax_rate` references in the codebase are left untouched.

## Glossary

- **Discount_Engine**: The backend service layer responsible for resolving, validating, and persisting discount values on line items across all sales modules (POS, Orders, Returns, Exchanges).
- **Discount_Type**: A classification label for a discount: `Normal`, `Merchant`, or `Special`.
- **Discount_Mode**: The entry format for a discount: `Percentage` (0–100) or `Amount` (absolute currency value).
- **Discount_Value**: The numeric magnitude of a discount, interpreted according to the active Discount_Mode.
- **Default_Discount_Settings**: The system-level (or branch-level override) configuration keys `default_discount_type`, `default_discount_mode`, and `default_discount_value` stored in the existing `system_config` / `branch_config` tables.
- **Line_Item**: A single book entry within a POS transaction, Order, Return, or Exchange, carrying its own discount fields.
- **Discount_Record**: A persisted row capturing the Discount_Type, Discount_Mode, discount percentage, and discount amount for a Line_Item at the time of the operation.
- **Config_Service**: The existing `config.service.ts` module that reads and writes `system_config` and `branch_config` via the `getEffectiveConfig` helper.
- **POS_Module**: The existing `pos.service.ts` / `pos.routes.ts` module handling point-of-sale transactions.
- **Orders_Module**: The existing `orders.service.ts` / `orders.routes.ts` module handling order lifecycle.
- **Returns_Module**: The existing `returns.service.ts` / `returns.routes.ts` module handling product returns.
- **Exchanges_Module**: The existing `exchanges.service.ts` / `exchanges.routes.ts` module handling book exchanges.
- **Payments_Module**: The existing `payments.service.ts` / `payments.routes.ts` module handling payment collection for orders and credit sales.
- **Dashboard_Page**: The existing `DashboardPage.tsx` frontend component that renders KPI cards and charts sourced from the Reports_Module.
- **Settings_Page**: The existing `SettingsPage.tsx` frontend component that renders system and branch configuration.
- **POS_Page**: The existing `POSPage.tsx` frontend component for the POS terminal.
- **max_line_discount_pct**: The existing config key that caps the maximum percentage discount a staff role may apply per line item.
- **Net_Payable**: The order or transaction total after all discounts have been applied, with no tax component. This is the amount the Payments_Module uses as the basis for outstanding balance calculations.

---

## Requirements

### Requirement 1: Default Discount System Settings

**User Story:** As a Super_Admin, I want to configure system-wide default discount type, mode, and value, so that all branches start with a consistent discount policy without manual setup per transaction.

#### Acceptance Criteria

1. THE Config_Service SHALL recognise three new config keys: `default_discount_type` (string, one of `Normal`, `Merchant`, `Special`), `default_discount_mode` (string, one of `Percentage`, `Amount`), and `default_discount_value` (number, ≥ 0).
2. WHEN a Super_Admin writes a value for `default_discount_type`, THE Config_Service SHALL reject values outside `['Normal', 'Merchant', 'Special']` with a `ValidationError`.
3. WHEN a Super_Admin writes a value for `default_discount_mode`, THE Config_Service SHALL reject values outside `['Percentage', 'Amount']` with a `ValidationError`.
4. WHEN a Super_Admin writes a value for `default_discount_value`, THE Config_Service SHALL reject non-numeric values and values less than 0 with a `ValidationError`.
5. THE Config_Service SHALL expose typed helper functions `getDefaultDiscountType`, `getDefaultDiscountMode`, and `getDefaultDiscountValue` that call `getEffectiveConfig` so branch-level overrides take precedence over system defaults.
6. WHEN no `default_discount_value` config key exists, THE Config_Service SHALL return `0` as the fallback value.
7. WHEN no `default_discount_type` config key exists, THE Config_Service SHALL return `'Normal'` as the fallback value.
8. WHEN no `default_discount_mode` config key exists, THE Config_Service SHALL return `'Percentage'` as the fallback value.

---

### Requirement 2: Settings Page — Discount Tab

**User Story:** As a Super_Admin or Manager, I want to view and edit the default discount settings in the Settings page, so that I can manage discount policy without touching the database directly.

#### Acceptance Criteria

1. THE Settings_Page SHALL display `default_discount_type`, `default_discount_mode`, and `default_discount_value` under the existing `Discounts` tab alongside the current discount config keys.
2. WHEN the active tab is `Discounts`, THE Settings_Page SHALL render `default_discount_type` as a dropdown with options `Normal`, `Merchant`, `Special`.
3. WHEN the active tab is `Discounts`, THE Settings_Page SHALL render `default_discount_mode` as a dropdown with options `Percentage`, `Amount`.
4. WHEN the active tab is `Discounts`, THE Settings_Page SHALL render `default_discount_value` as a numeric input with a minimum value of 0.
5. WHILE a branch is selected in the Branch Overrides panel, THE Settings_Page SHALL allow Managers and Admins to set branch-level overrides for all three new keys using the existing branch override mechanism.
6. IF a Super_Admin saves an invalid value for any new discount key, THEN THE Settings_Page SHALL display the server-returned error message via the existing Toast component.
7. THE Settings_Page SHALL NOT add, modify, or display any tax-related fields as part of this feature.

---

### Requirement 3: Automatic Default Loading in POS

**User Story:** As a Sales staff member, I want the POS terminal to pre-fill discount fields with the configured defaults when I add a book to the cart, so that I do not have to manually enter the same discount for every line item.

#### Acceptance Criteria

1. WHEN the POS_Page initialises, THE POS_Page SHALL fetch the effective `default_discount_type`, `default_discount_mode`, and `default_discount_value` for the current branch via the Config_Service.
2. WHEN a book is added to the cart, THE POS_Page SHALL initialise that Line_Item's discount type to the fetched `default_discount_type`, discount mode to `default_discount_mode`, and discount value to `default_discount_value`.
3. WHEN `default_discount_mode` is `Percentage`, THE POS_Page SHALL set the line item's `discountPct` to `default_discount_value` and compute `discountAmount` as `unitPrice × quantity × (discountPct / 100)`.
4. WHEN `default_discount_mode` is `Amount`, THE POS_Page SHALL set the line item's `discountAmount` to `default_discount_value` and compute `discountPct` as `(discountAmount / (unitPrice × quantity)) × 100`, clamped to [0, 100].
5. IF `default_discount_value` is 0, THEN THE POS_Page SHALL initialise the line item with zero discount, preserving the current no-discount behaviour.
6. THE POS_Page grand total calculation SHALL be `grandTotal = subtotal − discountTotal` with no tax component added.

---

### Requirement 4: Automatic Default Loading in Orders

**User Story:** As a Sales staff member, I want new order line items to be pre-filled with the configured default discount, so that order creation is consistent with the POS experience.

#### Acceptance Criteria

1. WHEN the Orders_Module creates a new order, THE Orders_Module SHALL read `default_discount_type`, `default_discount_mode`, and `default_discount_value` via the Config_Service for the staff member's branch.
2. WHEN `default_discount_mode` is `Percentage` and no explicit discount is provided for a line item, THE Orders_Module SHALL apply `default_discount_value` as the discount percentage and compute the equivalent discount amount.
3. WHEN `default_discount_mode` is `Amount` and no explicit discount is provided for a line item, THE Orders_Module SHALL apply `default_discount_value` as the discount amount and compute the equivalent discount percentage.
4. WHEN an explicit discount value is provided for a line item in the request payload, THE Orders_Module SHALL use the provided value and ignore the system default for that line item.
5. THE Orders_Module SHALL preserve all existing discount validation logic, including the `max_line_discount_pct` cap check.
6. THE Orders_Module order total SHALL be computed as `total = sum(lineTotal)` where `lineTotal = unitPrice × quantity − discountAmount`, with no tax component.

---

### Requirement 5: Automatic Default Loading in Returns and Exchanges

**User Story:** As a Manager, I want Returns and Exchanges to respect the configured default discount settings when applicable, so that discount policy is applied consistently across all operations.

#### Acceptance Criteria

1. WHEN the Returns_Module processes a return line item and no explicit discount override is provided, THE Returns_Module SHALL read the effective default discount settings from the Config_Service and apply them to the refund calculation.
2. WHEN the Exchanges_Module creates outgoing line items and no explicit discount override is provided, THE Exchanges_Module SHALL read the effective default discount settings from the Config_Service and apply them to the outgoing item valuation.
3. THE Returns_Module SHALL preserve all existing return window, refund method, and authorisation checks without modification.
4. THE Exchanges_Module SHALL preserve all existing settlement type, net balance, and cash adjustment checks without modification.

---

### Requirement 6: Per-Line-Item Discount Override

**User Story:** As a Sales staff member, I want to override the discount type, mode, and value on any individual line item, so that I can apply item-specific discounts without changing the system default.

#### Acceptance Criteria

1. THE POS_Page SHALL render, for each cart line item, editable fields for discount type (dropdown: `Normal`, `Merchant`, `Special`), discount mode (toggle: `Percentage` / `Amount`), and discount value (numeric input).
2. WHEN a user changes the discount type for a line item, THE POS_Page SHALL update only that line item's discount type without affecting other line items or the system default.
3. WHEN a user changes the discount mode for a line item, THE POS_Page SHALL retain the current discount value and recalculate the complementary field (percentage ↔ amount) for that line item.
4. WHEN a user changes the discount value for a line item, THE POS_Page SHALL recalculate the complementary field and update the line total immediately.
5. THE POS_Module SHALL accept `discountType`, `discountMode`, `discountPct`, and `discountAmount` per line item in the transaction creation payload.
6. THE Orders_Module SHALL accept `discountType`, `discountMode`, `discountPct`, and `discountAmount` per line item in the order creation payload.
7. IF a staff member's role does not permit the requested discount percentage (as governed by `max_line_discount_pct`), THEN THE Discount_Engine SHALL reject the request with a `BusinessError` of code `DISCOUNT_EXCEEDS_LIMIT`.

---

### Requirement 7: Dual-Entry Discount Calculation (Percentage ↔ Amount)

**User Story:** As a Sales staff member, I want to enter a discount as either a percentage or a flat amount and have the other value calculated automatically, so that I can work in whichever unit is most natural for the situation.

#### Acceptance Criteria

1. WHEN a user enters a discount percentage for a line item, THE POS_Page SHALL compute `discountAmount = round(unitPrice × quantity × (discountPct / 100), 2)` and display it immediately.
2. WHEN a user enters a discount amount for a line item, THE POS_Page SHALL compute `discountPct = round((discountAmount / (unitPrice × quantity)) × 100, 4)` clamped to [0, 100] and display it immediately.
3. WHEN `unitPrice × quantity` equals 0, THE POS_Page SHALL set `discountPct` to 0 and `discountAmount` to 0 to avoid division by zero.
4. THE Discount_Engine SHALL validate that `discountAmount ≤ unitPrice × quantity` for each line item and reject requests where this condition is violated with a `ValidationError`.
5. THE Discount_Engine SHALL store both `discount_pct` and `discount_amount` on every line item record, regardless of which mode was used for entry.
6. FOR ALL valid line items, the relationship `discountAmount = round(unitPrice × quantity × (discountPct / 100), 2)` SHALL hold within a tolerance of 0.01 currency units (round-trip property).

---

### Requirement 8: Discount Type Persistence and Recording

**User Story:** As a Finance Manager, I want every discount applied during any operation to be recorded with its type, mode, percentage, and amount, so that I can produce accurate discount reports and revenue calculations.

#### Acceptance Criteria

1. THE Discount_Engine SHALL persist `discount_type` (one of `Normal`, `Merchant`, `Special`) on every line item record in `transaction_line_items`, `order_line_items`, `return_line_items`, and `exchange_outgoing_items`.
2. WHEN a line item is saved without an explicit `discount_type`, THE Discount_Engine SHALL default `discount_type` to `'Normal'`.
3. THE Discount_Engine SHALL persist `discount_mode` (one of `Percentage`, `Amount`) on every line item record.
4. WHEN a line item is saved without an explicit `discount_mode`, THE Discount_Engine SHALL default `discount_mode` to `'Percentage'`.
5. THE Reports_Module SHALL include `discount_type` and `discount_mode` as filterable and groupable dimensions in discount-related report queries.
6. THE Reports_Module SHALL compute `total_discount_by_type` (sum of `discount_amount` grouped by `discount_type`) for the sales report summary.

---

### Requirement 9: Dashboard Discount Visibility

**User Story:** As a Manager or Finance Officer, I want the Dashboard to display discount summary metrics broken down by discount type, so that I can monitor discount usage and its revenue impact at a glance.

#### Acceptance Criteria

1. THE Dashboard_Page SHALL display a `Discounts` summary section showing `total_discount_amount` (sum of all discounts applied in the selected period) sourced from the Reports_Module.
2. THE Dashboard_Page SHALL display a breakdown of `total_discount_by_type` with separate values for `Normal`, `Merchant`, and `Special` discount types.
3. WHEN the Reports_Module returns discount data, THE Dashboard_Page SHALL render the breakdown using the existing chart or KPI card components already present on the dashboard.
4. THE Dashboard_Page discount data SHALL be fetched via the existing `/api/reports/sales-summary` endpoint (or equivalent), extended to include the new discount breakdown fields.
5. THE Reports_Module sales summary endpoint SHALL include `discountByType` as a new field in its response, containing an object with keys `Normal`, `Merchant`, `Special` and their respective summed `discount_amount` values.
6. THE Dashboard_Page SHALL NOT display any tax-related metrics or fields.

---

### Requirement 10: Discount Effect on Payments Module (Orders / Credit Sales)

**User Story:** As a Finance Officer, I want the Payments module to use the post-discount Net_Payable amount as the basis for outstanding balance calculations, so that customers are charged the correct discounted amount when paying for orders or credit sales.

#### Acceptance Criteria

1. WHEN the Payments_Module retrieves an order's outstanding balance, THE Payments_Module SHALL use `Net_Payable = order_total − total_discount` (with no tax component) as the basis for the outstanding amount.
2. THE Orders_Module SHALL store `discount_total` (sum of all line item `discount_amount` values) on the `orders` header record so the Payments_Module can read it without re-aggregating line items.
3. WHEN a payment is collected against an order, THE Payments_Module SHALL compute `outstanding = Net_Payable − total_paid` where `Net_Payable` is the stored `total − discount_total` value.
4. THE Payments_Module SHALL expose `discount_total` in the order balance response (`GET /orders/:id/balance`) so the frontend can display the discounted amount to the Finance Officer during payment collection.
5. WHEN an order's line items are updated (e.g., partial fulfilment), THE Orders_Module SHALL recalculate and update `discount_total` on the header record so the Payments_Module always reads a consistent value.
6. THE Payments_Module SHALL NOT apply any additional discount or tax calculation on top of the stored `Net_Payable`; it SHALL only track payments against the already-discounted order total.
7. THE existing `payments` table and payment collection flow SHALL remain structurally unchanged; only the `order_balance` query used by the Payments_Module is updated to reflect `discount_total`.

---

### Requirement 11: Preservation of Existing Discount Calculations and Reports

**User Story:** As a system operator, I want all existing discount calculations, report queries, and authorization flows to continue working after the upgrade, so that no currently working functionality is broken.

#### Acceptance Criteria

1. THE Discount_Engine SHALL treat the existing `discount_pct` column as the authoritative percentage source for all legacy records that lack a `discount_type` or `discount_mode` value.
2. WHEN reading a line item that has a NULL `discount_type`, THE Discount_Engine SHALL return `'Normal'` as the effective type without modifying the stored row.
3. WHEN reading a line item that has a NULL `discount_mode`, THE Discount_Engine SHALL return `'Percentage'` as the effective mode without modifying the stored row.
4. THE POS_Module SHALL continue to accept the existing `discountPct`-only payload format for backward compatibility.
5. THE Orders_Module SHALL continue to accept the existing `discountAmount`-only payload format for backward compatibility.
6. THE Reports_Module SHALL continue to produce correct `discount_total` aggregates using the existing `discount_amount` and `discount_total` columns without requiring a data backfill.
7. THE Config_Service SHALL continue to enforce the existing `max_line_discount_pct` role-based cap for all discount entries, whether entered as percentage or amount.

---

### Requirement 12: Database Migration Strategy

**User Story:** As a database administrator, I want a non-destructive migration that adds the new discount columns and config keys without altering existing data, so that the system can be upgraded without downtime or data loss.

#### Acceptance Criteria

1. THE Migration SHALL add `discount_type TEXT NOT NULL DEFAULT 'Normal'` and `discount_mode TEXT NOT NULL DEFAULT 'Percentage'` columns to `transaction_line_items`, `order_line_items`, `return_line_items`, and `exchange_outgoing_items` using `ALTER TABLE … ADD COLUMN IF NOT EXISTS`.
2. THE Migration SHALL add CHECK constraints ensuring `discount_type IN ('Normal', 'Merchant', 'Special')` and `discount_mode IN ('Percentage', 'Amount')` on each affected table.
3. THE Migration SHALL insert the three new config keys (`default_discount_type`, `default_discount_mode`, `default_discount_value`) into `system_config` using `INSERT … ON CONFLICT DO NOTHING` so existing values are never overwritten.
4. THE Migration SHALL be reversible: the `down` function SHALL drop the added columns and delete the inserted config keys.
5. WHEN the migration runs on a database that already has the columns (e.g., re-run scenario), THE Migration SHALL not fail due to duplicate column errors because of the `IF NOT EXISTS` guard.
6. THE Migration SHALL not modify any existing column definitions, constraints, indexes, or data on `transactions`, `orders`, `returns`, or `exchanges` header tables.
7. THE Migration SHALL NOT add any tax-related columns or config keys.

---

### Requirement 13: No Modification to Unrelated Modules

**User Story:** As a developer, I want the discount architecture changes to be isolated to the discount-related code paths, so that unrelated modules such as Inventory, Procurement, Customers, and Installments are not touched.

#### Acceptance Criteria

1. THE Discount_Engine SHALL only modify files within `pos.service.ts`, `orders.service.ts`, `returns.service.ts`, `exchanges.service.ts`, `config.service.ts`, `reports.service.ts`, `payments.service.ts` (order balance query only), their corresponding route files, and the new migration file.
2. THE Settings_Page changes SHALL be limited to adding the three new config key entries to `CONFIG_META` and the corresponding input controls in the `Discounts` tab.
3. THE POS_Page changes SHALL be limited to adding discount type/mode fields to the cart line item UI and the default-loading logic on page initialisation.
4. THE Dashboard_Page changes SHALL be limited to adding the discount summary section using existing chart/KPI components.
5. THE Discount_Engine SHALL not alter the `inventory`, `procurement`, `installments`, `customers`, `catalog`, `supplier`, or `branch` modules.
6. NO module SHALL introduce, display, or calculate tax fields as part of this feature.
