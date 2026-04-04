# Requirements Document — Bookstore Management System

## 1. System Overview

### Purpose

The Bookstore Management System (BMS) is a multi-user, multi-role, multi-branch ERP platform for managing physical bookstore operations. It covers the full operational lifecycle: catalog and inventory management, procurement, point-of-sale, customer management, order fulfillment, merchant exchange (in-kind trading), partial and installment payments, bank account management and reconciliation, reporting, and role-based access control.

### Scope

The system is a single-tenant deployment serving one business with multiple physical branches. Multi-tenancy is out of scope for v1.

### Target Users

- Sales staff processing daily transactions at the register
- Stock Clerks managing inventory and receiving stock
- Purchasors handling procurement and supplier relationships
- Branch and regional Managers overseeing daily operations
- Finance Officers performing reconciliation and financial oversight
- Admins managing operational policies, staff, and multi-branch oversight
- Super Admins managing system configuration, platform settings, and audit integrity

### Inside the System Boundary

- Catalog, inventory, and location management
- Point-of-sale transaction processing
- Order creation, fulfillment, and payment collection
- Procurement and purchase order management
- Customer profiles, store credit, and loyalty points
- Merchant exchange (in-kind trading)
- Bank account records and manual reconciliation
- Role-based access control and staff management
- Audit logging, reporting, and dashboards
- Asynchronous background workers (outbox, notifications, reports, loyalty, installment checks)

### Outside the System Boundary

- Live payment gateway or card network integration (card payments are recorded as completed by the Sales staff after physical terminal approval)
- Live bank API integration (reconciliation is manual CSV import only)
- Accounting journal entry generation (the system provides data sufficient for an accountant to do so)
- Multi-currency transactions
- Binary image storage (cover images are stored as URLs pointing to an external CDN)

---

## 2. System Context & Actors

### Human Actors

| Actor | Scope | Primary Responsibilities | Key Restrictions |
|-------|-------|--------------------------|-----------------|
| Super_Admin | Global only | System configuration, platform settings, tenant management, audit integrity | No operational transactions; no day-to-day business actions |
| Admin | Global or Multi-Branch | Operational oversight, staff management, multi-branch policy, financial approvals | No system settings; no direct transaction processing |
| Manager | Single, Multi, or Global | Daily branch/warehouse operations, fulfillment, reporting, exchange approvals | Cannot approve own expenses; limited financial authority |
| Finance_Officer | Global or Multi-Branch | Financial reconciliation, payment oversight, bank account management, read-only audit | Cannot create POs, receive inventory, or modify staff |
| Stock_Clerk | Single, Multi, or Global | Inventory handling, stock adjustments, transfers, receiving against POs | Cannot create POs; no cash handling |
| Sales | Shop-scoped only | POS transactions, returns within policy, customer service, order management | Cannot void closed batches; returns limited by policy |
| Purchasor | Single, Multi, or Global | Procurement, supplier management, PO creation and tracking | Cannot receive inventory; cannot approve payments |

### System Actors (Automated)

| Actor | Responsibility |
|-------|---------------|
| Outbox_Poller | Polls the `outbox` table and publishes domain events to BullMQ; runs continuously |
| Notification_Worker | Consumes outbound notification jobs from BullMQ and delivers email/SMS via external provider (SendGrid/Twilio) |
| InApp_Notification_Worker | Consumes internal notification jobs from BullMQ, writes to `in_app_notifications` table, and pushes to connected SSE clients |
| Report_Worker | Executes async report generation jobs queued by the API |
| Loyalty_Worker | Processes loyalty point accrual after Transaction completion |
| Installment_Checker | Daily cron that scans `installments` for overdue records and updates their status |
| Reconciliation_Worker | Matches imported bank statement rows to payment/refund records |

### External Systems (Outside Boundary)

| System | Integration Mode | Failure Behavior |
|--------|-----------------|-----------------|
| Email/SMS Provider (e.g., SendGrid, Twilio) | Outbound only; called by Notification_Worker | Failure degrades gracefully; core operations are not blocked |
| Bank Statement CSV Import | Manual file upload via UI; no live bank API | Import failure rolls back the batch; no partial state |
| Payment Card Terminal | Physical device at POS; system records outcome only | System does not integrate with card network directly |

### Context Diagram (Textual)

```
                        ┌──────────────────────────────────────┐
                        │   Bookstore Management System         │
                        │                                       │
  Super_Admin ─────────►│  System Config, Platform, Audit       │
  Admin ───────────────►│  Staff, Branches, Policy, Approvals   │
  Manager ─────────────►│  Operations, Fulfillment, Reports     │
  Finance_Officer ─────►│  Reconciliation, Payments, Audit R/O  │
  Stock_Clerk ──────────►│  Inventory, Receiving, Transfers      │
  Sales ────────────────►│  POS, Returns, Orders, Customers      │
  Purchasor ────────────►│  Procurement, Suppliers, POs          │
                        │                                       │
                        │  [Outbox_Poller] ──────────────────►  │──► BullMQ
                        │  [Notification_Worker] ◄──────────────│◄── BullMQ (outbound: email/SMS)
                        │  [InApp_Notification_Worker] ◄────────│◄── BullMQ (internal: SSE push)
                        │  [Report_Worker] ◄────────────────────│◄── BullMQ
                        │  [Loyalty_Worker] ◄───────────────────│◄── BullMQ
                        │  [Installment_Checker] (cron)         │
                        │  [Reconciliation_Worker] ◄────────────│◄── BullMQ
                        └──────────────┬────────────────────────┘
                                       │
              ┌────────────────────────┼────────────────────────┐
              ▼                        ▼                         ▼
  Email/SMS Provider         Bank Statement CSV            Card Terminal
  (SendGrid/Twilio)          (manual upload)               (physical device)
  [notification delivery]    [reconciliation import]       [outcome recorded only]
```

---

## 3. Domain Model Overview

### Core Entities and Relationships

| Entity | Key Attributes | Relationships |
|--------|---------------|---------------|
| system_config | key, value, updated_by, updated_at | — |
| branch_config | branch_id, key, value, updated_by, updated_at | belongs to Branch |
| Staff | id, username, password_hash, full_name, is_active | many-to-many with Branch via staff_branch_roles |
| staff_branch_roles | staff_id, branch_id, role | joins Staff ↔ Branch |
| Branch | id, name, address, contact_info, operating_hours, is_active | has many Locations, Bank_Accounts, staff_branch_roles |
| Location | id, branch_id, name, is_default_fulfillment | belongs to Branch; has many Inventory records |
| Bank_Account | id, branch_id, account_name, bank_name, account_number (encrypted), iban (encrypted, nullable), currency, is_active | belongs to Branch |
| Book | id, isbn (unique), title, authors[], genre, publisher, edition, language, format, description, cover_image_url, default_price, trade_value, is_active | has many book_branch_prices, book_categories, book_tags, book_edit_history |
| book_branch_prices | book_id, branch_id, price | joins Book ↔ Branch |
| book_categories | book_id, category | belongs to Book |
| book_tags | book_id, tag | belongs to Book |
| book_edit_history | id, book_id, field_name, old_value, new_value, changed_by, changed_at | belongs to Book |
| Inventory | book_id, location_id, quantity, reorder_point, version | composite PK (book_id, location_id); has many inventory_history |
| inventory_history | id, book_id, location_id, qty_before, qty_after, delta, reason, reason_code, staff_id, created_at | belongs to Inventory |
| Supplier | id, name (unique), contact_info, lead_time_days, pricing_terms, supplier_type, publisher_id (nullable), is_active, is_blacklisted | has many PurchaseOrders; optionally references Publisher |
| book_suppliers | book_id, supplier_id, supplier_sku (nullable), is_primary | joins Book ↔ Supplier |
| PurchaseOrder | id, po_number (unique), supplier_id, branch_id, location_id, status, bank_account_id (nullable), notes, created_by, created_at | has many PO_LineItems, PO_Receipts |
| PO_LineItem | id, po_id, book_id, qty_ordered, qty_received, unit_price | belongs to PurchaseOrder |
| PO_Receipt | id, po_id, line_item_id, qty_received, over_receipt, confirmed_by, received_by, received_at | belongs to PurchaseOrder |
| Customer | id, full_name, email (encrypted, nullable), phone (encrypted, nullable), notes, preferences, store_credit, loyalty_points, version, is_active | has many Transactions, Orders, loyalty_history, store_credit_history |
| loyalty_history | id, customer_id, delta, balance_after, reason, transaction_ref, created_at | belongs to Customer |
| store_credit_history | id, customer_id, delta, balance_after, reason, reference_id, created_at | belongs to Customer |
| Transaction | id, branch_id, location_id, customer_id (nullable), staff_id, status, subtotal, discount_total, tax_rate, tax_amount, total, created_at, completed_at | has many transaction_line_items, transaction_payments |
| transaction_line_items | id, transaction_id, book_id, quantity, unit_price, discount_amount, discount_reason, line_total | belongs to Transaction |
| transaction_payments | id, transaction_id, method, amount, bank_account_id (nullable), created_at | belongs to Transaction |
| Return | id, original_tx_id, branch_id, location_id, staff_id, manager_auth_id (nullable), status, created_at | has many return_line_items, refunds |
| return_line_items | id, return_id, tx_line_id, quantity, refund_amount | belongs to Return |
| refunds | id, return_id, method, amount, bank_account_id (nullable), reason, created_at | belongs to Return |
| Order | id, order_number (unique), customer_id, branch_id, location_id, channel, status, tax_rate, subtotal, tax_amount, total, cancel_reason, created_by, created_at | has many order_line_items, order_payments, order_refunds, InstallmentPlan |
| order_line_items | id, order_id, book_id, quantity, unit_price, qty_reserved, is_backordered | belongs to Order |
| InstallmentPlan | id, order_id, deposit_amount, total_amount, created_by, created_at | belongs to Order; has many Installments |
| Installment | id, plan_id, due_date, amount, paid_amount, status | belongs to InstallmentPlan |
| order_payments | id, order_id, method, amount, bank_account_id (nullable), staff_id, version, created_at | belongs to Order |
| order_refunds | id, order_id, payment_id, amount, method, bank_account_id (nullable), reason, staff_id, created_at | belongs to Order |
| Merchant | id, name (unique), contact_info, address, is_active | has many Exchange_Agreements |
| Exchange_Agreement | id, merchant_id, exchange_basis, terms, is_active | belongs to Merchant; has many Exchange_Orders |
| Exchange_Order | id, agreement_id, status, offered_trade_value, requested_trade_value, adjustment_amount, adjustment_type, source_location_id, destination_location_id, created_by, created_at | has many exchange_order_lines |
| exchange_order_lines | id, exchange_order_id, direction, book_id, quantity, trade_value | belongs to Exchange_Order |
| Audit_Log | id, staff_id, staff_role, action, entity_type, entity_id, branch_id, meta (JSONB, masked PII), hmac_signature, created_at | append-only; no FK constraints |
| Outbox | id, event_type, payload (JSONB), status, created_at, published_at | relay table for domain events |
| Idempotency_Keys | key (UUID v4, PK), response_payload (JSONB), created_at, expires_at | 24h TTL deduplication |
| bank_reconciliation | id, bank_account_id, payment_ref_id (nullable), refund_ref_id (nullable), amount, direction, status, statement_date, notes, created_at | belongs to Bank_Account |

---

## 4. Entity Lifecycle & State Machines

### 4.1 Transaction

| State | Description |
|-------|-------------|
| `draft` | Created by Sales or Manager; line items being added |
| `completed` | Payment recorded, inventory decremented, receipt generated — IMMUTABLE |
| `voided` | Voided before completion; any reserved inventory released |

**Allowed Transitions:**

| From | To | Trigger | Actor |
|------|----|---------|-------|
| `draft` | `completed` | All payments recorded, stock confirmed | Sales, Manager |
| `draft` | `voided` | Explicit void action | Sales, Manager |

**Invalid Transitions:**
- `completed` → `voided`: FORBIDDEN — corrections must use the Returns process
- `completed` → `draft`: FORBIDDEN
- `voided` → any: FORBIDDEN

---

### 4.2 Order

| State | Description |
|-------|-------------|
| `Pending` | Created; no stock reserved |
| `Confirmed` | Stock reserved at fulfillment location |
| `In_Progress` | Being picked/packed |
| `Fulfilled` | Inventory decremented, invoice generated — IMMUTABLE |
| `Cancelled` | Cancelled from any non-Fulfilled state; reserved stock released |

**Allowed Transitions:**

| From | To | Trigger | Actor |
|------|----|---------|-------|
| `Pending` | `Confirmed` | Stock reservation succeeds | Manager, Sales |
| `Pending` | `Cancelled` | Explicit cancel | Manager |
| `Confirmed` | `In_Progress` | Picking started | Manager, Sales |
| `Confirmed` | `Cancelled` | Explicit cancel; releases reserved stock | Manager |
| `In_Progress` | `Fulfilled` | Inventory decremented, invoice generated | Manager |
| `In_Progress` | `Cancelled` | Explicit cancel; releases reserved stock | Manager |

