# Requirements Document

## Introduction

This document captures the production-hardening requirements for the Bookstore ERP system (Node.js/Express API + React frontend). The goal is to finalize the system for production deployment by aligning the Order Lifecycle to a well-defined state machine, completing the Exchange Lifecycle with full inventory and finance integration, migrating the permissions system from role-name checks to permission-based checks, hardening multi-branch support, and ensuring all changes are strictly backward-compatible and additive.

The current system has:
- Orders with statuses: `Pending → Confirmed → In_Progress → Fulfilled → Cancelled` and a separate `payment_status` field.
- Exchanges with statuses: `Initiated → Evaluated → Completed / Cancelled` (single-step creation that immediately completes).
- RBAC middleware using `requireRole(...)` with hard-coded role names.
- Staff with multi-role support per branch (migration 29), but the JWT still carries a single role.
- Inventory movements tracked via `inventory_history` with `reference_type` constraints.

All changes MUST be additive. Existing DB columns, API endpoints, and business logic that is correct MUST NOT be removed or broken.

---

## Glossary

- **Order_System**: The API and service layer responsible for managing customer orders.
- **Exchange_System**: The API and service layer responsible for managing book-to-book and hybrid exchanges.
- **Permission_System**: The middleware and role-permission mapping layer that enforces access control.
- **Finance_System**: The payments, refunds, and transaction recording layer.
- **Inventory_System**: The inventory tracking and movement recording layer.
- **Branch_System**: The multi-branch management layer including staff branch access.
- **POS_System**: The point-of-sale interface and service layer.
- **Staff**: An authenticated employee of the bookstore.
- **Order**: A customer purchase request tracked through a defined lifecycle.
- **Exchange**: A transaction where a customer returns items and receives different items and/or cash.
- **Permission**: A named capability (e.g., `CREATE_SALE`) that authorises a specific action.
- **Role**: A named collection of permissions assigned to a staff member for a branch.
- **Branch**: A physical or logical store location.
- **Settlement**: The financial resolution of an exchange difference (cash payment, refund, or even swap).
- **Settlement_Entry**: A single line in a multi-entry settlement record describing one component of the total settlement (e.g., ETB 100 cash, ETB 50 item-value adjustment).
- **Inventory_Movement**: A recorded change in stock quantity with a reference to the originating transaction.
- **Inventory_Reservation**: A soft hold on stock quantity that prevents double-selling while an order is CONFIRMED but not yet FULFILLED.
- **Idempotency_Key**: A client-supplied UUID that guarantees a payment or settlement operation is processed exactly once even if the request is retried.
- **DRAFT**: The initial editable state of an order before confirmation.
- **CONFIRMED**: An order that has been reviewed and stock reserved.
- **PAID**: An order whose payment_status is `paid`.
- **FULFILLED**: An order where physical items have been dispatched and inventory deducted.
- **COMPLETED**: An order that has been fully paid and fulfilled — both inventory and finance are fully resolved.
- **CANCELLED**: An order or exchange that has been voided.
- **Resellable**: A returned item classified as fit for re-sale and returned to available stock.
- **Damaged**: A returned item classified as not fit for re-sale; added to a separate damaged-goods count rather than available stock.
- **allowed_actions**: A computed list of action identifiers returned in every Order and Exchange API response, indicating which transitions the current user may trigger.

---

## Requirements

### Requirement 1: Order Lifecycle State Machine

**User Story:** As a sales staff member, I want orders to follow a clear, enforced state machine so that each order moves predictably from creation through payment, fulfilment, and completion without ambiguity.

#### Acceptance Criteria

1. THE Order_System SHALL support the following order statuses: `DRAFT`, `CONFIRMED`, `PAID`, `FULFILLED`, `COMPLETED`, `CANCELLED`.
2. WHEN an order is created, THE Order_System SHALL set its status to `DRAFT`.
3. WHEN a staff member with `CREATE_SALE` permission confirms a `DRAFT` order, THE Order_System SHALL transition the order to `CONFIRMED` and create an Inventory_Reservation for each line item (see Requirement 1b).
4. WHEN a `CONFIRMED` order's `payment_status` becomes `paid`, THE Order_System SHALL transition the order status to `PAID`.
5. WHEN a staff member with `PROCESS_PAYMENT` permission triggers fulfilment on a `PAID` order, THE Order_System SHALL transition the order to `FULFILLED`, convert each Inventory_Reservation to a permanent deduction, and record inventory movements.
6. WHEN a `FULFILLED` order has `payment_status = paid`, THE Order_System SHALL automatically transition the order to `COMPLETED`. Both inventory deduction and finance recording MUST be confirmed before this transition is allowed.
7. WHEN a staff member with `CREATE_SALE` permission cancels a `DRAFT` order, THE Order_System SHALL transition the order to `CANCELLED`. No inventory reservation exists at this stage so no release is needed.
8. WHEN a staff member with `CREATE_SALE` or `APPROVE_EXCHANGE` permission cancels a `CONFIRMED` order, THE Order_System SHALL transition the order to `CANCELLED` and release all Inventory_Reservations for that order.
9. IF an order is in `FULFILLED` or `COMPLETED` status, THEN THE Order_System SHALL reject any cancellation attempt with error code `ORDER_NOT_CANCELLABLE`.
10. IF an order is in `CANCELLED` status, THEN THE Order_System SHALL reject any further state transition with error code `ORDER_ALREADY_CANCELLED`.
11. THE Order_System SHALL include an `allowed_actions` array in every order API response. The array SHALL contain zero or more of: `confirm`, `cancel`, `take_payment`, `fulfill`, `complete`, `view`, `print` — computed from the current status and the requesting staff member's permissions.
12. WHEN existing orders are migrated, THE Order_System SHALL map legacy statuses: `Pending → DRAFT`, `Confirmed → CONFIRMED`, `In_Progress → CONFIRMED`, `Fulfilled → FULFILLED`, `Cancelled → CANCELLED`. Orders with `payment_status = paid` AND status `FULFILLED` SHALL be mapped to `COMPLETED`.
13. THE Order_System SHALL NOT support partial fulfilment in this version. An order is either fully fulfilled or not fulfilled at all. If any line item cannot be fulfilled due to insufficient stock, the entire fulfilment attempt SHALL be rejected with `INSUFFICIENT_STOCK`.

---

### Requirement 1b: Inventory Reservation Lifecycle

**User Story:** As a stock clerk, I want stock to be soft-reserved when an order is confirmed so that the same item cannot be sold twice before the order is fulfilled or cancelled.

#### Acceptance Criteria

1. WHEN an order transitions to `CONFIRMED`, THE Inventory_System SHALL create an Inventory_Reservation record for each line item, recording `order_id`, `book_id`, `location_id`, `quantity`, and `status = reserved`.
2. WHEN an order transitions to `FULFILLED`, THE Inventory_System SHALL convert each `reserved` Inventory_Reservation to `status = deducted` and permanently reduce the `inventory.quantity` by the reserved amount.
3. WHEN an order transitions to `CANCELLED` from `CONFIRMED`, THE Inventory_System SHALL set each Inventory_Reservation to `status = released` and restore the reserved quantity to available stock.
4. IF the available stock (current quantity minus all active reservations) for any line item is less than the requested quantity at confirmation time, THEN THE Order_System SHALL reject the confirmation with `INSUFFICIENT_STOCK`.
5. THE Inventory_System SHALL compute available stock as: `inventory.quantity - SUM(reservations.quantity WHERE status = 'reserved' AND book_id = X AND location_id = Y)`.
6. Inventory_Reservation records SHALL be retained after deduction or release for audit purposes and SHALL NOT be deleted.

---

### Requirement 2: Order Finance Integration

**User Story:** As a finance manager, I want payment recording to automatically drive order status transitions so that the financial state and the operational state of an order are always consistent.

#### Acceptance Criteria