**Invalid Transitions:**
- `Fulfilled` → any: FORBIDDEN
- `Cancelled` → any: FORBIDDEN

---

### 4.3 Purchase Order (PO)

| State | Description |
|-------|-------------|
| `PendingApproval` | Created; total exceeds `po_approval_threshold`; awaiting Manager/Admin approval |
| `Pending` | Approved (or below threshold); awaiting receipt |
| `In_Progress` | Partial receipt recorded |
| `Closed` | All line items fully received OR manually closed by Manager |
| `Cancelled` | Cancelled from PendingApproval or Pending only |

**Allowed Transitions:**

| From | To | Trigger | Actor |
|------|----|---------|-------|
| `PendingApproval` | `Pending` | Manager/Admin approves PO | Manager, Admin |
| `PendingApproval` | `Cancelled` | Explicit cancel or rejection | Manager, Admin |
| `Pending` | `In_Progress` | First partial receipt recorded | Manager, Stock_Clerk |
| `Pending` | `Cancelled` | Explicit cancel | Manager |
| `In_Progress` | `Closed` | All lines fully received | System (automatic) |
| `In_Progress` | `Closed` | Manual close by Manager | Manager |

**Invalid Transitions:**
- `Closed` → any: FORBIDDEN
- `Cancelled` → any: FORBIDDEN
- `In_Progress` → `Cancelled`: FORBIDDEN

---

### 4.4 Exchange_Order

| State | Description |
|-------|-------------|
| `Pending` | Created; awaiting merchant acceptance |
| `Accepted` | Merchant has agreed to terms |
| `Settled` | Inventory atomically swapped |
| `Cancelled` | Cancelled from Pending or Accepted only |

**Allowed Transitions:**

| From | To | Trigger | Actor |
|------|----|---------|-------|
| `Pending` | `Accepted` | Merchant acceptance recorded | Manager |
| `Pending` | `Cancelled` | Explicit cancel | Manager |
| `Accepted` | `Settled` | Settlement confirmed; inventory swapped atomically | Manager |
| `Accepted` | `Cancelled` | Explicit cancel | Manager |

**Invalid Transitions:**
- `Settled` → any: FORBIDDEN
- `Cancelled` → any: FORBIDDEN

---

### 4.5 Installment

| State | Description |
|-------|-------------|
| `pending` | Scheduled; no payment received |
| `partial` | Some payment received; not fully paid |
| `paid` | Fully paid |
| `overdue` | Due date passed with outstanding balance > 0 (set by Installment_Checker cron) |

**Allowed Transitions:**

| From | To | Trigger | Actor |
|------|----|---------|-------|
| `pending` | `partial` | Partial payment recorded | Sales, Manager, Finance_Officer |
| `pending` | `paid` | Full payment recorded | Sales, Manager, Finance_Officer |
| `pending` | `overdue` | Due date passed; balance > 0 | Installment_Checker (cron) |
| `partial` | `paid` | Remaining balance paid | Sales, Manager, Finance_Officer |
| `partial` | `overdue` | Due date passed; balance > 0 | Installment_Checker (cron) |
| `overdue` | `partial` | Partial payment recorded after overdue | Sales, Manager, Finance_Officer |

**Invalid Transitions:**
- `paid` → any: FORBIDDEN
- `overdue` → `paid`: FORBIDDEN — must transition through `partial` first

---

### 4.6 Bank Reconciliation Entry

| State | Description |
|-------|-------------|
| `uncleared` | Imported or created; not yet matched |
| `cleared` | Manually or automatically matched to a payment or refund record |
| `unmatched` | Import entry that could not be matched after review |

**Allowed Transitions:**

| From | To | Trigger | Actor |
|------|----|---------|-------|
| `uncleared` | `cleared` | Matched to payment_ref_id or refund_ref_id | Manager, Reconciliation_Worker |
| `uncleared` | `unmatched` | Marked as unmatched after review | Manager |

**Invalid Transitions:**
- `cleared` → `uncleared`: FORBIDDEN

---

### 4.7 Staff Account

| State | Description |
|-------|-------------|
| `active` | Can log in; sessions valid |
| `inactive` | All sessions immediately invalidated; cannot log in |

**Allowed Transitions:**

| From | To | Trigger | Actor |
|------|----|---------|-------|
| `active` | `inactive` | Deactivation | Admin |
| `inactive` | `active` | Reactivation (restores all prior branch-role assignments) | Admin |

---

## 5. Data Integrity & Constraints

### 5.1 Unique Constraints

| Column | Scope | Notes |
|--------|-------|-------|
| `books.isbn` | System-wide | ISBN-13 format; check digit validated on entry |
| `staff.username` | System-wide | |
| `customers.email` | System-wide | Nullable; unique when non-null |
| `customers.phone` | System-wide | Nullable; unique when non-null |
| `branches.name` | System-wide | |
| `locations.(branch_id, name)` | Per branch | Composite unique |
| `suppliers.name` | System-wide | |
| `purchase_orders.po_number` | System-wide | |
| `orders.order_number` | System-wide | |
| `idempotency_keys.key` | System-wide | UUID v4; TTL 24h |
| `bank_accounts.account_number` | None | Same account may be registered at multiple branches |

### 5.2 Foreign Key Behavior

| Parent Entity | Delete/Deactivate Behavior |
|---------------|---------------------------|
| Branch | RESTRICT deletion if has Locations, Staff assignments, Inventory, or open Orders |
| Location | RESTRICT deletion if has Inventory (quantity > 0) or open Orders |
| Supplier | RESTRICT deletion if has any POs |
| Book | Soft deactivate only; historical records retain reference |
| Customer | Soft deactivate only; historical records retain reference |
| Staff | Soft deactivate only; Audit_Log retains staff_id reference |

### 5.3 Nullability Rules

| Field | Nullable | Constraint |
|-------|----------|-----------|
| `customers.email` | Yes | At least one of email or phone MUST be non-null per customer |
| `customers.phone` | Yes | At least one of email or phone MUST be non-null per customer |
| `transactions.customer_id` | Yes | Anonymous walk-in transactions are allowed |
| `bank_accounts.iban` | Yes | Optional |
| `purchase_orders.bank_account_id` | Yes | Optional supplier payment linkage |
| `exchange_order.adjustment_type` | No | Required when adjustment_amount != 0 |

### 5.4 Soft Delete vs Hard Delete Policy

| Policy | Entities |
|--------|---------|
| SOFT DELETE (`is_active` flag) | Staff, Branch, Location, Book, Supplier, Customer, Bank_Account, Merchant, Exchange_Agreement |
| HARD DELETE permitted | Draft Transactions with no payments (via void); Pending POs with no receipts (via cancel) |
| HARD DELETE NEVER permitted | Any entity with associated financial records (Transactions, Orders, POs, Payments) |
| NO DELETE by any role | Audit_Log (append-only) |

### 5.5 Optimistic Locking

The following tables carry a `version INTEGER NOT NULL DEFAULT 0` column incremented on every mutation:

- `inventory`: all quantity updates (sale, transfer, adjustment, PO receipt, exchange settlement)
- `order_payments`: outstanding balance updates
- `customers`: `store_credit` and `loyalty_points` updates

**Conflict detection pattern:**
```sql
UPDATE inventory
SET quantity = $1, version = version + 1
WHERE book_id = $2 AND location_id = $3 AND version = $4
```
Zero rows updated → return `409 VERSION_CONFLICT { retryable: true, currentVersion }`.

The client SHOULD retry up to 3 times with a fresh version read before surfacing the error to the user.

---

## 6. Concurrency Rules

### 6.1 Inventory

- **Strategy:** Optimistic locking (version counter)
- All inventory mutations (sale, transfer, adjustment, PO receipt, exchange settlement) read the current version and write with `version + 1`
- On conflict (0 rows updated): return `409 { error: "VERSION_CONFLICT", retryable: true, currentVersion }`
- Client SHOULD retry up to 3 times with a fresh version read before surfacing the error to the user
- Stock reservation for Orders uses `SELECT FOR UPDATE` (pessimistic) to prevent overselling during confirmation

### 6.2 Payments

- **Strategy:** Pessimistic locking (`SELECT FOR UPDATE` on the Order row)
- Before recording any payment against an Order, the Order row is locked to serialize concurrent payment attempts
- Outstanding balance check and payment insert happen within the same locked transaction
- Prevents double-payment race condition where two Sales staff simultaneously record payment against the same Order

### 6.3 Transaction Completion (POS)

- Inventory decrement uses optimistic locking (version check)
- Payment recording uses pessimistic lock on the Transaction row
- Loyalty accrual is async (outbox) — does NOT block the completion response
- The entire completion is wrapped in a single DB transaction at `REPEATABLE READ` isolation
- On any failure: full rollback, `503` with `Retry-After` header

### 6.4 Idempotency

- All POST endpoints that create financial records MUST accept an `Idempotency-Key` header (UUID v4)
- Key stored in `idempotency_keys` table with response payload and 24h TTL
- Duplicate key within 24h: return `200` with original response + `X-Idempotent-Replayed: true` header
- Key uniqueness enforced at DB level (PRIMARY KEY on `idempotency_keys.key`)

---

## 7. Financial Consistency Rules

### 7.1 Payment Recording

- Every payment event MUST produce exactly one payment record
- Payment amount MUST be > 0
- Sum of all payment amounts for a Transaction MUST equal `transaction.total` exactly (no rounding tolerance beyond 2 decimal places)
- Sum of all payment amounts for an Order MUST NOT exceed `order.total`
- Outstanding balance = `order.total − SUM(order_payments.amount) + SUM(order_refunds.amount)`
- Outstanding balance MUST never be negative

### 7.2 Refund Logic

- Refund amount per payment record MUST NOT exceed the original payment amount for that record
- Total refunds across all payment records for a Transaction MUST NOT exceed the Transaction total
- Store_Credit refund: atomically increases `customer.store_credit` within the same DB transaction as the refund record insert
- Bank transfer refund: linked to an active Bank_Account of the current Branch; creates a `bank_reconciliation` entry with `direction='out'`

### 7.3 Store Credit Lifecycle

- **Issued by:** refund (Returns process), Exchange_Order adjustment (`store_credit` type)
- **Consumed by:** Transaction payment (`method='store_credit'`), Order payment (`method='store_credit'`)
- Balance MUST never go below 0; any redemption that would result in a negative balance is rejected with `422`
- All store_credit changes MUST be recorded in `store_credit_history` (customer_id, delta, balance_after, reason, reference_id, created_at)

### 7.4 Loyalty Points Lifecycle

- **Accrued:** asynchronously after Transaction completion; `floor(transaction.total × accrual_rate)` points added
- **Redeemed:** synchronously during Transaction payment; 1 point = 1 unit of base currency (configurable)
- Balance MUST never go below 0
- All changes recorded in `loyalty_history` (customer_id, delta, balance_after, reason, transaction_ref, created_at)

### 7.5 Bank Reconciliation Consistency

- Every bank transfer payment (incoming) MUST create a `bank_reconciliation` entry with `direction='in'`, `status='uncleared'`
- Every bank transfer refund (outgoing) MUST create a `bank_reconciliation` entry with `direction='out'`, `status='uncleared'`
- Clearing a reconciliation entry links it to a specific `payment_ref_id` or `refund_ref_id`
- Unmatched import entries (from CSV) are created with `status='unmatched'` and no payment/refund reference
- The sum of all cleared `'in'` entries minus cleared `'out'` entries for a Bank_Account MUST equal the reconciled balance for that account

### 7.6 Exchange Trade Value Adjustment

- If `offered_trade_value > requested_trade_value`: business receives cash/store_credit adjustment (positive)
- If `offered_trade_value < requested_trade_value`: business pays cash/store_credit adjustment (negative)
- `adjustment_amount = ABS(offered_trade_value − requested_trade_value)`
- `adjustment_type` (cash or store_credit) is set at Exchange_Order creation and cannot be changed after `Accepted` status

---

## 8. Functional Requirements

### Glossary