1. WHEN a payment is recorded against an order and the order's `payment_status` becomes `paid`, THE Finance_System SHALL emit an event that causes THE Order_System to transition the order from `CONFIRMED` to `PAID`.
2. WHEN an order transitions to `PAID`, THE Finance_System SHALL create a transaction record of type `payment` linked to the `order_id`. Every transaction record MUST reference either an `order_id` or an `exchange_id` (or both); a transaction with neither SHALL be rejected with `MISSING_TRANSACTION_REFERENCE`.
3. WHEN a refund is processed against a `COMPLETED` order, THE Finance_System SHALL create a transaction record of type `refund` linked to the `order_id`.
4. THE Finance_System SHALL ensure that the `transactions` table records include: `type` (payment/refund/adjustment), `order_id` (nullable), `exchange_id` (nullable), `idempotency_key` (unique, required), `amount`, `currency`, `method`, `staff_id`, and `created_at`.
5. IF a payment would cause the total paid to exceed the order total by more than ETB 0.01, THEN THE Finance_System SHALL reject the payment with `EXCEEDS_ORDER_TOTAL`.
6. WHEN a payment request is received with an `idempotency_key` that already exists in the `transactions` table, THE Finance_System SHALL return the existing transaction record without creating a duplicate and SHALL respond with HTTP 200 (not 201).
7. IF a payment request is received with an `idempotency_key` that exists but with different parameters (amount, order_id, etc.), THEN THE Finance_System SHALL reject the request with `IDEMPOTENCY_CONFLICT`.

---

### Requirement 3: Exchange Lifecycle State Machine

**User Story:** As a sales staff member, I want exchanges to follow a multi-step lifecycle so that each exchange can be reviewed and approved before inventory and finance are affected.

#### Acceptance Criteria

1. THE Exchange_System SHALL support the following exchange statuses: `INITIATED`, `REVIEWED`, `APPROVED`, `SETTLED`, `COMPLETED`, `CANCELLED`.
2. WHEN a staff member with `CREATE_SALE` permission creates an exchange, THE Exchange_System SHALL set its status to `INITIATED`.
3. WHEN a staff member with `APPROVE_EXCHANGE` permission reviews an `INITIATED` exchange, THE Exchange_System SHALL transition it to `REVIEWED` and compute the payment difference.
4. WHEN a staff member with `APPROVE_EXCHANGE` permission approves a `REVIEWED` exchange, THE Exchange_System SHALL transition it to `APPROVED` and lock the item values and settlement terms.
5. WHEN an `APPROVED` exchange is settled (all Settlement_Entries submitted and balanced), THE Exchange_System SHALL transition it to `SETTLED` and trigger inventory and finance updates atomically.
6. WHEN a `SETTLED` exchange has all financial obligations confirmed (all transaction records created and inventory movements recorded), THE Exchange_System SHALL automatically transition it to `COMPLETED`. Both inventory and finance MUST be fully resolved before this transition is allowed.
7. WHEN a staff member with `APPROVE_EXCHANGE` permission cancels an exchange in `INITIATED`, `REVIEWED`, or `APPROVED` status, THE Exchange_System SHALL transition it to `CANCELLED`.
8. IF an exchange is in `SETTLED` or `COMPLETED` status, THEN THE Exchange_System SHALL reject any cancellation attempt with `EXCHANGE_NOT_CANCELLABLE`.
9. THE Exchange_System SHALL store `original_order_id` (nullable) and `customer_id` (nullable) on each exchange record. WHEN `original_order_id` is provided and the referenced order has a `customer_id`, THE Exchange_System SHALL automatically inherit that `customer_id` if none is explicitly supplied.
10. THE Exchange_System SHALL include an `allowed_actions` array in every exchange API response. The array SHALL contain zero or more of: `review`, `approve`, `adjust`, `settle`, `complete`, `cancel`, `view`, `print` — computed from the current status and the requesting staff member's permissions.
11. WHEN `original_order_id` is provided, THE Exchange_System SHALL validate that the referenced order exists and is in `COMPLETED` or `FULFILLED` status. IF the order is not in a valid status, THE Exchange_System SHALL reject the exchange creation with `INVALID_SOURCE_ORDER`.

---

### Requirement 4: Exchange Item Model

**User Story:** As a sales staff member, I want to record both returned and new items on a single exchange record so that the full item swap is captured in one transaction.

#### Acceptance Criteria

1. THE Exchange_System SHALL support a unified `exchange_items` table with a `type` column of value `returned` or `new` to replace the separate `exchange_incoming_items` and `exchange_outgoing_items` tables (additive migration; old tables remain for backward compatibility).
2. WHEN an exchange is created, THE Exchange_System SHALL accept a list of `returned` items (books the customer brings back) and a list of `new` items (books the customer takes).
3. THE Exchange_System SHALL record for each exchange item: `exchange_id`, `book_id`, `quantity`, `unit_price`, `total_price`, `type` (`returned` or `new`), and `condition` (`resellable` or `damaged`, applicable only to `returned` items; defaults to `resellable`).
4. WHEN an exchange item is of type `returned`, THE Exchange_System SHALL use the evaluated/accepted price as `unit_price`.
5. WHEN an exchange item is of type `new`, THE Exchange_System SHALL use the selling price as `unit_price`.
6. WHEN an exchange transitions from `APPROVED` to `SETTLED`, THE Inventory_System SHALL add returned items with `condition = resellable` back to available stock. Returned items with `condition = damaged` SHALL be added to a `damaged_quantity` counter on the inventory record and SHALL NOT increase available stock.

---

### Requirement 5: Exchange Payment Difference Engine and Hybrid Settlement

**User Story:** As a sales staff member, I want the system to automatically calculate the payment difference for an exchange and support flexible multi-entry settlement so that I can negotiate and record the exact terms agreed with the customer.

#### Acceptance Criteria

1. THE Exchange_System SHALL calculate `difference = total_new_items_value - total_returned_items_value`.
2. WHEN `difference > 0`, THE Exchange_System SHALL set `settlement_type` to `Customer_Pays` and record the amount the customer owes.
3. WHEN `difference < 0`, THE Exchange_System SHALL set `settlement_type` to `Store_Refunds` and record the amount the store owes the customer.
4. WHEN `|difference| < ETB 0.01`, THE Exchange_System SHALL set `settlement_type` to `Even`.
5. THE Exchange_System SHALL support a multi-entry settlement model: a settlement consists of one or more `exchange_settlement_entries`, each with `entry_type` (`cash_payment`, `cash_refund`, `item_value_adjustment`), `amount`, `currency`, `method` (for cash entries), and an optional `note`.
6. WHEN a settlement is submitted, THE Exchange_System SHALL validate that the algebraic sum of all Settlement_Entries equals the calculated `difference` (within ETB 0.01 tolerance). IF the entries do not balance, THE Exchange_System SHALL reject the settlement with `SETTLEMENT_UNBALANCED`.
7. WHERE a manual override is required, a staff member with `APPROVE_EXCHANGE` permission MAY submit a Settlement_Entry of type `item_value_adjustment` with an `override_reason`. This entry MUST be logged in the audit trail with the authorising staff member's ID.
8. THE Exchange_System SHALL record the final `net_balance`, `settlement_type`, and the complete list of Settlement_Entries on the exchange record.
9. WHEN a settlement request is received with an `idempotency_key` that already exists, THE Exchange_System SHALL return the existing settlement result without re-processing and SHALL respond with HTTP 200.
10. IF a settlement request is received with an `idempotency_key` that exists but with different parameters, THE Exchange_System SHALL reject the request with `IDEMPOTENCY_CONFLICT`.

---

### Requirement 6: Exchange Inventory Integration

**User Story:** As a stock clerk, I want exchange approvals to automatically update inventory so that stock levels are always accurate after an exchange is settled.

#### Acceptance Criteria

1. WHEN an exchange transitions from `APPROVED` to `SETTLED`, THE Inventory_System SHALL add returned item quantities with `condition = resellable` back to the branch location's available stock.
2. WHEN an exchange transitions from `APPROVED` to `SETTLED`, THE Inventory_System SHALL add returned item quantities with `condition = damaged` to the `damaged_quantity` field on the inventory record without increasing available stock.
3. WHEN an exchange transitions from `APPROVED` to `SETTLED`, THE Inventory_System SHALL deduct new item quantities from the branch location's available stock.
4. IF a new item has insufficient available stock at the time of settlement, THEN THE Exchange_System SHALL reject the settlement with `INSUFFICIENT_STOCK`.
5. THE Inventory_System SHALL record an `inventory_history` entry for each item movement with `reference_type` of `exchange_in` (for returned resellable items), `exchange_damaged` (for returned damaged items), or `exchange_out` (for new items), and `reference_id` set to the `exchange_id`.
6. THE Inventory_System SHALL support `reference_type` values of `order`, `exchange_in`, `exchange_damaged`, and `exchange_out` in the `inventory_history` table (additive constraint extension; existing values are preserved).
7. All inventory changes for a single exchange settlement SHALL be applied within a single database transaction. If any change fails, all changes SHALL be rolled back.