- **System**: The Bookstore Management System as a whole.
- **Branch**: A physical bookstore location owned by the business.
- **Location**: A named stock area within a Branch (e.g., main floor, warehouse, back room).
- **Book**: A catalog item identified by ISBN, title, author(s), and other bibliographic attributes.
- **Catalog**: The master list of all Books available in the System.
- **Inventory**: The stock of Books held at a specific Location.
- **Supplier**: An external vendor from whom the business procures Books.
- **PO (Purchase Order)**: A formal order sent to a Supplier requesting Books.
- **Customer**: A registered individual who purchases Books from the business.
- **Loyalty_Program**: An optional rewards scheme that accrues points for Customer purchases.
- **Transaction**: A completed sales event processed at a Branch POS.
- **Order**: A customer request to purchase one or more Books, fulfilled from a Branch/Location.
- **Installment_Plan**: A scheduled series of payments covering the outstanding balance of an Order.
- **Partial_Payment**: A Transaction or Order payment split across multiple payment methods or installments.
- **Merchant**: A neighboring bookstore registered in the Merchant Directory for in-kind exchanges.
- **Exchange_Agreement**: Defined terms between the business and a Merchant for in-kind book trading.
- **Exchange_Order**: A formal request to trade Books with a Merchant under an Exchange_Agreement.
- **Trade_Value**: The value assigned to a Book for exchange purposes, which may differ from its retail price.
- **Settlement**: The confirmation that both sides of an Exchange_Order have delivered their Books.
- **Role**: A named set of permissions assigned to a Staff account. Valid roles: `Super_Admin`, `Admin`, `Manager`, `Finance_Officer`, `Stock_Clerk`, `Sales`, `Purchasor`.
- **Staff**: An employee with a System account and an assigned Role.
- **Audit_Log**: An immutable, append-only record of write actions performed within the System.
- **Report**: A generated summary of business data for a specified scope and time period.
- **Configuration**: System-wide or Branch-level settings that govern operational rules and defaults.
- **Bank_Account**: A Branch-owned bank account record used for receiving customer payments and issuing refunds via bank transfer.
- **Store_Credit**: A monetary balance held on a Customer's account, usable as a payment method in Transactions.
- **Outbox**: An append-only relay table used to guarantee domain event delivery without blocking the originating write.
- **Idempotency_Key**: A client-supplied UUID v4 used to deduplicate financial write requests within a 24-hour window.
- **In_App_Notification**: A real-time internal alert delivered to a Staff member's browser session via Server-Sent Events (SSE), used for approval requests, job completions, and entity-level alerts.
- **SSE (Server-Sent Events)**: A unidirectional HTTP streaming mechanism used to push real-time in-app notifications from the server to the browser without polling.

---

### Requirement 1: Configuration & System Settings

**User Story:** As a Super_Admin or Admin, I want to configure system-wide and branch-level business rules, so that all operational modules behave consistently according to policy without requiring code changes.

#### Acceptance Criteria

**1.1 — General / Financial**

1. THE System SHALL store a `base_currency` value at the system level; this value MUST be set before any financial record is created.
2. THE System SHALL store a `tax_rate` (NUMERIC(6,4)) at the system level and allow it to be overridden at the Branch level; the Branch-level value takes precedence when both are present.
3. THE System SHALL store a `fiscal_year_start_month` (INTEGER 1–12) at the system level to anchor reporting periods.

**1.2 — Discount Rules**

4. THE System SHALL store a `max_line_discount_pct` (NUMERIC(5,2), 0–100) per Role at the system level, defining the maximum discount a Staff member of that Role may apply to a single line item without manager approval.
5. THE System SHALL store a `max_transaction_discount_pct` (NUMERIC(5,2), 0–100) at the system level, defining the maximum total transaction-level discount allowed.
6. THE System SHALL store a `discount_approval_threshold_pct` (NUMERIC(5,2)) at the system level; any discount exceeding this threshold SHALL require explicit Manager-level confirmation before the Transaction can be completed.
7. THE System SHALL allow Branch-level overrides for `max_line_discount_pct` and `max_transaction_discount_pct`.

**1.3 — Inventory**

8. THE System SHALL store a `reorder_point_default` (INTEGER, units) at the system level as the fallback reorder threshold for any Location that has not set its own reorder point.
9. THE System SHALL store an `allow_negative_stock` (BOOLEAN, default false) flag at the system level; when false, any operation that would reduce stock below zero SHALL be blocked unless a Manager-level override is explicitly confirmed.

**1.4 — Procurement**

10. THE System SHALL store a `po_approval_threshold` (NUMERIC(14,2)) at the system level; any PO whose total value exceeds this amount SHALL require explicit Admin or Manager approval before it can be submitted to a Supplier.
11. THE System SHALL store a `default_supplier_lead_time_days` (INTEGER) at the system level as the fallback lead time when a Supplier record does not specify one.

**1.5 — Returns & Refunds**

12. THE System SHALL store a `return_window_days` (INTEGER) at the system level; returns requested after this window SHALL require Manager-level authorization.
13. THE System SHALL store a `max_return_value_without_auth` (NUMERIC(14,2)) at the system level; returns whose refund value exceeds this amount SHALL require Manager-level authorization regardless of the return window.
14. THE System SHALL store a `refund_method_after_window` (TEXT: `any` | `store_credit_only`) at the system level; when set to `store_credit_only`, refunds on out-of-window returns SHALL only be issued as Store_Credit.

**1.6 — Payments & Installments**

15. THE System SHALL store a `min_deposit_pct` (NUMERIC(5,2), 0–100) at the system level as the minimum deposit percentage required when creating an Installment_Plan.
16. THE System SHALL store a `max_installments` (INTEGER) at the system level, defining the maximum number of installments allowed in a single Installment_Plan.
17. THE System SHALL store an `installment_grace_period_days` (INTEGER) at the system level; an installment SHALL not be marked `overdue` until this many days after its `due_date` have elapsed.
18. THE System SHALL store `allowed_payment_methods` (TEXT[]) per Branch, defining which payment methods are permitted at that Branch; any payment method not in this list SHALL be rejected with `422 PAYMENT_METHOD_NOT_ALLOWED`.

**1.7 — Loyalty Program**

19. THE System SHALL store a `loyalty_accrual_rate` (NUMERIC(8,6), points per currency unit) at the system level.
20. THE System SHALL store a `loyalty_redemption_rate` (NUMERIC(8,6), currency units per point) at the system level; this value defines how much monetary value one loyalty point is worth at redemption (default: 1 point = 1 base currency unit).
21. THE System SHALL store a `loyalty_min_transaction_amount` (NUMERIC(14,2)) at the system level; Transactions below this amount SHALL NOT accrue loyalty points.

**1.8 — Merchant Exchange**

22. THE System SHALL store an `exchange_cash_adjustment_allowed` (BOOLEAN) at the system level; when false, any trade value difference on an Exchange_Order SHALL only be settled as Store_Credit, not cash.

**1.9 — Notifications**

23. THE System SHALL store notification preferences (low-stock alerts, payment reminders, order status changes, PO approval requests, installment overdue alerts) per Branch as a JSONB configuration value.

**1.10 — General Rules**

24. WHEN a Branch-level configuration key is absent, THE System SHALL return the system-wide default value for that key in all effective-config lookups.
25. WHEN a Super_Admin or Admin saves a Configuration change, THE System SHALL insert a row into the Outbox within the same DB transaction, containing: config key, previous value, new value, Staff actor ID, timestamp, and Branch context (if applicable); the Outbox_Poller SHALL subsequently write the Audit_Log entry.
26. THE System SHALL restrict system-level Configuration writes to Staff with the `Super_Admin` Role; Branch-level Configuration writes are additionally permitted for `Admin` and `Manager` Roles within their assigned scope.

#### Config Key Reference

| Key | Type | Scope | Default | Description |
|-----|------|-------|---------|-------------|
| `base_currency` | TEXT | System | — | ISO 4217 currency code (e.g. USD) |
| `tax_rate` | NUMERIC(6,4) | System / Branch | 0 | Default tax rate (0–1) |
| `fiscal_year_start_month` | INTEGER | System | 1 | Month number (1=Jan) |
| `max_line_discount_pct` | JSONB (per role) | System / Branch | {} | Max line discount % per role |
| `max_transaction_discount_pct` | NUMERIC(5,2) | System / Branch | 100 | Max transaction discount % |
| `discount_approval_threshold_pct` | NUMERIC(5,2) | System | 20 | Discount % requiring manager approval |
| `reorder_point_default` | INTEGER | System | 5 | Default reorder threshold (units) |
| `allow_negative_stock` | BOOLEAN | System | false | Allow stock to go below zero |
| `po_approval_threshold` | NUMERIC(14,2) | System | 0 | PO value requiring approval |
| `default_supplier_lead_time_days` | INTEGER | System | 7 | Fallback supplier lead time |
| `return_window_days` | INTEGER | System / Branch | 30 | Days within which returns are allowed |
| `max_return_value_without_auth` | NUMERIC(14,2) | System | 500 | Max refund without manager auth |
| `refund_method_after_window` | TEXT | System | `any` | `any` or `store_credit_only` |
| `min_deposit_pct` | NUMERIC(5,2) | System / Branch | 20 | Min installment deposit % |
| `max_installments` | INTEGER | System | 12 | Max installments per plan |
| `installment_grace_period_days` | INTEGER | System | 0 | Days before overdue status set |
| `allowed_payment_methods` | TEXT[] | Branch | all | Permitted payment methods |
| `loyalty_accrual_rate` | NUMERIC(8,6) | System | 0.01 | Points earned per currency unit |
| `loyalty_redemption_rate` | NUMERIC(8,6) | System | 1.0 | Currency value per point |
| `loyalty_min_transaction_amount` | NUMERIC(14,2) | System | 0 | Min transaction to earn points |
| `exchange_cash_adjustment_allowed` | BOOLEAN | System | true | Allow cash settlement on exchange |
| `notification_prefs` | JSONB | Branch | {} | Per-event notification toggles |

#### Constraints

- `system_config.key`: PRIMARY KEY (TEXT)
- `branch_config.(branch_id, key)`: composite PRIMARY KEY
- All monetary config values stored as NUMERIC(14,2); no floating-point types
- No locking strategy required (low-contention single-row updates)
- Idempotency-Key: not required for configuration writes

---

### Requirement 2: Staff & Access Control

**User Story:** As an Admin, I want to manage staff accounts and role-based permissions, so that each employee has access only to what their role requires at their assigned scope.

#### Acceptance Criteria

1. THE System SHALL enforce exactly seven Roles — `Super_Admin`, `Admin`, `Manager`, `Finance_Officer`, `Stock_Clerk`, `Sales`, `Purchasor` — each with a defined, non-overlapping permission set as specified in the RBAC matrix below; no other Role values SHALL be accepted.

2. THE System SHALL allow a Staff account to hold one Role per Branch via the `staff_branch_roles` table, enabling different permissions at different Branches. A Staff member's effective scope is determined by their Role and the set of Branches assigned to them.

3. WHEN a Staff account is created, THE System SHALL require a unique username and a password satisfying the complexity policy defined in Requirement 21 (AC10); the password SHALL be stored as a bcrypt hash.

4. WHEN a Staff member performs any write action, THE System SHALL insert a row into the Outbox within the same DB transaction containing: Staff ID, Role, action type, affected entity type, entity ID, timestamp, and Branch context; the Outbox_Poller SHALL subsequently write the Audit_Log entry.

5. THE System SHALL reject any API request where the Staff member's Role at the active Branch does not include the required permission for that endpoint, returning `403 FORBIDDEN`.

6. WHEN a Staff account is deactivated, THE System SHALL immediately set `is_active = false` and revoke all refresh tokens for that account by setting `revoked = true` on all rows in `refresh_tokens` where `staff_id` matches.

7. THE System SHALL retain Audit_Log entries for a minimum of 2 years in hot storage and prevent their deletion or modification by any Role.

8. WHEN an Admin reactivates a Staff account, THE System SHALL set `is_active = true` and restore all prior `staff_branch_roles` rows without requiring re-entry.

9. THE System SHALL enforce the following separation-of-duties constraints at the API layer:
   - `Super_Admin` SHALL NOT perform operational transactions (POS, Orders, POs, Inventory adjustments)
   - `Admin` SHALL NOT modify system-level configuration (Requirement 1 restricted to `Super_Admin`)
   - `Purchasor` SHALL NOT receive inventory against a PO (prevents self-receipt fraud)
   - `Stock_Clerk` SHALL NOT create Purchase Orders
   - `Finance_Officer` SHALL NOT create or modify Staff accounts
   - `Manager` SHALL NOT approve their own expense or payment records
   - `Sales` SHALL NOT void closed/reconciled transaction batches

#### RBAC Permission Matrix

| Slice | Super_Admin | Admin | Manager | Finance_Officer | Stock_Clerk | Sales | Purchasor |
|-------|-------------|-------|---------|-----------------|-------------|-------|-----------|
| 1. Config & Settings | Full C,R,U,D | — | — | — | — | — | — |
| 2. Staff & Access | Full C,R,U,D | C,R,U (excl. Super_Admin) | R, request (own scope) | R (view only) | R (own profile) | R (own profile) | R (own profile) |
| 3. Branch Management | Full C,R,U,D | C,R,U | R (own branch), request inter-branch | R (assigned) | R (assigned) | R (own branch) | R (assigned) |
| 4. Bank Accounts | Full C,R,U,D | R,U (reconcile) | R (own branch) | R,U (reconcile, approve) | — | — | — |
| 5. Location Management | Full C,R,U,D | C,R,U (operational) | R, request (own scope) | R (all assigned) | R (assigned) | R (own shop) | R (assigned) |
| 6. Catalog Management | R (override) | R,U (pricing, promotions) | R,U (local pricing) | R (cost, margin) | R (inventory status) | R (selling info) | R (cost, vendor info) |
| 7. Inventory Management | R (audit) | R,U (transfers, write-offs > limit) | R,U (counts, adjustments ≤ limit) | R (valuation, cost) | Full C,R,U,D (assigned) | R (availability) | R (stock levels, reorder points) |
| 8. Procurement & PO | R (audit) | R, approve POs > limit | R, request POs for branch | R, approve payments | R (receive against PO) | — | Full C,R,U,D (assigned scope) |
| 9. Customer Management | — | R,U (global policies) | R,U (local issues) | R (credit, refund audit) | — | Full C,R,U,D (served customers) | — |
| 10. POS Transactions | — | R (reports) | R,U (voids, returns ≤ limit) | R (transaction audit) | — | Full C,R,U (within policy) | — |
| 11. Returns & Refunds | — | R, approve > limit | R, approve ≤ limit | R (audit) | R (restock) | Process within policy | — |
| 12. Order Management | — | R,U (fulfillment oversight) | R,U (fulfill local orders) | R (payment reconciliation) | R (pick/pack) | R (customer service) | — |
| 13. Payment Management | R (audit) | R, reconcile | R (register closure) | R,U (reconcile, approve adjustments) | — | Process payments | — |
| 14. Merchant Exchange | — | R, approve policies | R, approve ≤ limit | R (valuation) | R (inventory adjustment) | Process within policy | — |
| 15. Bank Accounts | Full C,R,U,D | R,U (reconcile) | R (own branch) | R,U (reconcile, approve) | — | — | — |
| 16. Reporting | Full | Full (operational data) | Full (branch data) | Full (financial data) | Full (inventory data) | Limited (sales/customers) | Full (procurement/inventory) |