---

### Requirement 7: Exchange Finance Integration

**User Story:** As a finance manager, I want exchange settlements to automatically create finance transaction records so that all cash flows from exchanges are tracked with full traceability.

#### Acceptance Criteria

1. WHEN an exchange is settled, THE Finance_System SHALL create one transaction record per Settlement_Entry of type `cash_payment` or `cash_refund`. Settlement_Entries of type `item_value_adjustment` SHALL be recorded as `adjustment` type transactions with zero cash amount.
2. Every transaction record created for an exchange MUST include `exchange_id`. If the exchange has an `original_order_id`, the transaction record SHALL also include that `order_id`.
3. Every transaction record MUST reference either an `order_id` or an `exchange_id` (or both). A transaction with neither SHALL be rejected with `MISSING_TRANSACTION_REFERENCE`.
4. THE Finance_System SHALL ensure all exchange transaction records include `exchange_id`, `order_id` (nullable), `type`, `amount`, `currency`, `method`, `idempotency_key`, `staff_id`, and `created_at`.
5. All transaction records for a single exchange settlement SHALL be created within the same database transaction as the inventory changes. If any record fails, all changes SHALL be rolled back.

---

### Requirement 8: Permission-Based Access Control

**User Story:** As a system administrator, I want all API access control to be based on named permissions rather than role names so that I can assign fine-grained capabilities to staff without changing role definitions.

#### Acceptance Criteria

1. THE Permission_System SHALL define the following permissions: `CREATE_SALE`, `PROCESS_PAYMENT`, `APPROVE_EXCHANGE`, `PROCESS_REFUND`, `ADJUST_PRICE`, `MANAGE_INVENTORY`, `VIEW_REPORTS`, `MANAGE_STAFF`, `MANAGE_BRANCH`.
2. THE Permission_System SHALL provide a `requirePermission(...permissions)` middleware that checks whether the authenticated staff member holds all specified permissions.
3. WHEN a staff member holds multiple roles, THE Permission_System SHALL compute the effective permission set as the UNION of all permissions from all assigned roles for the current branch session.
4. THE Permission_System SHALL replace all `requireRole(...)` calls in routes with `requirePermission(...)` calls using the appropriate permission.
5. IF a staff member does not hold the required permission, THEN THE Permission_System SHALL return HTTP 403 with error code `PERMISSION_DENIED` and a message identifying the missing permission.
6. THE Permission_System SHALL maintain a role-to-permissions mapping that can be extended without breaking existing role assignments.
7. THE Permission_System SHALL NOT require staff to switch profiles or re-authenticate to access permissions from a secondary role.

---

### Requirement 9: JWT and Multi-Role Staff Support

**User Story:** As a staff member with multiple roles, I want my JWT to carry my full effective permissions so that every API request can be authorised without additional database lookups per request.

#### Acceptance Criteria

1. WHEN a staff member logs in, THE Permission_System SHALL load all roles assigned to that staff member for the selected branch and compute the union of their permissions.
2. THE Permission_System SHALL include the full list of effective permissions as a `permissions` array in the JWT payload. The existing `role` field SHALL be retained for backward compatibility but SHALL reflect the primary (first) role.
3. WHEN a staff member's roles are updated, THE Permission_System SHALL reflect the change on the next login without requiring a system restart.
4. THE Permission_System SHALL preserve backward compatibility: staff with a single role SHALL continue to work without any change to their login flow. The `role` field in the JWT SHALL remain present and valid.
5. THE `requirePermission` middleware SHALL check the `permissions` array in the JWT. IF the `permissions` array is absent (legacy token), THE middleware SHALL fall back to deriving permissions from the `role` field using the role-to-permissions mapping.
6. THE Permission_System SHALL NOT increase JWT size beyond what is necessary. Permissions SHALL be encoded as a compact array of short string codes.