#### Constraints

- `staff.username`: UNIQUE system-wide
- `staff_branch_roles.(staff_id, branch_id)`: composite PRIMARY KEY
- `staff_branch_roles.role`: CHECK (role IN ('Super_Admin','Admin','Manager','Finance_Officer','Stock_Clerk','Sales','Purchasor'))
- Staff deactivation: soft delete only; Audit_Log retains `staff_id` reference
- Idempotency-Key: not required for staff management writes

---

### Requirement 3: Branch Management

**User Story:** As a Manager, I want to create and manage branch records, so that the System reflects all physical store locations.

#### Acceptance Criteria

1. WHEN an Admin or Manager creates a Branch, THE System SHALL persist the Branch with a unique name, address, contact information (JSONB), and operating hours (JSONB), and SHALL return the new Branch record with its assigned ID.
2. WHEN a Branch record is updated, THE System SHALL persist the changes and reflect them in all Branch-related views within the same request-response cycle.
3. WHEN an Admin or Manager deactivates a Branch, THE System SHALL set `is_active = false` on the Branch record without deleting any associated historical data.
4. WHEN a Branch is deactivated, THE System SHALL reject any subsequent request to create a Transaction or Order against that Branch with `422 BRANCH_INACTIVE`.
5. WHEN a Branch deletion is requested and the Branch has associated Inventory, Staff assignments, or open Orders, THE System SHALL reject the request with `409 DEPENDENCY_CONFLICT` and return a list of each blocking dependency type and count.
6. WHEN a Branch is created or deactivated, THE System SHALL insert a row into the Outbox within the same DB transaction; the Outbox_Poller SHALL subsequently write the Audit_Log entry.
7. THE System SHALL reject any Branch creation or deactivation request from a Staff account whose Role is not `Super_Admin`, `Admin`, or `Manager`, returning `403 FORBIDDEN`.

#### Constraints

- `branches.name`: UNIQUE system-wide
- Branch deletion: RESTRICT if has Locations, Staff assignments, Inventory, or open Orders
- Idempotency-Key: not required

---

### Requirement 4: Bank Account Management

**User Story:** As a Manager, I want to manage multiple bank accounts per branch and reconcile payments, so that I can accurately track funds across different banks and simplify accounting.

#### Acceptance Criteria

1. WHEN an Admin or Manager creates a Bank_Account, THE System SHALL persist: account name, bank name, account number (AES-256-GCM encrypted), IBAN (AES-256-GCM encrypted, nullable), currency, and `is_active = true`, associated with the specified Branch.
2. WHEN a bank transfer payment is recorded in a Transaction or Order, THE System SHALL require a `bank_account_id` referencing an active Bank_Account belonging to the current Branch; if the referenced account is inactive or belongs to a different Branch, THE System SHALL return `422 INVALID_BANK_ACCOUNT`.
3. WHEN a bank transfer refund is issued, THE System SHALL require a `bank_account_id` referencing an active Bank_Account belonging to the current Branch and SHALL link the refund record to that Bank_Account.
4. WHERE a Purchase Order includes a `bank_account_id`, THE System SHALL validate that the referenced Bank_Account belongs to the PO's Branch; this field is optional.
5. THE System SHALL provide a reconciliation interface where Staff can transition `bank_reconciliation` entries from `uncleared` to `cleared` or `unmatched`.
6. WHEN a bank statement CSV file is uploaded, THE System SHALL parse each row and attempt to match it to an existing payment or refund record by amount, direction, and date; matched entries SHALL be created with `status='uncleared'`; unmatched entries SHALL be created with `status='unmatched'`.
7. WHEN an imported bank statement entry cannot be matched to an existing payment or refund record, THE System SHALL create a `bank_reconciliation` row with `status='unmatched'` and no `payment_ref_id` or `refund_ref_id`.
8. WHEN a Bank_Account is created, updated, or deactivated, or when a reconciliation action is performed, THE System SHALL insert a row into the Outbox within the same DB transaction; the Outbox_Poller SHALL subsequently write the Audit_Log entry.
9. THE System SHALL restrict Bank_Account management to Staff with the `Admin`, `Manager`, or `Finance_Officer` Role; reconciliation write actions (clear, match) are additionally permitted for `Finance_Officer`.

#### Constraints

- `bank_accounts.account_number`: no uniqueness constraint
- `bank_accounts.iban`: nullable
- Column-level encryption: `account_number`, `iban` (AES-256-GCM, application layer)
- Idempotency-Key: required for reconciliation clear/match actions

---

### Requirement 5: Location Management

**User Story:** As a Manager, I want to define stock locations within each branch, so that inventory can be tracked at a granular level.

#### Acceptance Criteria

1. WHEN an Admin or Manager creates a Location, THE System SHALL persist the Location with a name that is unique within its Branch and associate it with exactly one Branch.
2. WHEN a Location is created, THE System SHALL set `branch_id` to the specified Branch and reject any request where the Branch does not exist or is inactive with `422 BRANCH_INACTIVE`.
3. WHEN a Location is renamed, THE System SHALL update the `name` field without modifying any existing Inventory records that reference that Location.
4. THE System SHALL allow each Branch to designate exactly one Location as its default fulfillment Location; designating a new default SHALL clear the previous default for that Branch.
5. WHEN a Location deletion is requested and the Location holds Inventory with `quantity > 0` or has open Orders assigned to it, THE System SHALL reject the request with `409 DEPENDENCY_CONFLICT` and return a descriptive error.
6. WHEN a Location is created, renamed, or deleted, THE System SHALL insert a row into the Outbox within the same DB transaction; the Outbox_Poller SHALL subsequently write the Audit_Log entry.
7. THE System SHALL reject any Location management request from a Staff account whose Role is not `Super_Admin`, `Admin`, or `Manager`, returning `403 FORBIDDEN`.

#### Constraints

- `locations.(branch_id, name)`: composite UNIQUE constraint
- Location deletion: RESTRICT if Inventory quantity > 0 or open Orders exist
- Idempotency-Key: not required

---

### Requirement 6: Catalog Management

**User Story:** As a Manager, I want to maintain a master book catalog, so that all branches share a consistent set of book records.

#### Acceptance Criteria

1. THE System SHALL store each Book with the following attributes: ISBN (UNIQUE, system-wide, ISBN-13 format with validated check digit), title, authors (TEXT[]), genre, publisher, edition, language, format, description, and cover_image_url (URL string, no binary storage).
2. THE System SHALL allow Books to be assigned one or more categories via `book_categories` and one or more tags via `book_tags`.
3. THE System SHALL allow a catalog default retail price (`default_price`) to be set per Book as NUMERIC(10,2).
4. THE System SHALL allow a Branch-specific retail price to be set per Book per Branch via `book_branch_prices`; this price takes precedence over `default_price` for Transactions and Orders at that Branch.
5. THE System SHALL allow each Book to be assigned a `trade_value` (NUMERIC(10,2)) independent of its retail price, used exclusively for Exchange_Orders.
6. WHEN a duplicate ISBN is submitted for a new Book, THE System SHALL reject the request with `409 DUPLICATE_ISBN` and return a descriptive error.
7. WHEN a Book record's bibliographic fields are updated, THE System SHALL insert a row into `book_edit_history` for each changed field, recording: field name, old value, new value, Staff actor ID, and timestamp.
8. WHEN a Book is marked inactive (`is_active = false`), THE System SHALL reject any subsequent request to add that Book to a new Transaction, Order, or PO with `422 BOOK_INACTIVE`, while retaining all historical records that reference it.
9. WHEN a Book is created, updated, or deactivated, THE System SHALL insert a row into the Outbox within the same DB transaction; the Outbox_Poller SHALL subsequently write the Audit_Log entry.
10. THE System SHALL restrict Catalog write operations (create, update, deactivate, set branch price) to Staff with the `Admin` or `Manager` Role.

#### Constraints

- `books.isbn`: UNIQUE system-wide; ISBN-13 check digit validated on entry
- Book deactivation: soft delete only; historical records retain reference
- Idempotency-Key: not required for catalog writes

---

### Requirement 7: Inventory Management

**User Story:** As a Stock Clerk, I want to track stock levels per book per location, so that I always know what is available where.

#### Acceptance Criteria

1. THE System SHALL maintain a `quantity` (INTEGER, >= 0) for each Book at each Location in the `inventory` table, initialized to 0 when a Book is first associated with a Location.
2. WHEN a `Manager` or `Stock_Clerk` submits a manual Inventory adjustment, THE System SHALL require a `reason_code` from the set: `damage`, `loss`, `return`, `correction`; requests with an unrecognized `reason_code` SHALL be rejected with `400 INVALID_REASON_CODE`.
3. WHEN an Inventory adjustment is saved, THE System SHALL insert a row into the Outbox and into `inventory_history` within the same DB transaction, recording: quantity delta, reason code, Staff actor ID, and timestamp.
4. WHEN a stock transfer is initiated between two Locations, THE System SHALL atomically decrement the source Location quantity and increment the destination Location quantity within a single DB transaction; if either update fails, the entire transaction SHALL be rolled back.
5. WHEN the source Location quantity is less than the requested transfer quantity, THE System SHALL reject the transfer with `422 INSUFFICIENT_STOCK` before any quantity change is applied.
6. WHEN a stock transfer completes, THE System SHALL insert rows into `inventory_history` for both the source Location (reason: `TRANSFER_OUT`) and the destination Location (reason: `TRANSFER_IN`) within the same DB transaction.
7. WHEN a Book's stock at a Location falls at or below the configured `reorder_point` for that Location after any quantity-reducing operation, THE System SHALL enqueue a low-stock alert event in the Outbox for delivery by the Notification_Worker.
8. THE System SHALL maintain a full `inventory_history` log per Book per Location, recording every quantity change with: `qty_before`, `qty_after`, `delta`, `reason`, `reason_code`, Staff actor ID, and timestamp.
9. THE System SHALL restrict Inventory adjustments and stock transfers to Staff with the `Manager` or `Stock_Clerk` Role; `Purchasor` and `Finance_Officer` have read-only access to inventory data, returning `403 FORBIDDEN` on any write attempt.

#### Constraints

- `inventory.(book_id, location_id)`: composite PRIMARY KEY
- `inventory.version`: INTEGER NOT NULL DEFAULT 0; optimistic locking on all mutations
- `inventory.quantity`: CHECK (quantity >= 0)
- Locking strategy: optimistic (version counter) for adjustments and transfers; pessimistic (SELECT FOR UPDATE) for Order stock reservation
- Idempotency-Key: required for adjust and transfer endpoints

---

### Requirement 8: Supplier Management

**User Story:** As a Manager or Purchasor, I want to manage supplier records with proper domain separation from catalog entities, so that I can associate purchase orders with the correct vendors and optionally link publishers who act as direct suppliers.

#### Acceptance Criteria

**8.1 — Supplier Registry**

1. WHEN an Admin, Manager, or Purchasor creates a Supplier, THE System SHALL persist: unique name, contact information (JSONB), lead time in days (INTEGER), pricing terms (TEXT, nullable), `supplier_type` (TEXT CHECK IN ('external','publisher')), and optional `publisher_id` (INTEGER REFERENCES publishers(id)).
2. WHEN `supplier_type = 'publisher'`, THE System SHALL require a valid `publisher_id` referencing an existing publisher in the catalog; requests without a `publisher_id` SHALL be rejected with `422 PUBLISHER_ID_REQUIRED`.
3. WHEN `supplier_type = 'external'`, THE System SHALL require `publisher_id` to be NULL; requests with a `publisher_id` SHALL be rejected with `422 PUBLISHER_ID_NOT_ALLOWED`.
4. WHEN a Supplier record is updated, THE System SHALL persist the changes without modifying any existing POs that reference that Supplier.
5. WHEN a Supplier is deactivated, THE System SHALL set `is_active = false` and reject any subsequent request to create a PO against that Supplier with `422 SUPPLIER_INACTIVE`, while retaining all historical PO records.
6. WHEN a Supplier deletion is requested and the Supplier has associated POs, THE System SHALL reject the request with `409 DEPENDENCY_CONFLICT` and return a descriptive error.
7. WHEN a Supplier is created, updated, or deactivated, THE System SHALL insert a row into the Outbox within the same DB transaction; the Outbox_Poller SHALL subsequently write the Audit_Log entry.
8. THE System SHALL restrict Supplier management to Staff with the `Admin`, `Manager`, or `Purchasor` Role.

**8.2 — Book-Supplier Mapping**

9. THE System SHALL maintain a `book_suppliers` junction table linking Books to Suppliers with: `book_id`, `supplier_id`, `supplier_sku` (TEXT, nullable), and `is_primary` (BOOLEAN DEFAULT false).
10. WHEN a book-supplier mapping is created, THE System SHALL allow the same book to be linked to multiple suppliers.
11. THE System SHALL expose `getSuppliersForBook(bookId)` returning all linked suppliers sorted by `is_primary DESC`.
12. THE System SHALL allow marking one supplier per book as primary (`is_primary = true`); marking a new supplier as primary for a book SHALL automatically unset the previous primary.

**8.3 — Procurement Validation**

13. THE System SHALL expose `validateSupplierForProcurement(supplierId)` which SHALL reject with `422 SUPPLIER_INACTIVE` if `is_active = false`, and `422 SUPPLIER_BLACKLISTED` if `is_blacklisted = true`.
14. THE System SHALL add an `is_blacklisted` BOOLEAN field to suppliers (DEFAULT false); blacklisted suppliers SHALL be blocked from new POs.

**8.4 — Inventory Stock In Reference Types**

15. THE System SHALL support the following `reference_type` values on `inventory_history` for stock-in operations: `'purchase_order'`, `'return'`, `'adjustment'`, `'manual'`, `'initial_stock'`.
16. WHEN `reference_type = 'purchase_order'`, THE System SHALL require a valid `reference_id` pointing to an existing PO.
17. WHEN `reference_type` is any other value, `reference_id` SHALL be optional (nullable).
18. Existing stock-in records without a `reference_type` SHALL be treated as `'manual'` for backward compatibility.

#### Constraints

- `suppliers.name`: UNIQUE system-wide
- `suppliers.supplier_type`: CHECK IN ('external', 'publisher')
- `suppliers.publisher_id`: REFERENCES publishers(id); required when supplier_type='publisher', NULL when supplier_type='external'
- `book_suppliers`: PRIMARY KEY (book_id, supplier_id)
- Supplier deletion: RESTRICT if has any POs
- Authors remain purely bibliographic — they are NOT suppliers
- Publishers remain bibliographic entities — they MAY optionally act as suppliers via the supplier_type='publisher' link
- Idempotency-Key: not required

---

### Requirement 9: Procurement & Purchase Orders

**User Story:** As a Manager, I want to create and manage purchase orders, so that I can replenish stock efficiently from registered suppliers.

#### Acceptance Criteria

1. WHEN a `Purchasor` or `Manager` creates a PO, THE System SHALL persist: Supplier ID, one or more line items (Book ID, `qty_ordered`, `unit_price`), target Branch ID, target Location ID, and optional `bank_account_id`; THE System SHALL assign a unique `po_number`.
2. WHEN a PO is submitted and its total value (SUM of `qty_ordered × unit_price`) is less than or equal to `config.po_approval_threshold`, THE System SHALL set `status = 'Pending'`; WHEN the total exceeds the threshold, THE System SHALL set `status = 'PendingApproval'` and enqueue an in-app notification to the Manager/Admin for approval before the PO can be submitted to the Supplier.
3. WHEN a Manager cancels a PO in `Pending` status, THE System SHALL set `status = 'Cancelled'` and insert a row into the Outbox; cancellation of a PO in any other status SHALL be rejected with `409 INVALID_STATE_TRANSITION`.
4. WHEN stock is received against a PO line item, THE System SHALL increment `inventory.quantity` at the target Location by the received quantity and insert a row into `po_receipts` and `inventory_history`, all within the same DB transaction.
5. THE System SHALL allow partial receipts against a PO; after a partial receipt, THE System SHALL set `status = 'In_Progress'` if not already set; the PO remains `In_Progress` until all line items are fully received or the PO is manually closed.
6. WHEN the received quantity for a line item would cause `qty_received > qty_ordered`, THE System SHALL return `202` with `{ requiresConfirmation: true, overReceiptQty }` and require the Manager to resubmit with `{ confirm: true }` before updating Inventory.
7. WHEN all line items on a PO have `qty_received >= qty_ordered`, THE System SHALL automatically set `status = 'Closed'` within the same DB transaction as the final receipt.
8. THE System SHALL enforce the PO state machine defined in Section 4.3; any transition not listed as allowed SHALL be rejected with `409 INVALID_STATE_TRANSITION`.
9. WHEN a PO is created, updated, or closed, THE System SHALL insert a row into the Outbox within the same DB transaction; the Outbox_Poller SHALL subsequently write the Audit_Log entry.
10. THE System SHALL restrict PO creation to Staff with the `Purchasor` or `Manager` Role; PO receipt confirmation (receiving stock) is restricted to `Stock_Clerk` or `Manager`; `Purchasor` SHALL NOT receive inventory against a PO.

#### Constraints

- `purchase_orders.po_number`: UNIQUE system-wide
- `purchase_orders.bank_account_id`: nullable
- Inventory receipt: optimistic locking (version counter) on `inventory` table
- Idempotency-Key: required for PO creation and receipt endpoints

---

### Requirement 10: Customer Management

**User Story:** As a Staff member, I want to manage customer profiles, so that I can provide personalized service and track purchase history.

#### Acceptance Criteria

1. WHEN a Staff member creates a Customer profile, THE System SHALL persist: full name, at least one of email (AES-256-GCM encrypted) or phone (AES-256-GCM encrypted), optional notes, and optional preferences (JSONB); requests where both email and phone are null SHALL be rejected with `422 CONTACT_REQUIRED`.
2. WHEN a duplicate email or phone is submitted for a new Customer, THE System SHALL reject the request with `409 DUPLICATE_CONTACT` and return a descriptive error identifying the conflicting field.
3. THE System SHALL maintain a complete purchase history per Customer by linking each Transaction (`customer_id`) and Order (`customer_id`) to the Customer record; anonymous Transactions (null `customer_id`) are permitted.
4. WHEN a Customer profile is deactivated, THE System SHALL set `is_active = false` and reject any subsequent request to create a Transaction or Order referencing that Customer with `422 CUSTOMER_INACTIVE`, while retaining all historical records.
5. THE System SHALL maintain a `store_credit` balance (NUMERIC(10,2), CHECK >= 0) per Customer; any operation that would reduce `store_credit` below 0 SHALL be rejected with `422 INSUFFICIENT_STORE_CREDIT`.
6. WHERE the Loyalty_Program is enabled (system config `loyalty_accrual_rate > 0`), WHEN a Transaction is completed and `transaction.total >= loyalty_min_transaction_amount`, THE System SHALL enqueue a loyalty accrual event in the Outbox; the Loyalty_Worker SHALL add `floor(transaction.total × loyalty_accrual_rate)` points to the Customer's `loyalty_points` balance, using `loyalty_redemption_rate` to convert points to monetary value at redemption.
7. WHERE the Loyalty_Program is enabled, WHEN a Transaction payment with `method = 'loyalty_points'` is submitted, THE System SHALL validate that the Customer's `loyalty_points` balance is sufficient; if insufficient, THE System SHALL reject the payment with `422 INSUFFICIENT_LOYALTY_POINTS`.
8. WHERE the Loyalty_Program is enabled, WHEN points are accrued or redeemed, THE System SHALL insert a row into `loyalty_history` within the same DB transaction as the balance update, recording: delta, balance_after, reason, transaction reference, and timestamp.
9. WHEN a Customer profile is created, updated, or deactivated, THE System SHALL insert a row into the Outbox within the same DB transaction; the Outbox_Poller SHALL subsequently write the Audit_Log entry.

#### Constraints

- `customers.email`: UNIQUE when non-null; AES-256-GCM encrypted; not searchable via SQL LIKE
- `customers.phone`: UNIQUE when non-null; AES-256-GCM encrypted; not searchable via SQL LIKE
- `customers.version`: INTEGER for optimistic locking on `store_credit` and `loyalty_points` updates
- At least one of email or phone MUST be non-null
- Idempotency-Key: not required for customer profile writes

---

### Requirement 11: Point of Sale — Transactions

**User Story:** As a Sales staff member, I want to process sales transactions at my branch, so that customers can purchase books quickly and accurately.

#### Acceptance Criteria

1. WHEN a `Sales` staff member or Manager creates a Transaction, THE System SHALL persist a new Transaction record with `status = 'draft'`, associated with the specified Branch and Location; `customer_id` is optional (null for anonymous walk-in).
2. WHEN a Book is added to a Transaction line item, THE System SHALL apply the Branch-specific price from `book_branch_prices` if a row exists for that Book and Branch; otherwise THE System SHALL apply `books.default_price`.
3. WHEN a discount is applied to a Transaction line item or to the Transaction total, THE System SHALL require a non-empty `discount_reason`; requests without a reason SHALL be rejected with `400 DISCOUNT_REASON_REQUIRED`.
4. THE System SHALL apply the Branch-level tax rate from `branch_config` to each Transaction; if no Branch-level override exists, THE System SHALL apply the system-level tax rate from `system_config`.
5. THE System SHALL accept the following payment methods within a Transaction: `cash`, `credit_card`, `debit_card`, `store_credit`, `loyalty_points`, `bank_transfer`; any other method value SHALL be rejected with `400 INVALID_PAYMENT_METHOD`.
6. WHEN a Transaction payment with `method = 'bank_transfer'` is submitted, THE System SHALL require a `bank_account_id` referencing an active Bank_Account belonging to the current Branch; if absent or invalid, THE System SHALL return `422 INVALID_BANK_ACCOUNT`.
7. THE System SHALL allow a Transaction payment to be split across two or more supported payment methods; the sum of all payment amounts MUST equal `transaction.total` exactly; if the sum does not match, THE System SHALL return `422 PAYMENT_SUM_MISMATCH`.
8. WHEN a Transaction is completed, THE System SHALL decrement `inventory.quantity` at the Branch's default fulfillment Location for each line item using optimistic locking (version check); if any version conflict occurs, THE System SHALL roll back the entire completion and return `409 VERSION_CONFLICT`.
9. WHEN a Book's available stock at the fulfillment Location is insufficient to complete a Transaction line item, THE System SHALL return `422 INSUFFICIENT_STOCK` with the shortfall quantity; completion SHALL proceed only if a Manager-level override is explicitly confirmed (Manager ID and reason recorded in the Transaction).
10. WHEN a Transaction is completed, THE System SHALL generate a receipt payload containing: itemized lines, applied discounts, tax amount, payment method breakdown, and a unique Transaction ID; the receipt SHALL be returned in the completion response.
11. WHEN a Transaction is completed, THE System SHALL insert a row into the Outbox within the same DB transaction; the Outbox_Poller SHALL subsequently write the Audit_Log entry with Staff actor, Branch, and Transaction ID.
12. WHEN a Transaction in `draft` status is voided, THE System SHALL set `status = 'voided'`, release any reserved Inventory, and insert a row into the Outbox; voiding a `completed` Transaction SHALL be rejected with `409 ALREADY_COMPLETED`.
13. THE System SHALL reject any request to modify a `completed` Transaction; all corrections SHALL be made through the Returns process (Requirement 12).

#### Constraints

- `transactions.status`: CHECK IN ('draft', 'completed', 'voided')
- Transaction completion: wrapped in a single DB transaction at REPEATABLE READ isolation
- Inventory decrement: optimistic locking (version counter)
- Payment recording: pessimistic lock (SELECT FOR UPDATE on Transaction row)
- Loyalty accrual: async via Outbox; does NOT block completion response
- Idempotency-Key: required for the complete endpoint

---

### Requirement 12: Returns & Refunds

**User Story:** As a Sales staff member, I want to process returns and refunds, so that customers can return books they no longer want.

#### Acceptance Criteria