---

### Requirement 10: Multi-Branch and All-Branch Access

**User Story:** As a regional manager, I want to access data from all branches in a single view so that I can monitor operations across the entire organisation.

#### Acceptance Criteria

1. THE Branch_System SHALL support an `is_all_branches` flag on staff records that grants access to all branches.
2. WHEN a staff member has `is_all_branches = true`, THE Branch_System SHALL allow them to query any branch's data without being restricted to their assigned branch.
3. THE Branch_System SHALL include an "All Branches" option in report filters for staff with `is_all_branches = true`.
4. WHEN a staff member without `is_all_branches` accesses branch-scoped endpoints, THE Branch_System SHALL restrict results to their assigned branch only.
5. THE Branch_System SHALL preserve existing single-branch behaviour for staff without the `is_all_branches` flag.

---

### Requirement 11: POS and Order Item Visibility

**User Story:** As a sales staff member, I want to see the branch stock quantity for each item in the POS, Orders, and Exchange screens so that I can inform customers about availability.

#### Acceptance Criteria

1. WHEN a staff member searches for books in the POS interface, THE POS_System SHALL display the current available stock quantity (inventory quantity minus active reservations) for each book at the staff member's branch location.
2. WHEN an order's line items are retrieved, THE Order_System SHALL include the current available stock quantity for each book at the order's branch location.
3. WHEN an exchange's items are retrieved, THE Exchange_System SHALL include the current available stock quantity for each book at the exchange's branch location.
4. THE POS_System SHALL display the branch name alongside the stock quantity for each item.
5. WHEN available stock quantity is zero, THE POS_System SHALL visually indicate that the item is out of stock.

---

### Requirement 12: Backward Compatibility and Schema Migration

**User Story:** As a system administrator, I want all database and API changes to be strictly additive so that existing integrations and data are not broken during the production upgrade.

#### Acceptance Criteria

1. THE Order_System SHALL extend the `orders.status` column enum to include the new statuses (`DRAFT`, `PAID`, `COMPLETED`) without removing existing values.
2. THE Exchange_System SHALL add `status`, `original_order_id`, and `customer_id` columns to the `exchanges` table without removing existing columns.
3. THE Exchange_System SHALL add a new `exchange_items` table with `exchange_id`, `book_id`, `quantity`, `unit_price`, `total_price`, `type`, and `condition` columns; the existing `exchange_incoming_items` and `exchange_outgoing_items` tables SHALL remain intact.
4. THE Finance_System SHALL add `type`, `order_id`, `exchange_id`, and `idempotency_key` columns to the existing payments/transactions table, or create a new `financial_transactions` table, without altering existing payment table structure.
5. THE Inventory_System SHALL extend the `inventory_history.reference_type` constraint to include `order`, `exchange_in`, `exchange_damaged`, and `exchange_out` values without removing existing values.
6. THE Inventory_System SHALL add an `inventory_reservations` table and a `damaged_quantity` column to the `inventory` table (additive).
7. THE Exchange_System SHALL add an `exchange_settlement_entries` table for multi-entry settlement records (additive).
8. ALL existing API endpoints SHALL continue to function with their current request/response contracts. New fields added to responses are additive and SHALL NOT break existing clients.
9. WHEN the migration runs, THE Order_System SHALL map existing orders: `Pending → DRAFT`, `Confirmed/In_Progress → CONFIRMED`, `Fulfilled → FULFILLED`, `Cancelled → CANCELLED`. Orders with `payment_status = paid` AND `status = FULFILLED` SHALL be mapped to `COMPLETED`.
10. WHEN the migration runs, THE Exchange_System SHALL map existing exchanges: `Initiated/Evaluated → INITIATED`, `Completed → COMPLETED`, `Cancelled → CANCELLED`.

---

### Requirement 13: Audit and Observability

**User Story:** As a system administrator, I want all lifecycle transitions and permission checks to be logged so that I can audit the history of every order and exchange.