1. WHEN a return is initiated, THE System SHALL require a `original_tx_id` referencing an existing `completed` Transaction; requests referencing a non-existent or non-completed Transaction SHALL be rejected with `422 INVALID_TRANSACTION_REFERENCE`.
2. THE System SHALL allow partial returns covering a subset of line items or quantities from the original Transaction; the return quantity per line item MUST NOT exceed the original purchased quantity for that line item.
3. WHEN a return is processed, THE System SHALL increment `inventory.quantity` at the receiving Location and insert rows into `returns`, `return_line_items`, and the Outbox within the same DB transaction; the Outbox_Poller SHALL subsequently write the Audit_Log entry.
4. WHEN a refund is issued, THE System SHALL accept one of the following methods: `original` (proportional to original payment methods), `store_credit`, or `bank_transfer` (from an active Bank_Account of the current Branch); the selected method and reason SHALL be persisted in the `refunds` table.
5. WHEN a refund is issued as `store_credit`, THE System SHALL atomically increase `customer.store_credit` and insert a row into `store_credit_history` within the same DB transaction as the `refunds` insert.
6. WHEN a partial refund is issued against a specific payment record, THE System SHALL validate that `refund.amount <= original payment amount for that record`; if exceeded, THE System SHALL return `422 EXCEEDS_PAYMENT_AMOUNT`.
7. WHEN a return is requested for a Transaction where `now() > transaction.completed_at + config.return_window_days`, THE System SHALL require a `manager_auth_id` referencing an active Manager Staff account; if absent, THE System SHALL return `403 RETURN_WINDOW_EXCEEDED`; the authorization SHALL be recorded in the `returns.manager_auth_id` field and in the Audit_Log. Additionally, if the total refund value exceeds `config.max_return_value_without_auth`, the same Manager authorization is required regardless of the return window.
8. WHEN a return line item is submitted, THE System SHALL validate that the sum of all previously returned quantities for that `tx_line_id` plus the new return quantity does not exceed the original `transaction_line_items.quantity`; if exceeded, THE System SHALL return `422 QUANTITY_EXCEEDS_ORIGINAL`.

#### Constraints

- `returns.manager_auth_id`: nullable; required only when return window is exceeded
- Refund amount: MUST NOT exceed original payment amount per payment record
- Idempotency-Key: required for the returns creation endpoint

---

### Requirement 13: Order Management

**User Story:** As a Staff member, I want to manage customer orders across channels, so that I can fulfill purchases from in-store, phone, and online requests.

#### Acceptance Criteria

1. WHEN a `Sales` staff member or Manager creates an Order, THE System SHALL persist: Customer ID, one or more line items (Book ID, quantity), fulfillment Branch ID, fulfillment Location ID, and channel (`in_store`, `phone`, or `online`); THE System SHALL assign a unique `order_number` and set `status = 'Pending'`.
2. THE System SHALL assign each Order a unique `order_number` (system-generated) and set `status = 'Pending'` at creation.
3. WHEN an Order is confirmed, THE System SHALL reserve the specified stock at the fulfillment Location using `SELECT FOR UPDATE` on the relevant Inventory rows; `inventory.qty_reserved` SHALL be incremented and available (unreserved) stock SHALL be reduced accordingly.
4. WHEN the requested stock for an Order line item is unavailable at the fulfillment Location, THE System SHALL set `order_line_items.is_backordered = true` for that line item and enqueue a customer notification event in the Outbox.
5. WHEN an Order is fulfilled, THE System SHALL decrement `inventory.quantity` by `qty_reserved` for each line item, set `qty_reserved = 0`, generate an invoice, and set `status = 'Fulfilled'`, all within a single DB transaction.
6. THE System SHALL enforce the Order state machine defined in Section 4.2; any transition not listed as allowed SHALL be rejected with `409 INVALID_STATE_TRANSITION`.
7. WHEN an Order is cancelled, THE System SHALL release any reserved Inventory (`qty_reserved` decremented back to 0), set `status = 'Cancelled'`, record the `cancel_reason`, and insert a row into the Outbox within the same DB transaction.
8. WHEN an Order status changes, THE System SHALL insert a row into the Outbox within the same DB transaction; the Outbox_Poller SHALL write the Audit_Log entry and, if notification preferences are enabled for that Branch, enqueue a customer notification.
9. THE System SHALL apply the Branch-level tax rate from `branch_config` to each Order; if no Branch-level override exists, THE System SHALL apply the system-level tax rate from `system_config`.

#### Constraints

- `orders.order_number`: UNIQUE system-wide
- Stock reservation: pessimistic locking (SELECT FOR UPDATE on Inventory rows)
- Inventory decrement on fulfillment: optimistic locking (version counter)
- Idempotency-Key: required for Order creation and confirmation endpoints

---

### Requirement 14: Payment Management

**User Story:** As a Sales staff member or Finance Officer, I want to accept split and installment payments for orders, so that customers have flexible payment options.

#### Acceptance Criteria

1. THE System SHALL track the outstanding balance per Order as: `order.total − SUM(order_payments.amount) + SUM(order_refunds.amount)`; this value MUST never be negative.
2. WHEN a Manager creates an Installment_Plan for an Order, THE System SHALL persist: deposit amount, and one or more installments each with a `due_date` and `amount`; THE System SHALL set each installment's initial `status = 'pending'`.
3. WHEN an Installment_Plan is created, THE System SHALL validate: (a) `deposit_amount >= order.total × config.min_deposit_pct / 100`; if not, return `422 DEPOSIT_BELOW_MINIMUM`; (b) `installments.length <= config.max_installments`; if not, return `422 EXCEEDS_MAX_INSTALLMENTS`; (c) `SUM(installments.amount) = order.total − deposit_amount`; if not, return `422 INSTALLMENT_SUM_MISMATCH`.
4. THE System SHALL accept all payment methods defined in Requirement 11 (AC5) for both Order payments and individual installment payments.
5. WHEN a bank transfer is used for an Order or installment payment, THE System SHALL require a `bank_account_id` referencing an active Bank_Account belonging to the current Branch; if absent or invalid, THE System SHALL return `422 INVALID_BANK_ACCOUNT`.
6. THE System SHALL enforce the `allowed_payment_methods` configuration per Branch (stored in `branch_config`); requests using a payment method not in the Branch's allowed list SHALL be rejected with `422 PAYMENT_METHOD_NOT_ALLOWED`.
7. WHEN a scheduled installment's `due_date` is reached and `paid_amount < amount`, THE System SHALL enqueue a payment reminder notification event in the Outbox for delivery by the Notification_Worker.
8. WHEN a partial refund is issued against a specific `order_payments` record, THE System SHALL validate that `refund.amount <= order_payments.amount`; if exceeded, THE System SHALL return `422 EXCEEDS_PAYMENT_AMOUNT`.
9. WHEN a payment is submitted that would cause the outstanding balance to go below 0, THE System SHALL reject the payment with `422 EXCEEDS_OUTSTANDING_BALANCE`.
10. THE System SHALL maintain a complete payment history per Order in `order_payments`, recording each payment with: amount, method, `bank_account_id` (if applicable), timestamp, and Staff actor ID.
11. WHEN a payment is recorded or refunded, THE System SHALL insert a row into the Outbox within the same DB transaction; the Outbox_Poller SHALL subsequently write the Audit_Log entry with Staff actor, Order ID, amount, and method.

#### Constraints

- `order_payments.version`: INTEGER for optimistic locking on outstanding balance updates
- Payment recording: pessimistic locking (SELECT FOR UPDATE on Order row)
- Idempotency-Key: required for payment recording and installment plan creation endpoints

---

### Requirement 15: Merchant Exchange (In-Kind Trading)

**User Story:** As a Manager, I want to trade books with neighboring merchants, so that I can diversify inventory without cash procurement.

#### Acceptance Criteria

1. THE System SHALL maintain a Merchant Directory allowing Merchants to be registered with a unique name, contact information (JSONB), and address; duplicate names SHALL be rejected with `409 DUPLICATE_MERCHANT_NAME`.
2. THE System SHALL allow an Exchange_Agreement to be created between the business and a Merchant, specifying: exchange basis (`book_for_book` or `value_based`) and terms (TEXT); the Agreement SHALL be associated with exactly one Merchant.
3. WHEN an Exchange_Order is created, THE System SHALL persist: offered Books (direction=`out`) with quantities and trade values, requested Books (direction=`in`) with quantities and trade values, the associated Exchange_Agreement ID, source Location ID, and destination Location ID; `status` SHALL be set to `Pending`.
4. WHEN the sum of `trade_value × quantity` for offered lines differs from the sum for requested lines, THE System SHALL calculate `adjustment_amount = ABS(offered_total − requested_total)` and persist it on the Exchange_Order along with `adjustment_type` (`cash` or `store_credit`) as specified at creation.
5. WHEN an Exchange_Order is settled, THE System SHALL atomically decrement `inventory.quantity` for each offered Book at the source Location and increment `inventory.quantity` for each received Book at the destination Location, all within a single DB transaction using optimistic locking (version counter).
6. WHEN a settlement is attempted and any offered Book has insufficient quantity at the source Location, THE System SHALL reject the settlement with `422 INSUFFICIENT_STOCK` before any inventory change is applied.
7. THE System SHALL enforce the Exchange_Order state machine defined in Section 4.4; any transition not listed as allowed SHALL be rejected with `409 INVALID_STATE_TRANSITION`.
8. WHEN an Exchange_Order status changes, THE System SHALL insert a row into the Outbox within the same DB transaction; the Outbox_Poller SHALL subsequently write the Audit_Log entry with Staff actor, Merchant, and timestamp.
9. THE System SHALL maintain an exchange history log per Merchant by retaining all Exchange_Orders with their final status and timestamps, queryable via the Merchant detail view.
10. THE System SHALL restrict Exchange_Order creation and settlement to Staff with the `Admin` or `Manager` Role; `Finance_Officer` has read-only access to Exchange_Orders for valuation and audit purposes.

#### Constraints

- `merchants.name`: UNIQUE system-wide
- Exchange settlement: optimistic locking (version counter) on all affected Inventory rows
- `adjustment_type` cannot be changed after `Accepted` status
- Idempotency-Key: required for Exchange_Order creation and settlement endpoints

---

### Requirement 16: Reporting & Analytics

**User Story:** As a Manager, I want to generate reports on sales, inventory, procurement, and customers, so that I can make informed business decisions.

#### Acceptance Criteria

1. THE System SHALL generate sales reports filterable by Branch, time period, Book, and category, showing: total units sold, gross revenue, discounts applied, and net revenue.
2. THE System SHALL generate inventory reports showing: current stock levels per Location, stock movement history, and inventory valuation per Location.
3. THE System SHALL generate procurement reports showing: PO history per Supplier, supplier lead time (ordered vs. actual), and total spend per Supplier per time period.
4. THE System SHALL generate customer reports showing: new customers acquired, purchase frequency per Customer, and top customers ranked by revenue.
5. THE System SHALL generate a profit/loss summary per Branch and per time period, incorporating: sales revenue, cost of goods sold, discounts, and tax collected.
6. THE System SHALL generate an exchange report per Merchant showing: Exchange_Order history, total Trade_Value exchanged, and any cash/store-credit adjustments.
7. THE System SHALL generate a bank reconciliation report per Bank_Account per time period, showing: all linked incoming payments, outgoing refunds, cleared/uncleared status, and unmatched entries flagged for review.
8. WHEN a Report is requested for a dataset covering 3 months or less, THE System SHALL complete generation synchronously and return the result within 10 seconds; if generation exceeds 10 seconds, THE System SHALL return `503` with `Retry-After`.
9. WHEN a Report is requested for a dataset covering more than 3 months, THE System SHALL enqueue an async Report_Worker job and return `202 { jobId, status: 'queued', estimatedMinutes: 5 }`; the Report_Worker SHALL complete the job within 5 minutes and notify the requesting Staff member via in-app notification.
10. THE System SHALL restrict Report generation access by Role: `Super_Admin`, `Admin`, `Manager`, and `Finance_Officer` may access all reports; `Stock_Clerk` may access inventory reports only; `Purchasor` may access procurement and inventory reports only; `Sales` may access sales and customer reports only; any request outside these boundaries SHALL return `403 FORBIDDEN`.

#### Constraints

- Reports use read replica (`db.replica`) to avoid impacting write throughput
- Async report jobs: managed via BullMQ; dead-letter queue for failed jobs
- Idempotency-Key: not required for report requests

---

### Requirement 17: UI & Data Presentation

**User Story:** As a Staff member, I want all list views, reports, and dashboards to support sorting, filtering, pagination, and visual summaries, so that I can efficiently navigate and interpret system data.

#### Acceptance Criteria

**List Views & Data Grids**

1. THE System SHALL support column-based sorting (ascending and descending) on all entity list views, including: Books, Inventory, Customers, Transactions, Orders, Purchase Orders, Suppliers, Staff, Merchants, and Exchange_Orders.
2. THE System SHALL support multi-criteria filtering on all entity list views; filter criteria SHALL include at minimum: date range, Branch, status, and entity-specific fields (e.g., ISBN, Customer name, Supplier).
3. THE System SHALL paginate all list views that may return more than 50 records, with a configurable page size (default 25, options: 25, 50, 100); responses SHALL include `{ items, total, page, pageSize, totalPages }`.
4. THE System SHALL retain the active sort, filter, and pagination state within a session so that navigating away and returning to a list view restores the previous state.

**Data Export**

5. THE System SHALL allow Staff to export the currently filtered and sorted data set from any entity list view to CSV format.
6. THE System SHALL allow all analytics Reports (Requirement 16) to be exported in both CSV and PDF formats.
7. THE System SHALL allow the Audit_Log to be exported in CSV format, filtered by date range, Staff actor, and entity type; this export SHALL be restricted to Staff with the Admin Role.

**Dashboard & KPI Cards**