#### Acceptance Criteria

1. WHEN an order transitions between statuses, THE Order_System SHALL insert an audit log entry recording `staff_id`, `action`, `entity_type = order`, `entity_id`, `branch_id`, and `{ from_status, to_status }` in the `meta` field.
2. WHEN an exchange transitions between statuses, THE Exchange_System SHALL insert an audit log entry recording `staff_id`, `action`, `entity_type = exchange`, `entity_id`, `branch_id`, and `{ from_status, to_status }` in the `meta` field.
3. WHEN a settlement override (item_value_adjustment) is applied, THE Exchange_System SHALL insert an audit log entry recording the authorising `staff_id`, `override_reason`, and the override amount.
4. WHEN a permission check fails, THE Permission_System SHALL log the denied permission code, the staff member's ID, and the requested endpoint path.
5. THE Order_System SHALL emit outbox events for each status transition using the existing outbox pattern.
6. THE Exchange_System SHALL emit outbox events for each status transition using the existing outbox pattern.
7. WHEN a payment or settlement is deduplicated via idempotency key, THE Finance_System SHALL log the deduplication event with the original transaction ID and the duplicate request's `idempotency_key`.

---

### Requirement 14: Multi-Role, Multi-Branch Session Model

**User Story:** As a staff member with multiple roles across multiple branches, I want to log in once and have all my permissions automatically aggregated so that I never need to switch profiles or re-authenticate to access capabilities from a secondary role.

#### Acceptance Criteria

1. THE Permission_System SHALL support a two-step login flow: step 1 validates credentials and returns the list of accessible branches; step 2 completes login with the selected branch.
2. WHEN a staff member has access to only one branch, THE Permission_System SHALL auto-select that branch and complete login without showing a branch picker.
3. WHEN a staff member has access to multiple branches, THE Permission_System SHALL display a branch picker showing each branch's name and the staff member's roles at that branch.
4. WHEN a staff member has `is_all_branches = true`, THE Permission_System SHALL display all active branches in the picker with a 🌐 indicator.
5. THE Permission_System SHALL include a `roles` array (all roles for the active branch) in the JWT alongside the existing `role` field (primary role, retained for backward compatibility).
6. THE Branch_System SHALL provide a branch switcher in the top navigation bar that allows staff to change their active branch without re-authenticating.
7. WHEN a staff member switches branches, THE Permission_System SHALL issue a new access token with the permissions for the new branch and invalidate all cached data.
8. THE Permission_System SHALL NOT require staff to switch profiles or re-authenticate to access permissions from a secondary role assigned to the same branch.
9. THE Branch_System SHALL allow Admin/Super_Admin to grant `is_all_branches` access to any staff member via `PUT /api/staff/:id/all-branches`.
10. THE Permission_System SHALL display all roles held by the staff member at the active branch as informational tags in the top navigation bar. These tags are display-only and do not affect access control.
11. THE Permission_System SHALL gate all form visibility (New Order, New Exchange, etc.) on the staff member's effective permissions, not on a single role name. A user with `Stock_Clerk + Sales` roles MUST see the New Order form because they hold `CREATE_SALE` permission.
12. THE Permission_System SHALL ensure the `POST /api/auth/pre-login` endpoint is exempt from CSRF validation, as it is called before any session cookie exists.

---

### Requirement 15: Session Persistence and Inactivity

**User Story:** As a staff member, I want my session to persist across page refreshes so that I do not lose my work when I accidentally reload the browser tab.

#### Acceptance Criteria

1. WHEN a staff member refreshes the browser (F5), THE Permission_System SHALL silently restore their session using the refresh token cookie without showing the login page.
2. THE Permission_System SHALL use an 8-hour refresh token cookie (covering a full work shift). The inactivity timer (15 minutes) handles security within the session.
3. WHEN a staff member is inactive for 15 minutes, THE Permission_System SHALL display a 1-minute warning overlay before automatically logging them out.
4. WHEN a staff member is automatically logged out due to inactivity, THE Permission_System SHALL redirect them to the login page.
5. THE Permission_System SHALL NOT log out a staff member on page refresh if their session is still valid.