8. THE System SHALL provide a Branch-level dashboard displaying the following KPI cards: today's sales revenue, number of Transactions today, low-stock alert count, open Orders count, and outstanding installment payments due within 7 days.
9. THE System SHALL allow the dashboard to be scoped to a single Branch or aggregated across all Branches, based on the Staff member's Role and Branch assignments.
10. WHEN a KPI card is selected, THE System SHALL navigate to the corresponding filtered list view (e.g., selecting the low-stock card opens the Inventory list filtered to low-stock items).

**Charts & Visual Analytics**

11. THE System SHALL display a sales trend chart on the dashboard showing daily or weekly revenue for the current month, filterable by Branch.
12. THE System SHALL display an inventory valuation chart showing stock value distribution across Locations for the selected Branch.
13. THE System SHALL display a top-selling Books chart showing the top 10 Books by units sold for a configurable time period and Branch.
14. THE System SHALL display a payment method breakdown chart on the sales report showing the proportion of each payment method used within the selected period.

**General**

15. THE System SHALL restrict dashboard and chart access to Staff with the `Admin`, `Manager`, `Finance_Officer`, or `Sales` Role; Staff with the `Stock_Clerk` Role SHALL have access only to inventory-related views and exports; `Purchasor` SHALL have access only to procurement and inventory views.

#### Constraints

- Dashboard KPI endpoint: cached in Redis with 60s TTL; invalidated on Transaction or Order write
- List endpoints: OFFSET-based pagination (page + pageSize); cursor-based for exports > 10,000 rows
- Idempotency-Key: not required for read endpoints

---

## 9. API Requirements (High-Level)

### 9.1 Authentication

```
POST /api/auth/login
  Body: { username, password, branchId }
  Response: { accessToken, expiresIn: 900 }  (refresh token in httpOnly cookie)
  Errors: 401 INVALID_CREDENTIALS, 429 RATE_LIMITED, 403 ACCOUNT_INACTIVE

POST /api/auth/refresh
  Cookie: refreshToken
  Response: { accessToken, expiresIn: 900 }
  Errors: 401 TOKEN_EXPIRED, 401 TOKEN_REVOKED

POST /api/auth/logout
  Revokes current refresh token; clears httpOnly cookie
```

### 9.2 Inventory

```
GET /api/inventory?branchId&locationId&bookId&lowStock&page&pageSize&sortBy&sortDir
  Role: Any authenticated
  Response: paginated { items: [{ bookId, locationId, quantity, reorderPoint, version, lowStockFlag }] }

PUT /api/inventory/:bookId/:locationId/adjust
  Role: Manager, Stock_Clerk
  Idempotency-Key: Required
  Body: { delta, reasonCode, version }
  Response: { quantity, version }
  Errors: 409 VERSION_CONFLICT, 422 INSUFFICIENT_STOCK, 400 INVALID_REASON_CODE

POST /api/inventory/transfer
  Role: Manager, Stock_Clerk
  Idempotency-Key: Required
  Body: { bookId, fromLocationId, toLocationId, quantity, version }
  Response: { fromQuantity, toQuantity }
  Errors: 409 VERSION_CONFLICT, 422 INSUFFICIENT_STOCK
```

### 9.3 POS Transactions

```
POST /api/transactions
  Role: Cashier, Manager
  Body: { branchId, locationId, customerId? }
  Response: { transactionId, status: 'draft' }

POST /api/transactions/:id/lines
  Role: Cashier, Manager
  Body: { bookId, quantity, discountAmount?, discountReason? }
  Response: { lineId, unitPrice, lineTotal }
  Errors: 404 BOOK_NOT_FOUND, 422 BOOK_INACTIVE

POST /api/transactions/:id/complete
  Role: Cashier, Manager
  Idempotency-Key: Required
  Body: { payments: [{ method, amount, bankAccountId? }], managerOverride?: { managerId, reason } }
  Response: { transactionId, receipt: { ... } }
  Errors: 409 VERSION_CONFLICT, 422 INSUFFICIENT_STOCK, 422 PAYMENT_SUM_MISMATCH, 422 INVALID_BANK_ACCOUNT

POST /api/transactions/:id/void
  Role: Cashier, Manager
  Body: { reason }
  Errors: 409 ALREADY_COMPLETED
```

### 9.4 Orders

```
POST /api/orders
  Role: Cashier, Manager
  Idempotency-Key: Required
  Body: { customerId, branchId, locationId, channel, lines: [{ bookId, quantity }] }
  Response: { orderId, orderNumber, status: 'Pending', total }

POST /api/orders/:id/confirm
  Role: Manager, Cashier
  Idempotency-Key: Required
  Response: { orderId, status: 'Confirmed', reservedItems: [...] }
  Errors: 422 INSUFFICIENT_STOCK (with backorder option)

POST /api/orders/:id/cancel
  Role: Manager
  Body: { reason }
  Errors: 409 ORDER_ALREADY_FULFILLED
```

### 9.5 Payments

```
POST /api/orders/:id/payments
  Role: Cashier, Manager
  Idempotency-Key: Required
  Body: { method, amount, bankAccountId? }
  Response: { paymentId, outstandingBalance }
  Errors: 422 EXCEEDS_OUTSTANDING_BALANCE, 422 INVALID_BANK_ACCOUNT

POST /api/orders/:id/installment-plan
  Role: Manager
  Idempotency-Key: Required
  Body: { depositAmount, installments: [{ dueDate, amount }] }
  Errors: 422 DEPOSIT_BELOW_MINIMUM, 422 INSTALLMENT_SUM_MISMATCH

POST /api/orders/:id/refunds
  Role: Cashier, Manager
  Idempotency-Key: Required
  Body: { paymentId, amount, method, bankAccountId?, reason }
  Errors: 422 EXCEEDS_PAYMENT_AMOUNT
```

### 9.6 Returns

```
POST /api/returns
  Role: Cashier, Manager
  Idempotency-Key: Required
  Body: { originalTxId, lines: [{ txLineId, quantity }], refundMethod, bankAccountId?, reason, managerAuthId? }
  Response: { returnId, refundAmount, inventoryRestored: [...] }
  Errors: 403 RETURN_WINDOW_EXCEEDED (if no managerAuthId), 422 QUANTITY_EXCEEDS_ORIGINAL, 422 ALREADY_RETURNED
```

### 9.7 Reports

```
GET /api/reports/:type?branchId&from&to&...filters
  Role: Admin, Manager
  Response (<=3 months): { data: [...], generatedAt }
  Response (>3 months): { jobId, status: 'queued', estimatedMinutes: 5 }

GET /api/reports/jobs/:jobId
  Role: Admin, Manager
  Response: { jobId, status: 'queued'|'processing'|'completed'|'failed', downloadUrl? }
```

---

## 10. Error Handling Standards

### 10.1 Standard Error Response Format

```json
{
  "error": "ERROR_CODE",
  "message": "Human-readable description for display",
  "details": {
    "field": "optional field name for validation errors",
    "context": {}
  },
  "requestId": "uuid-for-tracing",
  "timestamp": "ISO-8601"
}
```

### 10.2 HTTP Status Code Mapping

| Status | Category | When Used |
|--------|----------|-----------|
| 200 | Success | GET, successful PUT/PATCH |
| 201 | Created | Successful POST creating a new resource |
| 202 | Accepted | Async job queued (report generation, over-receipt confirmation) |
| 400 | Bad Request | Missing/invalid fields, schema validation failure |
| 401 | Unauthorized | Missing/expired/revoked token |
| 403 | Forbidden | Valid token but insufficient role; return window exceeded without manager auth |
| 404 | Not Found | Entity does not exist |
| 409 | Conflict | Duplicate (ISBN, username), dependency block, VERSION_CONFLICT, state machine violation |
| 422 | Unprocessable | Business rule violation (insufficient stock, payment sum mismatch, balance exceeded) |
| 429 | Too Many Requests | Rate limit exceeded |
| 503 | Service Unavailable | DB failure, circuit breaker open; includes `Retry-After` header |

### 10.3 Business vs System Errors

- **Business errors (4xx):** deterministic, caused by invalid input or violated business rules; client SHOULD NOT retry without changing input
- **System errors (503):** transient infrastructure failures; client SHOULD retry with exponential backoff after `Retry-After`
- **409 VERSION_CONFLICT:** retryable — client should re-read the current version and retry up to 3 times

---

## 11. Non-Functional Requirements

### Requirement 18: Performance

**User Story:** As a business owner, I want the system to respond quickly under normal operating load, so that staff productivity is not impaired and customers are not kept waiting.

**Normal Load Definition:**
- Up to 50 concurrent Branches active
- Up to 500 concurrent authenticated Staff users
- Up to 20 concurrent POS Transaction completions per minute system-wide
- Read:Write ratio approximately 4:1 across all endpoints

#### Acceptance Criteria

1. WHEN a POS Transaction is completed (stock check + payment recording + inventory decrement + receipt generation), THE System SHALL complete the full operation within 2 seconds at the 95th percentile under normal load.
2. WHEN a paginated, filtered list endpoint is requested, THE System SHALL return a response within 500 milliseconds at the 95th percentile.
3. WHEN a single-entity GET request is made, THE System SHALL return a response within 200 milliseconds at the 95th percentile.
4. WHEN a Report is requested for a dataset covering 3 months or less, THE System SHALL complete generation synchronously within 10 seconds.
5. WHEN a Report is requested for a dataset covering more than 3 months, THE System SHALL process the request asynchronously and deliver the result within 5 minutes via an in-app notification.
6. WHEN the dashboard KPI endpoint is requested, THE System SHALL return a response within 1 second at the 95th percentile.
7. WHEN a bank statement CSV import of up to 10,000 rows is submitted, THE System SHALL complete processing within 30 seconds.

**Read vs Write Load Expectations per Module:**

| Module | Read Load | Write Load | Notes |
|--------|-----------|------------|-------|
| POS / Transactions | Low (receipt lookup) | High (completions) | Write-heavy; optimistic lock critical |
| Inventory | High (stock checks) | Medium (adjustments) | Read replica for list views |
| Orders | Medium | Medium | State machine transitions |
| Reports / Dashboard | Very High | None | Read replica only |
| Audit Log | Low (export) | Very High | Async via outbox |
| Catalog | High (price lookups) | Low | Cacheable |

---

### Requirement 19: Scalability

**User Story:** As a business owner, I want the system to scale with business growth, so that adding branches, users, and catalog entries does not degrade performance.

#### Acceptance Criteria

1. THE System SHALL support 50 or more Branches operating concurrently without degradation.
2. THE System SHALL support 500 or more concurrently authenticated Staff users without degradation.
3. THE System SHALL support a Catalog of up to 100,000 Book entries without degradation.
4. THE System SHALL support up to 10,000 Inventory records per Location without degradation.
5. THE System SHALL handle up to 1,000 POS Transactions per hour across all Branches without degradation.
6. THE Audit_Log SHALL support retention and querying of 10 million or more entries without degradation.
7. THE System architecture SHALL allow horizontal scaling of API servers without shared mutable state, enabling additional replicas to be added behind a load balancer without configuration changes.

---

### Requirement 20: Availability & Reliability

**User Story:** As a business owner, I want the system to be highly available and resilient to transient failures, so that store operations are not interrupted.

#### Acceptance Criteria

1. THE System SHALL target 99.9% uptime, equating to no more than 8.7 hours of unplanned downtime per year, excluding planned maintenance windows.
2. WHEN a planned maintenance window is scheduled, THE System SHALL communicate it to all active Staff at least 24 hours in advance, and the window SHALL NOT exceed 2 hours in duration.
3. WHEN a transient database connection failure occurs, THE System SHALL automatically retry the operation with exponential backoff, up to a maximum of 3 retries, before returning an error to the caller.
4. WHEN a multi-step write operation (Transaction completion, stock transfer, Exchange settlement, Order fulfillment) encounters a failure at any step, THE System SHALL roll back all changes from that operation atomically, leaving no partial state persisted.
5. WHEN a write request is submitted with an Idempotency-Key that matches a request completed within the previous 24 hours, THE System SHALL return the original response without creating duplicate records, and SHALL include the `X-Idempotent-Replayed: true` header.
6. WHEN an external integration (email or notification service) fails, THE System SHALL degrade gracefully using a circuit breaker pattern, continuing to process core operations without blocking on the failed integration.

---

### Requirement 21: Security

**User Story:** As a business owner, I want the system to protect sensitive data and enforce strict access controls, so that customer and financial data is not compromised.

#### Acceptance Criteria

1. THE System SHALL encrypt all data in transit using TLS 1.2 or higher.
2. THE System SHALL encrypt all data at rest using AES-256 or an equivalent standard.
3. THE System SHALL encrypt the following fields at the column level using AES-256-GCM at the application layer: `bank_accounts.account_number`, `bank_accounts.iban`, `customers.email`, `customers.phone`; the encryption key SHALL be loaded from the environment variable `COLUMN_ENCRYPTION_KEY` and SHALL never be committed to source control.
4. THE System SHALL issue JWT access tokens with a maximum lifetime of 15 minutes and refresh tokens with a maximum lifetime of 7 days.
5. THE System SHALL store refresh tokens as bcrypt hashes; the plaintext refresh token SHALL never be persisted in the database.
6. WHEN a Staff account is deactivated, THE System SHALL immediately revoke all refresh tokens associated with that account by setting `revoked = true` on all matching rows in `refresh_tokens`.
7. WHEN a source IP address submits more than 10 failed login attempts within a 15-minute window, THE System SHALL reject all subsequent login attempts from that IP within the window with a `429 RATE_LIMITED` response.
8. THE System SHALL enforce rate limiting of 200 requests per minute per authenticated Staff user across all API endpoints, returning `429` when the limit is exceeded.
9. THE System SHALL protect all state-mutating API endpoints against Cross-Site Request Forgery using the double-submit cookie pattern.
10. THE System SHALL enforce password complexity: a minimum of 10 characters containing at least one uppercase letter, one lowercase letter, one digit, and one special character.
11. THE System SHALL enforce Role-Based Access Control at the API layer; client-side-only access control is not acceptable as a security boundary.
12. THE System SHALL include a cryptographic HMAC-SHA256 signature on each Audit_Log entry, computed over the entry's immutable fields, such that any modification to a stored entry is detectable.

---

### Requirement 22: Observability

**User Story:** As an operator, I want the system to emit structured logs, metrics, and traces, so that I can diagnose issues and monitor system health in production.

#### Acceptance Criteria

1. THE System SHALL emit a structured JSON log entry for every API request, including: request ID, HTTP method, path, response status code, response time in milliseconds, Staff ID, and Branch ID; PII fields SHALL be masked in logs.
2. THE System SHALL expose a `/health` endpoint returning the current service status, primary database connectivity, read replica connectivity, and message queue connectivity.
3. THE System SHALL expose Prometheus-compatible metrics at `/metrics` including: HTTP request rate, HTTP error rate, p95 and p99 latency per endpoint, message queue depth, and active session count.
4. THE System SHALL implement distributed tracing using OpenTelemetry, propagating trace IDs across all service calls including HTTP handlers, database queries, queue publishes, and external calls.
5. WHEN the p95 API latency exceeds 1 second for 5 consecutive minutes, THE System SHALL emit an alert via the configured notification channel.
6. WHEN the HTTP error rate exceeds 1% for 5 consecutive minutes, THE System SHALL emit an alert via the configured notification channel.
7. WHEN the message queue depth exceeds 1,000 messages, THE System SHALL emit an alert via the configured notification channel.

---

### Requirement 23: Concurrency & Consistency

**User Story:** As a business owner, I want the system to handle concurrent operations safely, so that race conditions do not result in overselling, double payments, or data corruption.

#### Acceptance Criteria

1. WHEN two concurrent requests attempt to update the same Inventory record and both read the same version counter, THE System SHALL allow exactly one to succeed and SHALL return `409 VERSION_CONFLICT { retryable: true, currentVersion }` to the other.
2. WHEN a payment record is being written, THE System SHALL use pessimistic locking (`SELECT FOR UPDATE`) on the Order row to prevent double-payment race conditions.
3. WHEN an Order is being confirmed and stock is being reserved, THE System SHALL use `SELECT FOR UPDATE` on the relevant Inventory rows to prevent overselling.
4. THE System SHALL execute all atomic multi-entity writes within a single database transaction using `SERIALIZABLE` or `REPEATABLE READ` isolation.
5. THE System SHALL detect and reject duplicate Idempotency-Keys submitted within a 24-hour window, returning the original response without creating new records.

---

### Requirement 24: Data Volume Assumptions & Retention

**User Story:** As an operator, I want the system to be designed for realistic data volumes and to manage data growth proactively, so that performance does not degrade as the business scales.

#### Acceptance Criteria

1. THE System SHALL be designed to support up to 500 Transactions per Branch per day under normal load, with a peak capacity of 1,000 Transactions per Branch per day.
2. THE System SHALL be designed to support up to 10,000 Inventory records per Location and up to 50,000 Inventory records per Branch.
3. THE System SHALL be designed to support up to 50,000 Audit_Log entries per day system-wide.
4. THE System SHALL be designed to support up to 5 million Transaction line items per 12-month reporting period.
5. THE System SHALL partition the `transactions` table and the `audit_logs` table by month (`PARTITION BY RANGE` on `created_at`) to maintain query performance at scale.
6. THE System SHALL partition the `inventory_history` table by month to maintain query performance at scale.
7. THE System SHALL archive records older than 2 years to cold storage while keeping them queryable via the reporting interface.
8. THE System SHALL enforce Audit_Log retention for a minimum of 2 years in hot storage and 5 years in archive storage.

---

### Requirement 25: Failure Scenarios & Recovery

**User Story:** As an operator, I want the system to handle failures gracefully and recover predictably, so that data integrity is preserved and staff are informed of any issues.

#### Acceptance Criteria

1. IF a database failure occurs mid-transaction (e.g., during POS completion), THEN THE System SHALL roll back all changes and return a `503` response with a `Retry-After` header.
2. IF a payment gateway or bank transfer confirmation is not received within 30 seconds, THEN THE System SHALL mark the payment as `pending_confirmation`, notify the Cashier, and SHALL NOT mark the Transaction as complete.
3. IF a notification delivery attempt fails, THEN THE System SHALL retry up to 3 times with exponential backoff; after all retries are exhausted, THE System SHALL log the failure and flag the notification in the dead-letter queue for manual review.
4. IF a Report generation job exceeds its SLA, THEN THE System SHALL cancel the job, notify the requesting Staff member, and log the failure with the query details.
5. IF a CSV bank statement import fails mid-processing, THEN THE System SHALL roll back all matched records from that import batch and return a descriptive error identifying the row number that caused the failure.
6. THE System SHALL implement a dead-letter queue for failed asynchronous jobs; dead-letter items SHALL be visible to Staff with the Admin Role for manual retry or dismissal.

---

### Requirement 26: Asynchronous Operations

**User Story:** As a Staff member, I want long-running operations to run in the background without blocking my workflow, so that I can continue working while the system processes large tasks.

#### Acceptance Criteria

1. WHEN a Report is requested for a dataset covering more than 3 months, THE System SHALL process the request asynchronously and notify the requesting Staff member via an in-app notification, and optionally via email, when the Report is ready.
2. WHEN a bank statement CSV import contains more than 1,000 rows, THE System SHALL process the import asynchronously and display progress in the reconciliation interface.
3. WHEN a customer notification is triggered (order status change, payment reminder, low-stock alert), THE System SHALL deliver it via an asynchronous message queue; delivery failure SHALL NOT block the originating operation.
4. WHEN a Transaction is completed and the Loyalty_Program is enabled, THE System SHALL process loyalty point accrual asynchronously via the Outbox to avoid blocking the POS receipt response.
5. THE System SHALL write Audit_Log entries asynchronously via the Outbox pattern, ensuring guaranteed delivery without blocking the originating write operation; Outbox entries older than 7 days with `status='published'` SHALL be purged by a nightly cleanup job.

---

### Requirement 27: In-App Notifications (Real-Time Internal Alerts via SSE)

**User Story:** As a Staff member, I want to receive real-time in-app alerts for approval requests, job completions, and entity-level events, so that I can act immediately without polling or refreshing.

#### Acceptance Criteria

1. THE System SHALL maintain an `in_app_notifications` table storing: recipient Staff ID, notification type, title, body, reference entity type and ID, `is_read` flag, and `created_at` timestamp.

2. THE System SHALL expose a `GET /api/notifications/stream` SSE endpoint; WHEN an authenticated Staff member connects, THE System SHALL keep the connection open and push new `In_App_Notification` events to that client in real time.

3. WHEN an internal event requiring Staff attention occurs, THE System SHALL insert a row into the `in_app_notifications` table and push the notification to all connected SSE clients matching the recipient Staff ID. Triggering events include:
   - PO approval required (Purchasor creates PO above Manager approval threshold)
   - Return authorization required (return window exceeded, awaiting Manager approval)
   - Over-receipt confirmation required (PO receipt quantity exceeds ordered)
   - Async report ready or failed
   - Low-stock alert for assigned locations
   - Installment payment overdue
   - Order status changed (for the fulfilling Staff member)
   - Exchange order accepted or settled

4. THE System SHALL expose `GET /api/notifications` to retrieve paginated unread and recent notifications for the authenticated Staff member, and `PUT /api/notifications/:id/read` to mark a notification as read.

5. WHEN a Staff member's session ends or the SSE connection drops, THE System SHALL close the SSE stream gracefully; undelivered notifications SHALL remain in `in_app_notifications` and be retrievable via `GET /api/notifications` on reconnect.

6. THE System SHALL NOT block any originating operation on SSE delivery failure; in-app notification delivery is best-effort for the push channel, with the `in_app_notifications` table as the durable fallback.

7. THE System SHALL distinguish between in-app notifications (SSE, internal) and outbound notifications (email/SMS, external); each has its own worker and delivery channel; a single event MAY trigger both.

#### Constraints

- `in_app_notifications` table: no FK constraint on `staff_id` (allows retention after staff deactivation)
- SSE connections are stateless per request; the server maintains an in-memory registry of active SSE response streams keyed by `staff_id`
- SSE heartbeat: server sends a comment ping every 30 seconds to keep the connection alive through proxies
- Idempotency-Key: not required for notification read/unread actions

---

## 12. Cross-Cutting Concerns

### 12.1 Audit Consistency (Outbox Pattern)

- Audit log writes are NOT direct DB inserts from the service layer
- Every write operation inserts a row into the `outbox` table within the same DB transaction as the primary write
- The Outbox_Poller (background worker) reads pending outbox entries and writes to `audit_logs` and publishes domain events to BullMQ
- This guarantees: if the primary write commits, the audit entry will eventually be written; if the primary write rolls back, no audit entry is created
- Outbox entries older than 7 days with `status='published'` are purged by a nightly cleanup job

### 12.2 Caching Strategy

| Data | Cache | TTL | Invalidation |
|------|-------|-----|--------------|
| Dashboard KPIs | Redis | 60s | On Transaction or Order write |
| Effective config (branch + system) | Redis | 5 min | On config write |
| Book catalog (read-only fields) | Redis | 10 min | On book update |
| Active branch list | Redis | 5 min | On branch create/deactivate |
| Staff session / role | Redis (JWT) | 15 min (access token) | On deactivation |

### 12.3 Search Capability

- Full-text search on Books: by ISBN (exact, O(1) via unique index), title (prefix + full-text via PostgreSQL `tsvector`), author (prefix), category, tag
- Customer search: by name (prefix), email (exact via plaintext index column), phone (exact via plaintext index column)
- Transaction search: by Transaction ID (exact), Customer name, date range
- Order search: by Order number (exact), Customer name, status, date range
- All search endpoints use the same paginated list endpoint with filter params; no separate search endpoint
- Encrypted fields (`customers.email`, `customers.phone`) are NOT searchable via SQL LIKE; search uses separate plaintext index columns (first 3 chars + hash for lookup)

### 12.4 Pagination Standard

- All list endpoints use OFFSET-based pagination (`page` + `pageSize`) for standard views
- `pageSize` options: 25, 50, 100; default: 25
- Response includes: `{ items, total, page, pageSize, totalPages }`
- For large exports (> 10,000 rows): cursor-based pagination using `created_at + id` as composite cursor to avoid OFFSET performance degradation
- Export endpoints accept `cursor` param instead of `page` param

### 12.5 Sensitive Data Handling

- Column-level encryption (AES-256-GCM, application layer): `bank_accounts.account_number`, `bank_accounts.iban`, `customers.email`, `customers.phone`
- Encryption key loaded from environment variable `COLUMN_ENCRYPTION_KEY`; never committed to source control
- Encrypted fields are NOT searchable via SQL LIKE; search uses separate plaintext index columns
- PII fields are masked in logs: email shown as `j***@example.com`, phone as `***-***-1234`
- Audit_Log `meta` field stores masked values only for PII fields

---

## 13. Assumptions & Constraints

1. The system is a single-tenant deployment (one business, multiple branches); multi-tenancy is out of scope for v1.
2. No live payment gateway integration in v1; card payments are recorded as completed by the Cashier after physical terminal approval.
3. No live bank API integration in v1; bank reconciliation is manual CSV import only.
4. Email/SMS delivery is best-effort; notification failure does not block any core operation.
5. The base currency is a single currency system-wide; multi-currency transactions are out of scope for v1.
6. All monetary values are stored as `NUMERIC(14,2)` in the base currency; no floating-point types are used for financial data.
7. All timestamps are stored as `TIMESTAMPTZ` (UTC); display timezone is configurable per Branch.
8. The system does not generate accounting journal entries; it provides data sufficient for an accountant to do so.
9. ISBN validation follows ISBN-13 format; the system validates the check digit on entry.
10. Cover images are stored as URLs (external CDN); the system does not store binary image data.
11. The system supports a maximum of 500 Branches in v1; beyond this requires infrastructure review.
12. PostgreSQL 16 is the only supported database engine; no ORM abstraction layer (raw SQL via `pg` driver).
