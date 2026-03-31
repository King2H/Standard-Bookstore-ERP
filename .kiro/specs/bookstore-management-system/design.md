# Design Document — Bookstore Management System

## 1. Architecture Overview

### 1.1 Architecture Choice: Modular Monolith

**Decision:** Modular Monolith (not microservices).

**Justification:**
- The system is single-tenant with a single PostgreSQL instance; cross-module transactions (e.g., POS completion touches inventory, payments, loyalty, audit) require ACID guarantees that are trivial in a monolith and expensive across services.
- 500 concurrent users and 50 branches do not justify the operational overhead of a service mesh, distributed tracing across network hops, or eventual consistency trade-offs.
- The codebase is organized into domain modules with strict boundaries — migrating to microservices later is straightforward by extracting modules behind an API gateway.
- Each module owns its DB tables; no module queries another module's tables directly (service layer calls only).

**Future path:** The domain event / outbox pattern already decouples modules via BullMQ. Extracting a module to a microservice means pointing its queue consumer at a separate process — no schema changes required.

### 1.2 Technology Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Frontend | React + TypeScript | 18 / 5 |
| Styling | Tailwind CSS | 3 |
| UI Components | shadcn/ui (Radix UI + Tailwind) | latest |
| UI State | TanStack Query + TanStack Table | latest |
| Forms | React Hook Form + Zod | latest |
| Charts | Recharts | latest |
| Backend | Node.js + Express | 20 / 5 |
| Language | TypeScript | 5 |
| Database | PostgreSQL | 16 |
| DB Driver | pg (node-postgres) | latest |
| Migrations | node-pg-migrate | latest |
| Connection Pool | PgBouncer (transaction mode) | latest |
| Cache / Queue | Redis 7 + BullMQ | latest |
| Auth | JWT (access 15 min) + httpOnly refresh cookie (7 days) | — |
| Logging | Pino (structured JSON) | latest |
| Metrics | prom-client (Prometheus) | latest |
| Tracing | OpenTelemetry SDK + OTLP exporter | latest |
| Exports | json2csv + pdfkit | latest |
| Testing | Vitest + fast-check + Supertest | latest |
| Container | Docker + Docker Compose | latest |
| Reverse Proxy | Nginx | latest |

### 1.3 High-Level Architecture Diagram

```mermaid
graph TB
    subgraph Browser
        UI[React SPA\nTanStack Query + Recharts]
    end

    subgraph Gateway["Nginx (TLS termination, rate limiting, upstream LB)"]
        NG[Nginx]
    end

    subgraph APITier["API Tier — stateless, horizontally scaled"]
        A1[API Server 1\nExpress + Middleware]
        A2[API Server 2\nExpress + Middleware]
    end

    subgraph WorkerTier["Worker Tier — separate Docker service"]
        WO[Outbox Poller]
        WN[Notification Worker]
        WR[Report Worker]
        WL[Loyalty Worker]
        WI[Installment Checker cron]
        WC[Reconciliation Worker]
    end

    subgraph DataTier["Data Tier"]
        PGP[(PostgreSQL Primary\nwrites + OLTP reads)]
        PGR[(PostgreSQL Replica\nreports + dashboards)]
        RD[(Redis 7\nsessions + cache + queues)]
        PGB[PgBouncer\nconnection pool]
    end

    subgraph External
        EXT1[Email/SMS Provider]
        EXT2[Bank Statement CSV]
    end

    UI -->|HTTPS REST JSON| NG
    NG --> A1
    NG --> A2
    A1 --> PGB --> PGP
    A2 --> PGB --> PGP
    A1 -.->|reads| PGR
    A2 -.->|reads| PGR
    A1 --> RD
    A2 --> RD
    WO --> PGP
    WO --> RD
    WN --> RD
    WN --> EXT1
    WR --> PGR
    WL --> PGP
    WI --> PGP
    WC --> PGP
    EXT2 -->|CSV upload| NG
```

### 1.4 Module Boundaries

Each module owns its tables. Cross-module access goes through service interfaces only — never direct SQL across module boundaries.

**Canonical order** — Slice N = Requirement N = Task N across all three spec documents.

| Slice | Module | Owned Tables | Depends On |
|-------|--------|-------------|-----------|
| Slice 1 | Config | system_config, branch_config | — |
| Slice 2 | Auth / Staff | staff, staff_branch_roles, refresh_tokens | Slice 1 |
| Slice 3 | Branch | branches | Slice 2 |
| Slice 4 | BankAccount | bank_accounts, bank_reconciliation | Slice 3 |
| Slice 5 | Location | locations | Slice 3 |
| Slice 6 | Catalog | books, book_branch_prices, book_categories, book_tags, book_edit_history | Slice 3 |
| Slice 7 | Inventory | inventory, inventory_history | Slices 5, 6 |
| Slice 8 | Supplier | suppliers | Slice 2 |
| Slice 9 | Procurement | purchase_orders, po_line_items, po_receipts | Slices 7, 8 |
| Slice 10 | Customer | customers, loyalty_history, store_credit_history | Slice 1 |
| Slice 11 | POS | transactions, transaction_line_items, transaction_payments | Slices 4, 7, 10 |
| Slice 12 | Returns | returns, return_line_items, refunds | Slices 4, 11 |
| Slice 13 | Orders | orders, order_line_items | Slices 7, 10 |
| Slice 14 | Payments | order_payments, order_refunds, installment_plans, installments | Slices 4, 13 |
| Slice 15 | Exchange | merchants, exchange_agreements, exchange_orders, exchange_order_lines | Slices 6, 7 |
| Slice 16 | Reporting | (read-only views across all modules) | All |
| Slice 17 | UI / Dashboard | (frontend components + dashboard endpoint) | All |
| Slice 0 | Core (cross-cutting) | audit_logs, outbox, idempotency_keys | — |

---

## 2. Backend Source Structure

```
src/
├── middleware/
│   ├── auth.ts           # JWT verify → req.staff
│   ├── rbac.ts           # requireRole(...roles) factory
│   ├── branchCtx.ts      # X-Branch-Id header validation
│   ├── rateLimit.ts      # Redis sliding window (login + API)
│   ├── csrf.ts           # double-submit cookie
│   └── idempotency.ts    # Idempotency-Key dedup (DB + Redis)
├── modules/
│   ├── config/           service.ts, routes.ts
│   ├── auth/             service.ts, routes.ts
│   ├── branch/           service.ts, routes.ts
│   ├── bankAccount/      service.ts, routes.ts
│   ├── location/         service.ts, routes.ts
│   ├── catalog/          service.ts, routes.ts
│   ├── inventory/        service.ts, routes.ts
│   ├── supplier/         service.ts, routes.ts
│   ├── procurement/      service.ts, routes.ts
│   ├── customer/         service.ts, routes.ts
│   ├── pos/              service.ts, routes.ts
│   ├── returns/          service.ts, routes.ts
│   ├── orders/           service.ts, routes.ts
│   ├── payments/         service.ts, routes.ts
│   ├── exchange/         service.ts, routes.ts
│   └── reporting/        service.ts, routes.ts
├── workers/
│   ├── outboxPoller.ts   # SELECT FOR UPDATE SKIP LOCKED → BullMQ
│   ├── notifications.ts  # email/SMS dispatch
│   ├── reportGenerator.ts
│   ├── loyaltyAccrual.ts
│   ├── reconciliation.ts
│   └── installmentChecker.ts  # daily cron
├── queues/
│   └── index.ts          # BullMQ queue definitions + job types
├── db/
│   ├── primary.ts        # pg Pool → PgBouncer → PG primary
│   ├── replica.ts        # pg Pool → PG read replica
│   └── migrations/       # node-pg-migrate numbered files
├── lib/
│   ├── encryption.ts     # AES-256-GCM helpers
│   ├── hmac.ts           # HMAC-SHA256 audit signing
│   ├── redis.ts          # ioredis singleton
│   ├── outbox.ts         # insertOutbox(client, event, payload)
│   ├── idempotency.ts    # checkAndStore(key, fn)
│   └── listQuery.ts      # buildListQuery(filters, sort, page)
├── routes/
│   ├── health.ts         # GET /health
│   └── metrics.ts        # GET /metrics
└── app.ts                # Express app factory
```

---

## 3. Database Design

### 3.1 Naming Conventions

- Tables: `snake_case` plural (e.g., `purchase_orders`, `order_line_items`)
- Primary keys: `id` (SERIAL or BIGSERIAL)
- Foreign keys: `{referenced_table_singular}_id`
- Timestamps: `created_at TIMESTAMPTZ DEFAULT now()`, `updated_at` where mutable
- Soft delete: `is_active BOOLEAN NOT NULL DEFAULT true`
- Optimistic lock: `version INTEGER NOT NULL DEFAULT 0`
- Monetary values: `NUMERIC(14,2)` — never FLOAT
- Encrypted columns: suffix `_enc` not used; documented in schema comments

### 3.2 Core / Cross-Cutting Tables

```sql
-- ─────────────────────────────────────────────
-- AUDIT LOG (append-only, monthly partitioned)
-- ─────────────────────────────────────────────
CREATE TABLE audit_logs (
  id            BIGSERIAL,
  staff_id      INTEGER      NOT NULL,
  staff_role    TEXT         NOT NULL,
  action        TEXT         NOT NULL,  -- CREATE|UPDATE|DEACTIVATE|DELETE|LOGIN|LOGOUT
  entity_type   TEXT         NOT NULL,
  entity_id     TEXT         NOT NULL,
  branch_id     INTEGER,
  meta          JSONB,                  -- masked PII, prev/new values
  hmac_signature TEXT        NOT NULL,  -- HMAC-SHA256 tamper detection
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX ON audit_logs (entity_type, entity_id);
CREATE INDEX ON audit_logs (staff_id);
CREATE INDEX ON audit_logs (created_at);

-- ─────────────────────────────────────────────
-- OUTBOX (domain event relay)
-- ─────────────────────────────────────────────
CREATE TABLE outbox (
  id           BIGSERIAL PRIMARY KEY,
  event_type   TEXT        NOT NULL,
  payload      JSONB       NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','published','failed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
CREATE INDEX ON outbox (status, created_at);

-- ─────────────────────────────────────────────
-- IDEMPOTENCY KEYS (24h TTL)
-- ─────────────────────────────────────────────
CREATE TABLE idempotency_keys (
  key              TEXT        PRIMARY KEY,
  response_payload JSONB       NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '24 hours'
);
CREATE INDEX ON idempotency_keys (expires_at);

-- ─────────────────────────────────────────────
-- IN-APP NOTIFICATIONS (SSE durable store)
-- ─────────────────────────────────────────────
CREATE TABLE in_app_notifications (
  id              BIGSERIAL PRIMARY KEY,
  staff_id        INTEGER      NOT NULL,   -- recipient; no FK (retained after deactivation)
  notification_type TEXT       NOT NULL,   -- PO_APPROVAL_REQUIRED | RETURN_AUTH_REQUIRED |
                                           -- OVER_RECEIPT_CONFIRM | REPORT_READY | REPORT_FAILED |
                                           -- LOW_STOCK | INSTALLMENT_OVERDUE | ORDER_STATUS_CHANGED |
                                           -- EXCHANGE_SETTLED
  title           TEXT         NOT NULL,
  body            TEXT         NOT NULL,
  entity_type     TEXT,                    -- e.g. 'purchase_order', 'order', 'report_job'
  entity_id       TEXT,                    -- ID of the referenced entity
  is_read         BOOLEAN      NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX ON in_app_notifications (staff_id, is_read, created_at DESC);
```

### 3.3 Config Tables — Slice 1 (Requirement 1)

```sql
CREATE TABLE system_config (
  key        TEXT    PRIMARY KEY,
  value      JSONB   NOT NULL,
  updated_by INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE branch_config (
  branch_id  INTEGER NOT NULL REFERENCES branches(id),
  key        TEXT    NOT NULL,
  value      JSONB   NOT NULL,
  updated_by INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (branch_id, key)
);
```

**Seed — system_config defaults (inserted in initial migration):**

```sql
INSERT INTO system_config (key, value, updated_by) VALUES
  ('base_currency',                   '"USD"',                                    1),
  ('tax_rate',                        '0.10',                                     1),
  ('fiscal_year_start_month',         '1',                                        1),
  ('max_line_discount_pct',           '{"Sales":10,"Manager":25,"Admin":50}',     1),
  ('max_transaction_discount_pct',    '20',                                       1),
  ('discount_approval_threshold_pct', '15',                                       1),
  ('reorder_point_default',           '5',                                        1),
  ('allow_negative_stock',            'false',                                    1),
  ('po_approval_threshold',           '1000.00',                                  1),
  ('default_supplier_lead_time_days', '7',                                        1),
  ('return_window_days',              '30',                                       1),
  ('max_return_value_without_auth',   '500.00',                                   1),
  ('refund_method_after_window',      '"any"',                                    1),
  ('min_deposit_pct',                 '20',                                       1),
  ('max_installments',                '12',                                       1),
  ('installment_grace_period_days',   '0',                                        1),
  ('loyalty_accrual_rate',            '0.01',                                     1),
  ('loyalty_redemption_rate',         '1.0',                                      1),
  ('loyalty_min_transaction_amount',  '0.00',                                     1),
  ('exchange_cash_adjustment_allowed','true',                                     1),
  ('notification_prefs',              '{}',                                       1);
```

**config.service.ts — typed helper methods (all call `getEffectiveConfig` internally, cached in Redis `cfg:{branchId}:{key}` TTL 5min):**

```typescript
getEffectiveConfig(branchId: number, key: string): Promise<any>
getMaxLineDiscountPct(branchId: number, role: string): Promise<number>
getDiscountApprovalThresholdPct(branchId: number): Promise<number>
getPOApprovalThreshold(): Promise<number>
getReturnWindowDays(branchId: number): Promise<number>
getMaxReturnValueWithoutAuth(): Promise<number>
getRefundMethodAfterWindow(): Promise<'any' | 'store_credit_only'>
getMinDepositPct(branchId: number): Promise<number>
getMaxInstallments(): Promise<number>
getInstallmentGracePeriodDays(): Promise<number>
getAllowedPaymentMethods(branchId: number): Promise<string[]>
getLoyaltyAccrualRate(): Promise<number>
getLoyaltyRedemptionRate(): Promise<number>
getLoyaltyMinTransactionAmount(): Promise<number>
isNegativeStockAllowed(): Promise<boolean>
isExchangeCashAdjustmentAllowed(): Promise<boolean>
```

### 3.4 Auth Tables — Slice 2 (Requirement 2)

```sql
CREATE TABLE staff (
  id            SERIAL  PRIMARY KEY,
  username      TEXT    UNIQUE NOT NULL,
  password_hash TEXT    NOT NULL,          -- bcrypt cost 12
  full_name     TEXT    NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE staff_branch_roles (
  staff_id  INTEGER NOT NULL REFERENCES staff(id),
  branch_id INTEGER NOT NULL,
  role      TEXT    NOT NULL CHECK (role IN (
              'Super_Admin','Admin','Manager',
              'Finance_Officer','Stock_Clerk','Sales','Purchasor'
            )),
  PRIMARY KEY (staff_id, branch_id)
);
CREATE INDEX ON staff_branch_roles (branch_id);

CREATE TABLE refresh_tokens (
  id         BIGSERIAL PRIMARY KEY,
  staff_id   INTEGER   NOT NULL REFERENCES staff(id),
  token_hash TEXT      NOT NULL,           -- bcrypt hash of plaintext token
  expires_at TIMESTAMPTZ NOT NULL,
  revoked    BOOLEAN   NOT NULL DEFAULT false
);
CREATE INDEX ON refresh_tokens (staff_id, revoked);
```

### 3.5 Branch Tables — Slice 3 (Requirement 3)

```sql
CREATE TABLE branches (
  id              SERIAL  PRIMARY KEY,
  name            TEXT    UNIQUE NOT NULL,
  address         TEXT    NOT NULL,
  contact_info    JSONB   NOT NULL,        -- { phone, email }
  operating_hours JSONB   NOT NULL,        -- { mon: "09:00-18:00", ... }
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 3.6 Bank Account Tables — Slice 4 (Requirement 4)

```sql
CREATE TABLE bank_accounts (
  id             SERIAL  PRIMARY KEY,
  branch_id      INTEGER NOT NULL REFERENCES branches(id),
  account_name   TEXT    NOT NULL,
  bank_name      TEXT    NOT NULL,
  account_number TEXT    NOT NULL,  -- AES-256-GCM encrypted at app layer
  iban           TEXT,              -- AES-256-GCM encrypted at app layer, nullable
  currency       TEXT    NOT NULL,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON bank_accounts (branch_id, is_active);

CREATE TABLE bank_reconciliation (
  id              BIGSERIAL PRIMARY KEY,
  bank_account_id INTEGER   NOT NULL REFERENCES bank_accounts(id),
  payment_ref_id  BIGINT,            -- nullable → links to transaction_payments or order_payments
  refund_ref_id   BIGINT,            -- nullable → links to refunds or order_refunds
  amount          NUMERIC(14,2) NOT NULL,
  direction       TEXT NOT NULL CHECK (direction IN ('in','out')),
  status          TEXT NOT NULL DEFAULT 'uncleared'
                    CHECK (status IN ('uncleared','cleared','unmatched')),
  statement_date  DATE,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON bank_reconciliation (bank_account_id, status);
```

### 3.7 Location Tables — Slice 5 (Requirement 5)

```sql
CREATE TABLE locations (
  id                     SERIAL  PRIMARY KEY,
  branch_id              INTEGER NOT NULL REFERENCES branches(id),
  name                   TEXT    NOT NULL,
  is_default_fulfillment BOOLEAN NOT NULL DEFAULT false,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (branch_id, name)
);
CREATE INDEX ON locations (branch_id);
```

### 3.8 Catalog Tables — Slice 6 (Requirement 6)

```sql
CREATE TABLE books (
  id              SERIAL  PRIMARY KEY,
  isbn            TEXT    UNIQUE NOT NULL,  -- ISBN-13, check digit validated
  title           TEXT    NOT NULL,
  authors         TEXT[]  NOT NULL,
  genre           TEXT,
  publisher       TEXT,
  edition         TEXT,
  language        TEXT,
  format          TEXT,
  description     TEXT,
  cover_image_url TEXT,                     -- URL only, no binary storage
  default_price   NUMERIC(14,2),
  trade_value     NUMERIC(14,2),            -- used only for exchange orders
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  search_vector   TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(title,'') || ' ' || coalesce(array_to_string(authors,' '),''))
  ) STORED
);
CREATE INDEX ON books USING GIN (search_vector);
CREATE INDEX ON books (isbn);
CREATE INDEX ON books (is_active);

CREATE TABLE book_branch_prices (
  book_id   INTEGER      NOT NULL REFERENCES books(id),
  branch_id INTEGER      NOT NULL REFERENCES branches(id),
  price     NUMERIC(14,2) NOT NULL,
  PRIMARY KEY (book_id, branch_id)
);

CREATE TABLE book_categories (
  book_id  INTEGER NOT NULL REFERENCES books(id),
  category TEXT    NOT NULL,
  PRIMARY KEY (book_id, category)
);

CREATE TABLE book_tags (
  book_id INTEGER NOT NULL REFERENCES books(id),
  tag     TEXT    NOT NULL,
  PRIMARY KEY (book_id, tag)
);

CREATE TABLE book_edit_history (
  id         BIGSERIAL PRIMARY KEY,
  book_id    INTEGER   NOT NULL REFERENCES books(id),
  field_name TEXT      NOT NULL,
  old_value  TEXT,
  new_value  TEXT,
  changed_by INTEGER   NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON book_edit_history (book_id);
```

### 3.9 Inventory Tables — Slice 7 (Requirement 7)

```sql
CREATE TABLE inventory (
  book_id       INTEGER NOT NULL REFERENCES books(id),
  location_id   INTEGER NOT NULL REFERENCES locations(id),
  quantity      INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  reorder_point INTEGER NOT NULL DEFAULT 5,
  version       INTEGER NOT NULL DEFAULT 0,  -- optimistic locking
  PRIMARY KEY (book_id, location_id)
);
CREATE INDEX ON inventory (location_id);
CREATE INDEX ON inventory (quantity) WHERE quantity <= reorder_point;  -- low-stock partial index

CREATE TABLE inventory_history (
  id          BIGSERIAL,
  book_id     INTEGER NOT NULL,
  location_id INTEGER NOT NULL,
  qty_before  INTEGER NOT NULL,
  qty_after   INTEGER NOT NULL,
  delta       INTEGER NOT NULL,
  reason      TEXT    NOT NULL,  -- ADJUSTMENT|TRANSFER_OUT|TRANSFER_IN|SALE|RETURN|PO_RECEIPT|EXCHANGE_OUT|EXCHANGE_IN
  reason_code TEXT,              -- damage|loss|return|correction (manual adjustments only)
  staff_id    INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX ON inventory_history (book_id, location_id);
```

### 3.10 Supplier & Procurement Tables — Slices 8 & 9 (Requirements 8, 9)

```sql
CREATE TABLE suppliers (
  id             SERIAL  PRIMARY KEY,
  name           TEXT    UNIQUE NOT NULL,
  contact_info   JSONB   NOT NULL,
  lead_time_days INTEGER NOT NULL DEFAULT 7,
  pricing_terms  TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE purchase_orders (
  id              SERIAL  PRIMARY KEY,
  po_number       TEXT    UNIQUE NOT NULL,
  supplier_id     INTEGER NOT NULL REFERENCES suppliers(id),
  branch_id       INTEGER NOT NULL REFERENCES branches(id),
  location_id     INTEGER NOT NULL REFERENCES locations(id),
  status          TEXT    NOT NULL DEFAULT 'PendingApproval'
                    CHECK (status IN ('PendingApproval','Pending','In_Progress','Closed','Cancelled')),
  bank_account_id INTEGER REFERENCES bank_accounts(id),
  notes           TEXT,
  created_by      INTEGER NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON purchase_orders (supplier_id, status);
CREATE INDEX ON purchase_orders (branch_id, status);

CREATE TABLE po_line_items (
  id           SERIAL  PRIMARY KEY,
  po_id        INTEGER NOT NULL REFERENCES purchase_orders(id),
  book_id      INTEGER NOT NULL REFERENCES books(id),
  qty_ordered  INTEGER NOT NULL CHECK (qty_ordered > 0),
  qty_received INTEGER NOT NULL DEFAULT 0,
  unit_price   NUMERIC(14,2) NOT NULL
);
CREATE INDEX ON po_line_items (po_id);

CREATE TABLE po_receipts (
  id           BIGSERIAL PRIMARY KEY,
  po_id        INTEGER NOT NULL REFERENCES purchase_orders(id),
  line_item_id INTEGER NOT NULL REFERENCES po_line_items(id),
  qty_received INTEGER NOT NULL,
  over_receipt BOOLEAN NOT NULL DEFAULT false,
  confirmed_by INTEGER,
  received_by  INTEGER NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 3.11 Customer Tables — Slice 10 (Requirement 10)

```sql
CREATE TABLE customers (
  id             SERIAL  PRIMARY KEY,
  full_name      TEXT    NOT NULL,
  email          TEXT    UNIQUE,   -- AES-256-GCM encrypted; unique when non-null
  phone          TEXT    UNIQUE,   -- AES-256-GCM encrypted; unique when non-null
  email_lookup   TEXT,             -- first 3 chars + SHA256 hash for search
  phone_lookup   TEXT,             -- first 3 chars + SHA256 hash for search
  notes          TEXT,
  preferences    JSONB,
  store_credit   NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (store_credit >= 0),
  loyalty_points INTEGER       NOT NULL DEFAULT 0 CHECK (loyalty_points >= 0),
  version        INTEGER       NOT NULL DEFAULT 0,  -- optimistic locking
  is_active      BOOLEAN       NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT at_least_one_contact CHECK (email IS NOT NULL OR phone IS NOT NULL)
);
CREATE INDEX ON customers (email_lookup);
CREATE INDEX ON customers (phone_lookup);

CREATE TABLE loyalty_history (
  id              BIGSERIAL PRIMARY KEY,
  customer_id     INTEGER   NOT NULL REFERENCES customers(id),
  delta           INTEGER   NOT NULL,
  balance_after   INTEGER   NOT NULL,
  reason          TEXT      NOT NULL CHECK (reason IN ('ACCRUAL','REDEMPTION')),
  transaction_ref TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON loyalty_history (customer_id);

CREATE TABLE store_credit_history (
  id           BIGSERIAL PRIMARY KEY,
  customer_id  INTEGER   NOT NULL REFERENCES customers(id),
  delta        NUMERIC(14,2) NOT NULL,
  balance_after NUMERIC(14,2) NOT NULL,
  reason       TEXT      NOT NULL,  -- REFUND|EXCHANGE_ADJUSTMENT|REDEMPTION
  reference_id TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON store_credit_history (customer_id);
```

### 3.12 POS Transaction Tables — Slice 11 (Requirement 11, monthly partitioned)

```sql
CREATE TABLE transactions (
  id             BIGSERIAL,
  branch_id      INTEGER   NOT NULL REFERENCES branches(id),
  location_id    INTEGER   NOT NULL REFERENCES locations(id),
  customer_id    INTEGER   REFERENCES customers(id),  -- nullable: anonymous walk-in
  staff_id       INTEGER   NOT NULL,
  status         TEXT      NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','completed','voided')),
  subtotal       NUMERIC(14,2),
  discount_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_rate       NUMERIC(6,4)  NOT NULL,
  tax_amount     NUMERIC(14,2),
  total          NUMERIC(14,2),
  discount_reason TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at   TIMESTAMPTZ,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX ON transactions (branch_id, status);
CREATE INDEX ON transactions (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX ON transactions (completed_at) WHERE status = 'completed';

CREATE TABLE transaction_line_items (
  id             BIGSERIAL PRIMARY KEY,
  transaction_id BIGINT    NOT NULL,  -- no FK across partition boundary; enforced at app layer
  book_id        INTEGER   NOT NULL REFERENCES books(id),
  quantity       INTEGER   NOT NULL CHECK (quantity > 0),
  unit_price     NUMERIC(14,2) NOT NULL,
  discount_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  discount_reason TEXT,
  line_total     NUMERIC(14,2) NOT NULL
);
CREATE INDEX ON transaction_line_items (transaction_id);

CREATE TABLE transaction_payments (
  id             BIGSERIAL PRIMARY KEY,
  transaction_id BIGINT    NOT NULL,
  method         TEXT      NOT NULL
                   CHECK (method IN ('cash','credit_card','debit_card','store_credit','loyalty_points','bank_transfer')),
  amount         NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  bank_account_id INTEGER  REFERENCES bank_accounts(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON transaction_payments (transaction_id);
```

### 3.13 Returns Tables — Slice 12 (Requirement 12)

```sql
CREATE TABLE returns (
  id              BIGSERIAL PRIMARY KEY,
  original_tx_id  BIGINT    NOT NULL,
  branch_id       INTEGER   NOT NULL REFERENCES branches(id),
  location_id     INTEGER   NOT NULL REFERENCES locations(id),
  staff_id        INTEGER   NOT NULL,
  manager_auth_id INTEGER,            -- required when return window exceeded
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON returns (original_tx_id);

CREATE TABLE return_line_items (
  id            BIGSERIAL PRIMARY KEY,
  return_id     BIGINT    NOT NULL REFERENCES returns(id),
  tx_line_id    BIGINT    NOT NULL REFERENCES transaction_line_items(id),
  quantity      INTEGER   NOT NULL CHECK (quantity > 0),
  refund_amount NUMERIC(14,2) NOT NULL
);

CREATE TABLE refunds (
  id              BIGSERIAL PRIMARY KEY,
  return_id       BIGINT    NOT NULL REFERENCES returns(id),
  method          TEXT      NOT NULL CHECK (method IN ('original','store_credit','bank_transfer')),
  amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  bank_account_id INTEGER   REFERENCES bank_accounts(id),
  reason          TEXT      NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 3.14 Order & Payment Tables — Slices 13 & 14 (Requirements 13, 14)

```sql
CREATE TABLE orders (
  id           BIGSERIAL PRIMARY KEY,
  order_number TEXT      UNIQUE NOT NULL,
  customer_id  INTEGER   NOT NULL REFERENCES customers(id),
  branch_id    INTEGER   NOT NULL REFERENCES branches(id),
  location_id  INTEGER   NOT NULL REFERENCES locations(id),
  channel      TEXT      NOT NULL CHECK (channel IN ('in_store','phone','online')),
  status       TEXT      NOT NULL DEFAULT 'Pending'
                 CHECK (status IN ('Pending','Confirmed','In_Progress','Fulfilled','Cancelled')),
  tax_rate     NUMERIC(6,4)  NOT NULL,
  subtotal     NUMERIC(14,2),
  tax_amount   NUMERIC(14,2),
  total        NUMERIC(14,2),
  cancel_reason TEXT,
  created_by   INTEGER   NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON orders (customer_id, status);
CREATE INDEX ON orders (branch_id, status);
CREATE INDEX ON orders (created_at);

CREATE TABLE order_line_items (
  id            BIGSERIAL PRIMARY KEY,
  order_id      BIGINT    NOT NULL REFERENCES orders(id),
  book_id       INTEGER   NOT NULL REFERENCES books(id),
  quantity      INTEGER   NOT NULL CHECK (quantity > 0),
  unit_price    NUMERIC(14,2) NOT NULL,
  qty_reserved  INTEGER   NOT NULL DEFAULT 0,
  is_backordered BOOLEAN  NOT NULL DEFAULT false
);
CREATE INDEX ON order_line_items (order_id);

CREATE TABLE installment_plans (
  id             SERIAL  PRIMARY KEY,
  order_id       BIGINT  NOT NULL REFERENCES orders(id) UNIQUE,
  deposit_amount NUMERIC(14,2) NOT NULL,
  total_amount   NUMERIC(14,2) NOT NULL,
  created_by     INTEGER NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE installments (
  id          SERIAL  PRIMARY KEY,
  plan_id     INTEGER NOT NULL REFERENCES installment_plans(id),
  due_date    DATE    NOT NULL,
  amount      NUMERIC(14,2) NOT NULL,
  paid_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  status      TEXT    NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','partial','paid','overdue'))
);
CREATE INDEX ON installments (plan_id);
CREATE INDEX ON installments (due_date, status);  -- for installment checker cron

CREATE TABLE order_payments (
  id              BIGSERIAL PRIMARY KEY,
  order_id        BIGINT    NOT NULL REFERENCES orders(id),
  method          TEXT      NOT NULL
                    CHECK (method IN ('cash','credit_card','debit_card','store_credit','loyalty_points','bank_transfer')),
  amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  bank_account_id INTEGER   REFERENCES bank_accounts(id),
  staff_id        INTEGER   NOT NULL,
  version         INTEGER   NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON order_payments (order_id);

CREATE TABLE order_refunds (
  id              BIGSERIAL PRIMARY KEY,
  order_id        BIGINT    NOT NULL REFERENCES orders(id),
  payment_id      BIGINT    NOT NULL REFERENCES order_payments(id),
  amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  method          TEXT      NOT NULL,
  bank_account_id INTEGER   REFERENCES bank_accounts(id),
  reason          TEXT      NOT NULL,
  staff_id        INTEGER   NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON order_refunds (order_id);
```

### 3.15 Exchange Tables — Slice 15 (Requirement 15)

```sql
CREATE TABLE merchants (
  id           SERIAL  PRIMARY KEY,
  name         TEXT    UNIQUE NOT NULL,
  contact_info JSONB   NOT NULL,
  address      TEXT    NOT NULL,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE exchange_agreements (
  id          SERIAL  PRIMARY KEY,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id),
  basis       TEXT    NOT NULL CHECK (basis IN ('book_for_book','value_based')),
  terms       TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE exchange_orders (
  id                    BIGSERIAL PRIMARY KEY,
  agreement_id          INTEGER   NOT NULL REFERENCES exchange_agreements(id),
  branch_id             INTEGER   NOT NULL REFERENCES branches(id),
  src_location_id       INTEGER   NOT NULL REFERENCES locations(id),
  dst_location_id       INTEGER   NOT NULL REFERENCES locations(id),
  status                TEXT      NOT NULL DEFAULT 'Pending'
                          CHECK (status IN ('Pending','Accepted','Settled','Cancelled')),
  trade_value_offered   NUMERIC(14,2),
  trade_value_requested NUMERIC(14,2),
  adjustment_amount     NUMERIC(14,2),
  adjustment_type       TEXT      CHECK (adjustment_type IN ('cash','store_credit')),
  created_by            INTEGER   NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON exchange_orders (agreement_id, status);

CREATE TABLE exchange_order_lines (
  id                BIGSERIAL PRIMARY KEY,
  exchange_order_id BIGINT    NOT NULL REFERENCES exchange_orders(id),
  direction         TEXT      NOT NULL CHECK (direction IN ('offered','requested')),
  book_id           INTEGER   NOT NULL REFERENCES books(id),
  quantity          INTEGER   NOT NULL CHECK (quantity > 0),
  trade_value       NUMERIC(14,2) NOT NULL
);
CREATE INDEX ON exchange_order_lines (exchange_order_id);
```

### 3.16 Table Partitioning (Slices 7, 11 — high-volume tables)

Monthly partitions are created by a migration script that runs on the 25th of each month to pre-create the next month's partition.

```sql
-- transactions partitioned by created_at
CREATE TABLE transactions_2025_01 PARTITION OF transactions
  FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');

-- audit_logs partitioned by created_at
CREATE TABLE audit_logs_2025_01 PARTITION OF audit_logs
  FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');

-- inventory_history partitioned by created_at
CREATE TABLE inventory_history_2025_01 PARTITION OF inventory_history
  FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');
```

### 3.17 Indexing Strategy Summary

| Table | Index | Purpose |
|-------|-------|---------|
| books | GIN(search_vector) | Full-text title/author search |
| books | (isbn) | Exact ISBN lookup O(1) |
| inventory | partial (quantity <= reorder_point) | Low-stock alert queries |
| transactions | (branch_id, status) | Branch dashboard queries |
| transactions | (completed_at) WHERE completed | Sales report date range |
| orders | (customer_id, status) | Customer order history |
| orders | (branch_id, status) | Branch open orders count |
| installments | (due_date, status) | Daily cron overdue scan |
| outbox | (status, created_at) | Poller SELECT FOR UPDATE SKIP LOCKED |
| audit_logs | (entity_type, entity_id) | Entity audit trail lookup |
| refresh_tokens | (staff_id, revoked) | Token revocation check |

---

## 4. Data Flows

### 4.1 POS Transaction Completion Flow

```mermaid
sequenceDiagram
    participant UI as Cashier UI
    participant API as API Server
    participant MW as Middleware
    participant SVC as POS Service
    participant DB as PostgreSQL (Primary)
    participant RD as Redis
    participant Q as BullMQ

    UI->>API: POST /api/transactions/:id/complete\n{payments, Idempotency-Key}
    API->>MW: auth + rbac(Sales|Manager) + csrf + idempotency check
    MW->>RD: GET idem:{key} → miss
    API->>SVC: completeTransaction(id, payments, staffCtx)

    SVC->>DB: BEGIN (REPEATABLE READ)
    SVC->>DB: SELECT * FROM transactions WHERE id=$1 FOR UPDATE
    SVC->>DB: SELECT quantity, version FROM inventory\n WHERE book_id=ANY($books) AND location_id=$loc FOR UPDATE
    Note over SVC,DB: Validate stock; if insufficient → ROLLBACK → 422
    SVC->>DB: UPDATE inventory SET quantity=qty-sold, version=version+1\n WHERE book_id=$1 AND location_id=$2 AND version=$v
    Note over SVC,DB: 0 rows → ROLLBACK → 409 VERSION_CONFLICT
    SVC->>DB: INSERT INTO transaction_payments (...)
    SVC->>DB: UPDATE transactions SET status='completed', total=..., completed_at=now()
    SVC->>DB: INSERT INTO outbox (TransactionCompleted, payload)
    SVC->>DB: INSERT INTO inventory_history (SALE entries)
    SVC->>DB: COMMIT

    SVC->>RD: SET idem:{key} = response (TTL 24h)
    API-->>UI: 200 { receipt }

    Note over DB,Q: Async — does not block response
    DB-->>Q: Outbox Poller picks up TransactionCompleted
    Q-->>Q: loyalty-accrual queue
    Q-->>Q: audit-log-writes queue
    Q-->>Q: notifications queue (receipt)
```

**Step-by-step:**
1. Middleware validates JWT, role, CSRF token, and idempotency key (Redis miss = proceed)
2. Service opens `REPEATABLE READ` transaction
3. `SELECT FOR UPDATE` on transaction row (pessimistic — prevents concurrent completion)
4. `SELECT FOR UPDATE` on inventory rows (pessimistic — prevents overselling during reservation)
5. Optimistic version check on inventory update — 0 rows = conflict → rollback → 409
6. Insert payments, update transaction status, insert outbox event, insert inventory history
7. Commit — all or nothing
8. Cache idempotency response in Redis
9. Return receipt synchronously
10. Outbox poller (async) publishes `TransactionCompleted` → loyalty accrual, audit log, notification

### 4.2 Order + Installment Payment Flow

```mermaid
sequenceDiagram
    participant UI as Staff UI
    participant API as API Server
    participant SVC as Orders/Payments Service
    participant DB as PostgreSQL

    UI->>API: POST /api/orders {customerId, lines, channel}
    API->>SVC: createOrder()
    SVC->>DB: BEGIN\n INSERT orders (status=Pending)\n INSERT order_line_items\n INSERT outbox(OrderCreated)\n COMMIT
    API-->>UI: 201 {orderId, orderNumber}

    UI->>API: POST /api/orders/:id/confirm
    API->>SVC: confirmOrder()
    SVC->>DB: BEGIN\n SELECT inventory FOR UPDATE (all line items)\n UPDATE inventory SET qty_reserved += qty\n UPDATE orders SET status=Confirmed\n INSERT outbox(OrderStatusChanged)\n COMMIT
    API-->>UI: 200 {status: Confirmed}

    UI->>API: POST /api/orders/:id/installment-plan\n{depositAmount, installments:[{dueDate,amount}]}
    API->>SVC: createInstallmentPlan()
    Note over SVC: Validate: deposit >= min_deposit_pct × total\nSUM(installments) = total - deposit
    SVC->>DB: BEGIN\n INSERT installment_plans\n INSERT installments (status=pending)\n INSERT outbox(InstallmentPlanCreated)\n COMMIT
    API-->>UI: 201 {planId}

    UI->>API: POST /api/orders/:id/payments {method, amount}
    API->>SVC: recordPayment()
    SVC->>DB: BEGIN\n SELECT orders FOR UPDATE\n CHECK outstanding balance\n INSERT order_payments\n UPDATE installment status if applicable\n INSERT outbox(PaymentReceived)\n COMMIT
    API-->>UI: 200 {paymentId, outstandingBalance}
```

### 4.3 Inventory Update Flow (Transfer)

```mermaid
sequenceDiagram
    participant UI as Stock Clerk UI
    participant API as API Server
    participant SVC as Inventory Service
    participant DB as PostgreSQL

    UI->>API: POST /api/inventory/transfer\n{bookId, fromLocationId, toLocationId, quantity, version}
    API->>SVC: transferStock()
    SVC->>DB: BEGIN (REPEATABLE READ)
    SVC->>DB: SELECT quantity, version FROM inventory\n WHERE book_id=$1 AND location_id=$from FOR UPDATE
    Note over SVC: if quantity < requested → ROLLBACK → 422 INSUFFICIENT_STOCK
    SVC->>DB: UPDATE inventory SET quantity=qty-n, version=version+1\n WHERE book_id=$1 AND location_id=$from AND version=$v
    Note over SVC: 0 rows → ROLLBACK → 409 VERSION_CONFLICT
    SVC->>DB: UPDATE inventory SET quantity=qty+n, version=version+1\n WHERE book_id=$1 AND location_id=$to AND version=$v2
    SVC->>DB: INSERT INTO inventory_history (TRANSFER_OUT, TRANSFER_IN)
    SVC->>DB: INSERT INTO outbox (InventoryAdjusted)
    SVC->>DB: COMMIT
    API-->>UI: 200 {fromQuantity, toQuantity}
```

### 4.4 Bank Reconciliation Flow

```mermaid
sequenceDiagram
    participant UI as Manager UI
    participant API as API Server
    participant Q as BullMQ
    participant W as Reconciliation Worker
    participant DB as PostgreSQL

    UI->>API: POST /api/branches/:id/reconciliation/import (CSV file)
    Note over API: if rows > 1000 → async
    API->>Q: Enqueue bank-statement-import job {bankAccountId, csvData}
    API-->>UI: 202 {jobId}

    Q-->>W: Process job
    W->>DB: BEGIN
    loop For each CSV row
        W->>DB: SELECT * FROM transaction_payments\n WHERE amount=$amt AND created_at::date=$date
        alt Match found
            W->>DB: INSERT bank_reconciliation (status=uncleared, payment_ref_id)
        else No match
            W->>DB: INSERT bank_reconciliation (status=unmatched)
        end
    end
    W->>DB: COMMIT
    W->>DB: INSERT outbox (ReconciliationImportCompleted)
    Note over W: On any error → ROLLBACK entire batch

    UI->>API: PUT /api/branches/:id/reconciliation/:entryId {status: cleared}
    API->>DB: BEGIN\n UPDATE bank_reconciliation SET status=cleared\n INSERT outbox(ReconciliationCleared)\n COMMIT
    API-->>UI: 200
```

### 4.5 Exchange Settlement Flow

```mermaid
sequenceDiagram
    participant UI as Manager UI
    participant API as API Server
    participant SVC as Exchange Service
    participant DB as PostgreSQL

    UI->>API: POST /api/exchange-orders/:id/settle
    API->>SVC: settleExchange(id, staffCtx)
    SVC->>DB: BEGIN (REPEATABLE READ)
    SVC->>DB: SELECT * FROM exchange_orders WHERE id=$1 FOR UPDATE
    Note over SVC: Validate status = Accepted
    SVC->>DB: SELECT quantity, version FROM inventory\n WHERE book_id IN (offered books) FOR UPDATE
    Note over SVC: if any offered book insufficient → ROLLBACK → 422
    loop For each offered book
        SVC->>DB: UPDATE inventory SET quantity=qty-n, version=version+1\n WHERE book_id=$1 AND location_id=$src AND version=$v
    end
    loop For each requested book
        SVC->>DB: UPDATE inventory SET quantity=qty+n, version=version+1\n WHERE book_id=$1 AND location_id=$dst AND version=$v
    end
    SVC->>DB: UPDATE exchange_orders SET status=Settled
    SVC->>DB: INSERT inventory_history (EXCHANGE_OUT, EXCHANGE_IN entries)
    SVC->>DB: INSERT outbox (ExchangeSettled)
    SVC->>DB: COMMIT
    API-->>UI: 200 {status: Settled}
```

---

## 5. Concurrency & Consistency Design

### 5.1 Locking Strategy by Operation

| Operation | Strategy | Rationale |
|-----------|----------|-----------|
| Inventory quantity update (sale, transfer, adjustment, PO receipt, exchange) | Optimistic (version counter) | High read:write ratio; conflicts are rare; retry is cheap |
| Order stock reservation (confirm) | Pessimistic (SELECT FOR UPDATE on inventory rows) | Must prevent overselling; reservation is a critical section |
| Transaction completion (payment recording) | Pessimistic (SELECT FOR UPDATE on transaction row) | Prevents two cashiers completing the same transaction |
| Order payment recording | Pessimistic (SELECT FOR UPDATE on order row) | Prevents double-payment race condition |
| Customer store_credit / loyalty_points update | Optimistic (version counter on customers row) | Low contention; async loyalty accrual further reduces pressure |
| Outbox polling | Pessimistic (SELECT FOR UPDATE SKIP LOCKED) | Multiple poller instances can run safely |

### 5.2 Optimistic Lock Implementation

```typescript
// inventory.service.ts
async function decrementInventory(
  client: PoolClient,
  bookId: number,
  locationId: number,
  qty: number,
  currentVersion: number
): Promise<void> {
  const result = await client.query(
    `UPDATE inventory
     SET quantity = quantity - $1, version = version + 1
     WHERE book_id = $2 AND location_id = $3 AND version = $4
       AND quantity >= $1`,
    [qty, bookId, locationId, currentVersion]
  );
  if (result.rowCount === 0) {
    // Re-read to distinguish version conflict from insufficient stock
    const current = await client.query(
      `SELECT quantity, version FROM inventory WHERE book_id=$1 AND location_id=$2`,
      [bookId, locationId]
    );
    if (current.rows[0].version !== currentVersion) {
      throw new VersionConflictError(current.rows[0].version);
    }
    throw new InsufficientStockError(current.rows[0].quantity, qty);
  }
}
```

### 5.3 Transaction Isolation Levels

| Operation | Isolation Level | Why |
|-----------|----------------|-----|
| POS completion | REPEATABLE READ | Prevents phantom reads on inventory during multi-book transactions |
| Order fulfillment | REPEATABLE READ | Same — multiple inventory rows read and written |
| Exchange settlement | REPEATABLE READ | Atomic multi-book inventory swap |
| Stock transfer | REPEATABLE READ | Two-location atomic update |
| Single-row writes (config, staff, branch) | READ COMMITTED (default) | No multi-row consistency needed |

### 5.4 Idempotency Implementation

```typescript
// lib/idempotency.ts
export async function withIdempotency<T>(
  key: string,
  fn: () => Promise<T>
): Promise<{ result: T; replayed: boolean }> {
  // 1. Check DB (source of truth)
  const existing = await db.primary.query(
    `SELECT response_payload FROM idempotency_keys WHERE key = $1 AND expires_at > now()`,
    [key]
  );
  if (existing.rows.length > 0) {
    return { result: existing.rows[0].response_payload, replayed: true };
  }
  // 2. Execute the operation
  const result = await fn();
  // 3. Store result (best-effort; if this fails, operation already succeeded)
  await db.primary.query(
    `INSERT INTO idempotency_keys (key, response_payload) VALUES ($1, $2)
     ON CONFLICT (key) DO NOTHING`,
    [key, JSON.stringify(result)]
  );
  return { result, replayed: false };
}
```

---

## 6. API Design

### 6.1 Request / Response Conventions

- All requests: `Content-Type: application/json`
- All authenticated requests: `Authorization: Bearer {accessToken}` + `X-Branch-Id: {branchId}`
- State-mutating POST requests: `Idempotency-Key: {uuid-v4}` (required for financial endpoints)
- CSRF: `X-CSRF-Token: {value}` (matches `csrf-token` cookie)
- Pagination response shape: `{ items: [...], total: number, page: number, pageSize: number, totalPages: number }`
- Error response shape: `{ error: "ERROR_CODE", message: "...", details: {}, requestId: "uuid", timestamp: "ISO-8601" }`

### 6.2 HTTP Status Code Map

| Code | When |
|------|------|
| 200 | Successful GET, PUT, PATCH |
| 201 | Successful POST (resource created) |
| 202 | Async job queued; over-receipt pending confirmation |
| 400 | Schema/validation failure |
| 401 | Missing/expired/revoked token |
| 403 | Insufficient role; return window exceeded without manager auth |
| 404 | Entity not found |
| 409 | Duplicate, dependency conflict, VERSION_CONFLICT, invalid state transition |
| 422 | Business rule violation (insufficient stock, payment mismatch, balance exceeded) |
| 429 | Rate limit exceeded |
| 503 | DB failure / circuit breaker open (includes `Retry-After` header) |

### 6.3 Auth Endpoints

```
POST /api/auth/login
  Body:     { username, password, branchId }
  Response: { accessToken, expiresIn: 900 }
            Set-Cookie: refreshToken=...; HttpOnly; SameSite=Strict; Secure
  Errors:   401 INVALID_CREDENTIALS | 403 ACCOUNT_INACTIVE | 429 RATE_LIMITED

POST /api/auth/refresh
  Cookie:   refreshToken
  Response: { accessToken, expiresIn: 900 }
  Errors:   401 TOKEN_EXPIRED | 401 TOKEN_REVOKED

POST /api/auth/logout
  Effect:   Revokes current refresh token; clears cookie
```

### 6.4 Config Endpoints

```
GET  /api/config/system
     Role: Super_Admin, Admin, Manager (read)
     Response: [{ key, value, updatedAt }]  -- all system_config rows

GET  /api/config/system/:key
     Role: Super_Admin, Admin, Manager
     Response: { key, value }

PUT  /api/config/system/:key
     Role: Super_Admin only
     Body:     { value }
     Response: { key, value, updatedAt }
     Errors:   403 FORBIDDEN | 400 INVALID_CONFIG_VALUE

GET  /api/config/branches/:branchId
     Role: Super_Admin, Admin, Manager (own branch)
     Response: [{ key, effectiveValue, source: 'branch'|'system' }]
               -- merged view: branch overrides + system defaults

GET  /api/config/branches/:branchId/:key
     Role: Super_Admin, Admin, Manager (own branch)
     Response: { key, effectiveValue, source }

PUT  /api/config/branches/:branchId/:key
     Role: Super_Admin, Admin, Manager (own branch)
     Body:     { value }
     Response: { key, value, updatedAt }
     Errors:   403 FORBIDDEN | 400 INVALID_CONFIG_VALUE

DELETE /api/config/branches/:branchId/:key
     Role: Super_Admin, Admin
     Effect:   Removes branch override; key falls back to system default
```

### 6.5 Inventory Endpoints

```
GET  /api/inventory
     ?branchId&locationId&bookId&lowStock=true&page&pageSize&sortBy&sortDir
     Role: Any authenticated
     Response: paginated inventory items with version

PUT  /api/inventory/:bookId/:locationId/adjust
     Role: Manager, Stock_Clerk | Idempotency-Key: required
     Body:     { delta: number, reasonCode: string, version: number }
     Response: { quantity, version }
     Errors:   409 VERSION_CONFLICT | 422 INSUFFICIENT_STOCK | 400 INVALID_REASON_CODE

POST /api/inventory/transfer
     Role: Manager, Stock_Clerk | Idempotency-Key: required
     Body:     { bookId, fromLocationId, toLocationId, quantity, fromVersion }
     Response: { fromQuantity, toQuantity }
     Errors:   409 VERSION_CONFLICT | 422 INSUFFICIENT_STOCK
```

### 6.6 POS Endpoints

```
POST /api/transactions
     Role: Sales, Manager
     Body:     { branchId, locationId, customerId? }
     Response: { transactionId, status: 'draft' }

POST /api/transactions/:id/lines
     Role: Sales, Manager
     Body:     { bookId, quantity, discountAmount?, discountReason? }
     Response: { lineId, unitPrice, lineTotal }
     Errors:   422 BOOK_INACTIVE | 404 BOOK_NOT_FOUND | 400 DISCOUNT_REASON_REQUIRED

POST /api/transactions/:id/complete
     Role: Sales, Manager | Idempotency-Key: required
     Body:     { payments: [{ method, amount, bankAccountId? }],
                 managerOverride?: { managerId, reason } }
     Response: { transactionId, receipt: { lines, discounts, tax, payments, total } }
     Errors:   409 VERSION_CONFLICT | 422 INSUFFICIENT_STOCK
               422 PAYMENT_SUM_MISMATCH | 422 INVALID_BANK_ACCOUNT
               409 ALREADY_COMPLETED

POST /api/transactions/:id/void
     Role: Sales, Manager
     Body:     { reason }
     Errors:   409 ALREADY_COMPLETED
```

### 6.7 Order Endpoints

```
POST /api/orders
     Role: Sales, Manager | Idempotency-Key: required
     Body:     { customerId, branchId, locationId, channel, lines: [{bookId, quantity}] }
     Response: { orderId, orderNumber, status: 'Pending', total }

POST /api/orders/:id/confirm
     Role: Manager, Sales | Idempotency-Key: required
     Response: { orderId, status: 'Confirmed', reservedItems }
     Errors:   422 INSUFFICIENT_STOCK (backordered items listed)

POST /api/orders/:id/fulfill
     Role: Manager | Idempotency-Key: required
     Response: { orderId, status: 'Fulfilled', invoiceUrl }

POST /api/orders/:id/cancel
     Role: Manager
     Body:     { reason }
     Errors:   409 ORDER_ALREADY_FULFILLED

POST /api/orders/:id/payments
     Role: Sales, Manager, Finance_Officer | Idempotency-Key: required
     Body:     { method, amount, bankAccountId? }
     Response: { paymentId, outstandingBalance }
     Errors:   422 EXCEEDS_OUTSTANDING_BALANCE | 422 INVALID_BANK_ACCOUNT

POST /api/orders/:id/installment-plan
     Role: Manager, Finance_Officer | Idempotency-Key: required
     Body:     { depositAmount, installments: [{dueDate, amount}] }
     Errors:   422 DEPOSIT_BELOW_MINIMUM | 422 INSTALLMENT_SUM_MISMATCH

POST /api/orders/:id/refunds
     Role: Sales, Manager, Finance_Officer | Idempotency-Key: required
     Body:     { paymentId, amount, method, bankAccountId?, reason }
     Errors:   422 EXCEEDS_PAYMENT_AMOUNT
```

### 6.8 Returns Endpoint

```
POST /api/returns
     Role: Sales, Manager | Idempotency-Key: required
     Body:     { originalTxId, lines: [{txLineId, quantity}],
                 refundMethod, bankAccountId?, reason, managerAuthId? }
     Response: { returnId, refundAmount, inventoryRestored }
     Errors:   403 RETURN_WINDOW_EXCEEDED | 422 QUANTITY_EXCEEDS_ORIGINAL
               422 ALREADY_RETURNED | 422 INVALID_TRANSACTION_REFERENCE
```

### 6.9 Report Endpoints

```
GET /api/reports/:type
    ?branchId&from&to&[type-specific filters]
    Role: Admin, Manager
    Response (<=3 months):  { data: [...], generatedAt }
    Response (>3 months):   202 { jobId, status: 'queued', estimatedMinutes: 5 }

GET /api/reports/jobs/:jobId
    Role: Admin, Manager
    Response: { jobId, status, downloadUrl? }

GET /api/dashboard
    ?branchId (optional — omit for all-branch aggregate)
    Role: Admin, Manager, Finance_Officer, Sales
    Response: { todayRevenue, todayTransactionCount, lowStockCount,
                openOrdersCount, installmentsDueIn7Days }
    Cache: Redis 60s TTL per branchId
```

### 6.10 In-App Notification Endpoints (SSE)

```
GET /api/notifications/stream
    Role: Any authenticated
    Headers: Accept: text/event-stream
    Behavior: Opens a persistent SSE connection; server pushes events as:
              data: {"id":1,"type":"PO_APPROVAL_REQUIRED","title":"...","body":"...","entityType":"purchase_order","entityId":"42"}
    Heartbeat: server sends ": ping" comment every 30s to keep connection alive through proxies
    On disconnect: server removes client from SSE registry; client reconnects automatically

GET /api/notifications
    Role: Any authenticated
    ?isRead=false&page&pageSize
    Response: paginated { items: [{ id, type, title, body, entityType, entityId, isRead, createdAt }] }

PUT /api/notifications/:id/read
    Role: Any authenticated
    Response: { id, isRead: true }

PUT /api/notifications/read-all
    Role: Any authenticated
    Response: { updated: number }
```

### 6.11 SSE Architecture

```
Browser (React)                    API Server                    InApp Worker
     │                                  │                              │
     │── GET /api/notifications/stream ─►│                              │
     │                                  │ Register SSEResponse          │
     │                                  │ in sseRegistry[staffId]       │
     │                                  │                              │
     │                                  │◄── BullMQ inapp-notifications ─│
     │                                  │    job: { staffId, payload }  │
     │                                  │                              │
     │                                  │ INSERT in_app_notifications   │
     │                                  │ Lookup sseRegistry[staffId]   │
     │◄── data: { notification } ───────│ res.write(sseEvent)           │
     │                                  │                              │
     │── PUT /api/notifications/:id/read►│                              │
     │◄── { isRead: true } ─────────────│                              │
```

**SSE Registry** (`lib/sseRegistry.ts`):
```typescript
// In-memory map: staffId → Set of active SSE response objects
const registry = new Map<number, Set<Response>>();

export function register(staffId: number, res: Response): void {
  if (!registry.has(staffId)) registry.set(staffId, new Set());
  registry.get(staffId)!.add(res);
  res.on('close', () => { registry.get(staffId)?.delete(res); });
}

export function push(staffId: number, event: object): void {
  registry.get(staffId)?.forEach(res => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });
}
```

Note: the SSE registry is in-process. In a horizontally scaled deployment (multiple API server instances), a staff member's SSE connection may land on a different instance than the one processing the BullMQ job. To handle this, the InApp worker publishes to a Redis pub/sub channel (`inapp:{staffId}`); each API server subscribes and pushes to its local SSE connections for that `staffId`.

---

## 7. Asynchronous Processing

### 7.1 Outbox Pattern

Every write operation inserts a row into `outbox` within the same DB transaction. The Outbox Poller runs every 1 second and uses `SELECT FOR UPDATE SKIP LOCKED` so multiple poller instances can run safely without duplicate processing.

```
API Handler
  └─ BEGIN TRANSACTION
       ├─ Write primary entity
       └─ INSERT INTO outbox (event_type, payload, status='pending')
     COMMIT

Outbox Poller (every 1s, SKIP LOCKED)
  └─ SELECT id, event_type, payload FROM outbox
       WHERE status='pending' ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED
       ├─ Publish to BullMQ queue based on event_type
       └─ UPDATE outbox SET status='published', published_at=now() WHERE id=ANY($ids)
```

Workers MUST be idempotent — if the poller crashes after publishing but before marking `published`, the event will be re-published on the next poll cycle.

### 7.2 BullMQ Queue Definitions

| Queue | Producer | Consumer | Retry | DLQ after |
|-------|----------|----------|-------|-----------|
| `notifications` | Outbox Poller | Notification Worker (outbound: email/SMS) | 3× exp backoff | 3 failures |
| `inapp-notifications` | Outbox Poller | InApp Notification Worker (SSE push + DB write) | 3× exp backoff | 3 failures |
| `report-generation` | API (async report request) | Report Worker | 1× | 1 failure |
| `loyalty-accrual` | Outbox Poller (TransactionCompleted) | Loyalty Worker | 3× exp backoff | 3 failures |
| `audit-log-writes` | Outbox Poller (all events) | Audit Log Writer | 5× exp backoff | 5 failures |
| `bank-statement-import` | API (CSV upload >1000 rows) | Reconciliation Worker | 1× | 1 failure |
| `dead-letter` | Any worker after max retries | Admin review (UI) | manual | — |

### 7.3 Worker Responsibilities

**Outbox Poller** (`workers/outboxPoller.ts`)
- Polls every 1s with `SKIP LOCKED`
- Routes events to correct BullMQ queue by `event_type`:

| event_type | BullMQ Queue | Notes |
|------------|-------------|-------|
| `TransactionCompleted` | `loyalty-accrual` + `audit-log-writes` + `notifications` | loyalty async; outbound receipt email optional |
| `InventoryAdjusted` | `inapp-notifications` + `audit-log-writes` | low-stock alert to Manager/Stock_Clerk |
| `OrderStatusChanged` | `inapp-notifications` + `notifications` + `audit-log-writes` | in-app to fulfilling staff; email/SMS to customer |
| `PaymentReceived` | `audit-log-writes` | balance update already sync |
| `ExchangeSettled` | `inapp-notifications` + `audit-log-writes` | in-app to Manager |
| `POApprovalRequired` | `inapp-notifications` | in-app to Manager/Admin |
| `ReturnAuthRequired` | `inapp-notifications` | in-app to Manager |
| `OverReceiptConfirmRequired` | `inapp-notifications` | in-app to Manager |
| `ReportReady` | `inapp-notifications` + `notifications` | in-app + optional email |
| `InstallmentOverdue` | `inapp-notifications` + `notifications` | in-app to Finance_Officer; email/SMS to customer |
| `ReconciliationImportCompleted` | `inapp-notifications` | in-app to Finance_Officer/Manager |

- Marks entries `published` after successful enqueue
- Marks entries `failed` after 5 consecutive publish errors

**Notification Worker** (`workers/notifications.ts`)
- Consumes `notifications` queue — outbound email/SMS only
- Calls Email/SMS provider (SendGrid/Twilio)
- Retries 3× with exponential backoff (1s, 2s, 4s)
- Moves to dead-letter after 3 failures; logs failure with job details

**InApp Notification Worker** (`workers/inAppNotifications.ts`)
- Consumes `inapp-notifications` queue — internal real-time alerts only
- Inserts a row into `in_app_notifications` table (durable store)
- Looks up active SSE connections for the recipient `staff_id` from the in-memory SSE registry
- If a connection exists: pushes the event as an SSE `data:` message immediately
- If no connection: notification is persisted in DB only; client retrieves on next `GET /api/notifications`
- Retries 3× on DB insert failure; SSE push failure is non-retryable (best-effort)

**Report Worker** (`workers/reportGenerator.ts`)
- Consumes `report-generation` queue
- Runs heavy SQL against `db.replica`
- Enforces 5-minute SLA; cancels job and notifies staff if exceeded
- Stores result as downloadable file; notifies staff via `notifications` queue

**Loyalty Worker** (`workers/loyaltyAccrual.ts`)
- Consumes `loyalty-accrual` queue
- Updates `customers.loyalty_points` with optimistic locking
- Inserts `loyalty_history` row
- Idempotent: checks if accrual already recorded for this `transaction_ref`

**Installment Checker** (`workers/installmentChecker.ts`)
- Runs daily at 00:00 UTC via cron
- `UPDATE installments SET status='overdue' WHERE due_date < now() AND status IN ('pending','partial') AND paid_amount < amount`
- Enqueues payment reminder notifications for each overdue installment

**Reconciliation Worker** (`workers/reconciliation.ts`)
- Consumes `bank-statement-import` queue
- Processes CSV rows in a single DB transaction
- Rolls back entire batch on any row failure
- Reports row-level error to staff

### 7.4 Redis Key Patterns

| Purpose | Key Pattern | TTL |
|---------|-------------|-----|
| Dashboard KPI cache | `kpi:{branchId}` | 60s |
| Effective config cache | `cfg:{branchId}:{key}` | 5 min |
| Book catalog cache | `book:{bookId}` | 10 min |
| Active branches list | `branches:active` | 5 min |
| Idempotency key | `idem:{key}` | 24h |
| Rate limit — login per IP | `rl:login:{ip}` | 15 min |
| Rate limit — API per user | `rl:api:{staffId}` | 60s |
| Token revocation flag | `rt:revoked:{staffId}` | 7 days |

---

## 8. Security Design

### 8.1 JWT Authentication Flow

```mermaid
sequenceDiagram
    participant UI as Browser
    participant API as API Server
    participant DB as PostgreSQL
    participant RD as Redis

    UI->>API: POST /api/auth/login {username, password, branchId}
    API->>RD: INCR rl:login:{ip} (rate limit check)
    API->>DB: SELECT staff WHERE username=$1
    API->>API: bcrypt.compare(password, hash)
    API->>DB: INSERT refresh_tokens (bcrypt hash of token)
    API-->>UI: { accessToken (15min JWT) }\nSet-Cookie: refreshToken (httpOnly, 7d)

    Note over UI,API: 15 minutes later — access token expires
    UI->>API: POST /api/auth/refresh (cookie sent automatically)
    API->>DB: SELECT refresh_tokens WHERE staff_id=$1 AND revoked=false
    API->>API: bcrypt.compare(cookie token, stored hash)
    API->>RD: GET rt:revoked:{staffId} (fast revocation check)
    API-->>UI: { accessToken (new 15min JWT) }

    Note over UI,API: Staff deactivated
    API->>DB: UPDATE refresh_tokens SET revoked=true WHERE staff_id=$1
    API->>RD: SET rt:revoked:{staffId} = true (TTL 7d)
    Note over UI: Next refresh attempt → 401 TOKEN_REVOKED
```

### 8.2 Password Hashing

```typescript
// bcrypt cost factor 12 — ~250ms on modern hardware
const hash = await bcrypt.hash(password, 12);
// Verify
const valid = await bcrypt.compare(plaintext, hash);
```

Complexity policy (enforced at API layer via Zod schema):
- Minimum 10 characters
- At least 1 uppercase, 1 lowercase, 1 digit, 1 special character

### 8.3 Rate Limiting (Redis Sliding Window)

```typescript
// middleware/rateLimit.ts
async function loginRateLimit(ip: string): Promise<void> {
  const key = `rl:login:${ip}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 900); // 15 min window
  if (count > 10) throw new RateLimitError(await redis.ttl(key));
}

async function apiRateLimit(staffId: number): Promise<void> {
  const key = `rl:api:${staffId}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 60); // 1 min window
  if (count > 200) throw new RateLimitError(await redis.ttl(key));
}
```

### 8.4 CSRF Protection

Double-submit cookie pattern:
1. On login, server sets `csrf-token` cookie (`httpOnly=false`, `SameSite=Strict`, `Secure`)
2. React reads cookie and sends as `X-CSRF-Token` header on every mutating request
3. `middleware/csrf.ts` validates `req.headers['x-csrf-token'] === req.cookies['csrf-token']`
4. Mismatch → 403 CSRF_INVALID

### 8.5 Column-Level Encryption

```typescript
// lib/encryption.ts
const ALGO = 'aes-256-gcm';
const KEY = Buffer.from(process.env.COLUMN_ENCRYPTION_KEY!, 'hex'); // 32 bytes

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decrypt(ciphertext: string): string {
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final('utf8');
}
```

Encrypted fields: `bank_accounts.account_number`, `bank_accounts.iban`, `customers.email`, `customers.phone`.

Search on encrypted fields uses `email_lookup` / `phone_lookup` columns (first 3 chars + SHA-256 hash).

### 8.6 Audit Log Integrity (HMAC-SHA256)

```typescript
// lib/hmac.ts
const SIGNING_KEY = process.env.AUDIT_SIGNING_KEY!;

export function signAuditEntry(entry: {
  id: string; staffId: number; action: string;
  entityType: string; entityId: string; createdAt: string;
}): string {
  const data = `${entry.id}|${entry.staffId}|${entry.action}|${entry.entityType}|${entry.entityId}|${entry.createdAt}`;
  return crypto.createHmac('sha256', SIGNING_KEY).update(data).digest('hex');
}
```

Verification endpoint: `GET /api/audit-logs/:id/verify` (Admin only) — recomputes and compares signature.

---

## 9. Observability

### 9.1 Structured Logging (Pino)

```typescript
// Every request log line includes:
{
  "level": "info",
  "requestId": "uuid",
  "staffId": 42,
  "branchId": 3,
  "method": "POST",
  "path": "/api/transactions/123/complete",
  "statusCode": 200,
  "durationMs": 187,
  "traceId": "abc123"   // OpenTelemetry trace ID
}
// PII masking: email → "j***@example.com", phone → "***-***-1234"
```

Log levels: `error` (5xx), `warn` (4xx), `info` (successful writes), `debug` (reads — disabled in production).

### 9.2 Prometheus Metrics

```typescript
// Key metrics exposed at GET /metrics
http_request_duration_seconds{method, route, status_code}  // Histogram
http_requests_total{method, route, status_code}            // Counter
queue_depth{queue_name}                                    // Gauge
active_sessions                                            // Gauge
db_query_duration_seconds{query_name}                      // Histogram
inventory_version_conflicts_total                          // Counter
idempotency_replays_total                                  // Counter
```

### 9.3 Alerting Rules (Prometheus Alertmanager)

```yaml
groups:
  - name: bms
    rules:
      - alert: HighP95Latency
        expr: histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m])) > 1
        for: 5m
        annotations:
          summary: "p95 API latency > 1s for 5 minutes"

      - alert: HighErrorRate
        expr: rate(http_requests_total{status_code=~"5.."}[1m]) /
              rate(http_requests_total[1m]) > 0.01
        for: 5m

      - alert: QueueDepthHigh
        expr: queue_depth > 1000
        for: 1m

      - alert: InventoryVersionConflictsHigh
        expr: rate(inventory_version_conflicts_total[5m]) > 10
        for: 2m
```

### 9.4 Distributed Tracing (OpenTelemetry)

- SDK: `@opentelemetry/sdk-node` with auto-instrumentation for `express`, `pg`, `ioredis`
- Exporter: OTLP HTTP to Jaeger or Grafana Tempo (configured via `OTEL_EXPORTER_OTLP_ENDPOINT`)
- Trace ID propagated via `AsyncLocalStorage` into every Pino log line
- Spans created for: HTTP handler, DB query, BullMQ publish, external HTTP call

### 9.5 Health Check

```
GET /health
Response 200: {
  "status": "ok",
  "db": { "primary": "ok", "replica": "ok" },
  "redis": "ok",
  "queues": { "notifications": "ok", "reportGeneration": "ok" }
}
Response 503: { "status": "degraded" | "down", ... }
```

Used by Nginx upstream health checks and load balancer probes.

---

## 10. Deployment Architecture

### 10.1 Docker Compose (Local Development)

```yaml
version: '3.9'
services:
  api:
    build: .
    ports: ["3000:3000"]
    environment:
      DATABASE_URL: postgres://bms:bms@pgbouncer:5432/bms
      DATABASE_REPLICA_URL: postgres://bms:bms@postgres-replica:5432/bms
      REDIS_URL: redis://redis:6379
      COLUMN_ENCRYPTION_KEY: ${COLUMN_ENCRYPTION_KEY}
      AUDIT_SIGNING_KEY: ${AUDIT_SIGNING_KEY}
      JWT_SECRET: ${JWT_SECRET}
    depends_on: [pgbouncer, redis]

  worker:
    build: .
    command: node dist/workers/index.js
    environment: *api-env
    depends_on: [pgbouncer, redis]

  postgres:
    image: postgres:16
    environment: { POSTGRES_DB: bms, POSTGRES_USER: bms, POSTGRES_PASSWORD: bms }
    volumes: [pgdata:/var/lib/postgresql/data]

  postgres-replica:
    image: postgres:16
    environment: { POSTGRES_DB: bms, POSTGRES_USER: bms, POSTGRES_PASSWORD: bms }
    # Streaming replication configured via pg_basebackup

  pgbouncer:
    image: pgbouncer/pgbouncer
    environment:
      DATABASES_HOST: postgres
      POOL_MODE: transaction
      MAX_CLIENT_CONN: 200
      DEFAULT_POOL_SIZE: 20

  redis:
    image: redis:7-alpine
    command: redis-server --appendonly yes

  nginx:
    image: nginx:alpine
    ports: ["443:443", "80:80"]
    volumes: [./nginx.conf:/etc/nginx/nginx.conf, ./certs:/etc/nginx/certs]

  prometheus:
    image: prom/prometheus
    volumes: [./prometheus.yml:/etc/prometheus/prometheus.yml]

  grafana:
    image: grafana/grafana
    ports: ["3001:3000"]

volumes:
  pgdata:
```

### 10.2 Production Architecture

```mermaid
graph TB
    subgraph Internet
        CLT[Clients / Browsers]
    end

    subgraph DMZ["DMZ"]
        NG[Nginx\nTLS termination\nRate limiting\nUpstream LB]
    end

    subgraph AppTier["App Tier (Docker, horizontally scaled)"]
        A1[API Server 1]
        A2[API Server 2]
        AN[API Server N]
        W1[Worker Service 1]
        W2[Worker Service 2]
    end

    subgraph DataTier["Data Tier"]
        PGB[PgBouncer\ntransaction mode]
        PGP[(PostgreSQL Primary\nwrites)]
        PGR[(PostgreSQL Replica\nreads)]
        RD[(Redis 7\nSentinel HA)]
    end

    CLT -->|HTTPS| NG
    NG --> A1
    NG --> A2
    NG --> AN
    A1 --> PGB --> PGP
    A2 --> PGB --> PGP
    AN --> PGB --> PGP
    A1 -.->|reads| PGR
    A2 -.->|reads| PGR
    A1 --> RD
    A2 --> RD
    W1 --> PGB --> PGP
    W1 --> RD
    W2 --> PGR
    PGP -->|streaming replication| PGR
```

**Statelessness:** API servers hold zero in-process state. All sessions, caches, and queues live in Redis. Adding a new API replica requires only updating the Nginx upstream block.

**PgBouncer:** Transaction-mode pooling. 200 client connections → 20 PostgreSQL connections. Prevents connection exhaustion under 500 concurrent users.

**Redis Sentinel:** 1 primary + 2 replicas with automatic failover. BullMQ and session data survive primary failure within ~30s.

### 10.3 Nginx Configuration (Key Sections)

```nginx
upstream api_servers {
    least_conn;
    server api1:3000;
    server api2:3000;
    keepalive 32;
}

server {
    listen 443 ssl http2;
    ssl_certificate     /etc/nginx/certs/cert.pem;
    ssl_certificate_key /etc/nginx/certs/key.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    # Rate limiting (coarse — fine-grained in Redis middleware)
    limit_req_zone $binary_remote_addr zone=login:10m rate=10r/m;
    limit_req_zone $binary_remote_addr zone=api:10m rate=200r/m;

    location /api/auth/login {
        limit_req zone=login burst=5 nodelay;
        proxy_pass http://api_servers;
    }

    location /api/ {
        limit_req zone=api burst=50 nodelay;
        proxy_pass http://api_servers;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Request-ID $request_id;
    }

    location / {
        root /usr/share/nginx/html;  # React SPA static files
        try_files $uri /index.html;
    }
}
```

### 10.4 CI/CD Pipeline (Basic)

```
Push to main branch
  └─ GitHub Actions / GitLab CI
       ├─ 1. Install dependencies (npm ci)
       ├─ 2. Type check (tsc --noEmit)
       ├─ 3. Lint (eslint)
       ├─ 4. Unit + property tests (vitest --run)
       ├─ 5. Integration tests (vitest --run --config vitest.integration.ts)
       ├─ 6. Build Docker image (docker build)
       ├─ 7. Push to registry
       └─ 8. Deploy (docker compose pull && docker compose up -d --no-deps api worker)
              └─ Run migrations (node-pg-migrate up) before starting new containers
```

---

## 11. Failure Handling

### 11.1 Retry Strategy

| Failure Type | Strategy | Max Retries | Backoff |
|-------------|----------|-------------|---------|
| DB connection failure | Automatic retry in pg Pool | 3 | Exponential (100ms, 200ms, 400ms) |
| Inventory VERSION_CONFLICT | Client-side retry (re-read version) | 3 | Immediate re-read |
| Notification delivery failure | Worker retry | 3 | Exponential (1s, 2s, 4s) |
| Audit log write failure | Worker retry | 5 | Exponential |
| Report job failure | No retry (notify staff) | 0 | — |
| Bank import failure | No retry (rollback + error) | 0 | — |

### 11.2 Circuit Breaker (External Integrations)

```typescript
// Notification Worker — circuit breaker for Email/SMS provider
const breaker = new CircuitBreaker(sendNotification, {
  timeout: 5000,        // 5s per call
  errorThresholdPercentage: 50,
  resetTimeout: 30000,  // try again after 30s
});

breaker.fallback(() => {
  // Log failure; move job to dead-letter queue
  // Core operation already completed — this is best-effort
});
```

Circuit breaker states: `CLOSED` (normal) → `OPEN` (failing, reject fast) → `HALF_OPEN` (probe) → `CLOSED`.

### 11.3 Dead-Letter Queue

Failed jobs (after max retries) are moved to the `dead-letter` BullMQ queue. Admin UI shows:
- Job type, payload, failure reason, timestamp
- Actions: Retry manually | Dismiss

Outbox entries that fail to publish after 5 attempts are marked `status='failed'` and surfaced in the Admin dead-letter view.

### 11.4 Payment Pending Confirmation

If a bank transfer confirmation is not received within 30 seconds:
1. Payment record is inserted with `status = 'pending_confirmation'`
2. Transaction is NOT marked `completed`
3. Cashier is notified via in-app alert
4. Cashier can manually confirm or void the transaction

---

## 12. Trade-offs & Decisions

### 12.1 Why PostgreSQL

- ACID transactions are non-negotiable for financial data (payments, inventory, audit)
- `PARTITION BY RANGE` handles the 50k audit entries/day growth without schema changes
- `tsvector` / `GIN` index provides full-text book search without a separate search service
- `SELECT FOR UPDATE SKIP LOCKED` enables safe concurrent outbox polling
- Single database simplifies operations for a single-tenant system
- No ORM — raw `pg` driver gives full control over query plans and locking hints

### 12.2 Why Modular Monolith over Microservices

- POS completion requires atomic writes across inventory, payments, loyalty, and audit — trivial in a monolith, expensive across services (distributed transactions / sagas)
- 500 concurrent users does not justify Kubernetes, service mesh, or distributed tracing across network hops
- The outbox + BullMQ pattern already provides the decoupling benefit of microservices without the operational cost
- Module boundaries are enforced by code convention (no cross-module SQL); extracting a module to a service later requires only pointing its queue consumer at a new process

### 12.3 Why BullMQ over Kafka

- BullMQ runs on the same Redis instance already required for sessions and caching — zero additional infrastructure
- Job-level retry, dead-letter, and delay are built-in
- Kafka is appropriate when event replay and consumer groups at scale are needed — not required for this system's throughput (1k tx/hour)
- Migration to Kafka is possible later by replacing the BullMQ producer/consumer with Kafka client — the outbox pattern is transport-agnostic

### 12.4 Horizontal Scaling Approach

- API servers are stateless (no in-process state); scale by adding Docker replicas behind Nginx `least_conn`
- Worker services scale independently — add replicas; `SKIP LOCKED` prevents duplicate job processing
- PgBouncer absorbs connection pressure; primary DB scales vertically first, then read replica offloads analytical queries
- Redis Sentinel provides HA; Redis Cluster is the next step if queue throughput becomes a bottleneck

### 12.5 Vertical Slice Delivery Order

Slices are ordered by entity dependency — each slice is independently deployable and delivers end-to-end value.

| Slice | Capability | Key Dependencies |
|-------|-----------|-----------------|
| 1 | Configuration & System Settings | — |
| 2 | Staff & Access Control | 1 |
| 3 | Branch Management | 2 |
| 4 | Bank Account Management | 3 |
| 5 | Location Management | 3 |
| 6 | Catalog Management | 2 |
| 7 | Inventory Management | 5, 6 |
| 8 | Supplier Management | 2 |
| 9 | Procurement & Purchase Orders | 7, 8 |
| 10 | Customer Management | 1 |
| 11 | Point of Sale — Transactions | 4, 7, 10 |
| 12 | Returns & Refunds | 11 |
| 13 | Order Management | 7, 10 |
| 14 | Payment Management | 4, 13 |
| 15 | Merchant Exchange | 6, 7 |
| 16 | Reporting & Analytics | 11–15 |
| 17 | UI & Data Presentation (shared DataTable, Dashboard, Charts) | All |

---

## 13. Correctness Properties

Each property maps to one property-based test using `fast-check` + Vitest (minimum 100 iterations).

Tag format: `// Feature: bookstore-management-system, Property N: <text>`

| # | Property | Validates |
|---|----------|-----------|
| 1 | Branch config override falls back to system default when absent | Req 1.5 |
| 2 | Config write produces exactly one outbox entry in same transaction | Req 1.6 |
| 3 | Non-Admin config write is rejected; config unchanged | Req 1.7 |
| 4 | Staff username uniqueness — second creation with same username rejected | Req 2.3 |
| 5 | RBAC — action outside role permissions rejected; no data modified | Req 2.5 |
| 6 | Deactivated account — all subsequent requests with prior tokens rejected | Req 2.6 |
| 7 | Reactivation restores identical branch-role assignments | Req 2.8 |
| 8 | Deactivated branch rejects new Transaction and Order creation | Req 3.4 |
| 9 | Branch deletion blocked when dependencies exist; error lists each type | Req 3.5 |
| 10 | Bank transfer payment references active Branch bank account; inactive/foreign rejected | Req 4.2 |
| 11 | Unmatched CSV import entries flagged as unmatched | Req 4.7 |
| 12 | Location name unique within branch; duplicate rejected | Req 5.1 |
| 13 | Location deletion blocked when inventory > 0 or open orders exist | Req 5.5 |
| 14 | Duplicate ISBN rejected; only one book with that ISBN exists | Req 6.6 |
| 15 | Book edit history entry created for each changed field | Req 6.7 |
| 16 | Inactive book rejected from new Transaction, Order, PO | Req 6.8 |
| 17 | Inventory initialized to 0 on first association | Req 7.1 |
| 18 | Stock transfer atomic: source decrements, destination increments, total conserved | Req 7.4 |
| 19 | Transfer rejected when source quantity < requested; no quantity changes | Req 7.5 |
| 20 | Low-stock alert enqueued when quantity falls to or below reorder_point | Req 7.7 |
| 21 | Inventory history: qty_after = qty_before + delta for every change | Req 7.8 |
| 22 | PO status transitions follow allowed paths only | Req 9.8 |
| 23 | PO receipt increments inventory by exactly received quantity | Req 9.4 |
| 24 | Over-receipt requires confirmation; inventory not updated until confirmed | Req 9.6 |
| 25 | Duplicate customer email or phone rejected | Req 10.2 |
| 26 | Store credit balance never goes below 0 | Req 10.5 |
| 27 | Loyalty accrual = floor(total × rate); history entry created | Req 10.6 |
| 28 | Loyalty redemption bounded by available balance | Req 10.7 |
| 29 | Effective price = branch price if exists, else catalog default | Req 11.2 |
| 30 | Effective tax rate = branch override if exists, else system default | Req 11.4 |
| 31 | Split payment sum equals transaction total exactly | Req 11.7 |
| 32 | Inventory decremented by exactly sold quantity on completion | Req 11.8 |
| 33 | Insufficient stock blocks completion without manager override | Req 11.9 |
| 34 | Completed transaction is immutable | Req 11.13 |
| 35 | Refund amount ≤ original payment amount per record | Req 12.6 |
| 36 | Out-of-window return requires manager auth; auth recorded in audit | Req 12.7 |
| 37 | Total returned quantity per line ≤ original purchased quantity | Req 12.8 |
| 38 | Order confirmation reserves stock; available (unreserved) stock reduced | Req 13.3 |
| 39 | Order status transitions follow allowed paths only | Req 13.6 |
| 40 | Order cancellation releases reserved inventory | Req 13.7 |
| 41 | Installment plan: deposit ≥ min_pct × total; sum(installments) = total − deposit | Req 14.3 |
| 42 | Payment rejected when it would exceed outstanding balance | Req 14.9 |
| 43 | Exchange adjustment = ABS(offered − requested); type set at creation | Req 15.4 |
| 44 | Exchange settlement atomically swaps inventory; no partial state | Req 15.5 |
| 45 | Settlement rejected when offered stock insufficient; no inventory change | Req 15.6 |
| 46 | Exchange order status transitions follow allowed paths only | Req 15.7 |
| 47 | List endpoint sort: asc = non-decreasing, desc = non-increasing | Req 17.1 |
| 48 | Pagination: items returned ≤ requested pageSize | Req 17.3 |
| 49 | Dashboard KPI values match underlying DB records | Req 17.8 |
| 50 | Idempotency: duplicate key within 24h returns original response; no duplicate records | Req 20.5, 23.5 |
| 51 | Optimistic lock: concurrent inventory updates — exactly one succeeds; other gets 409 | Req 23.1 |
| 52 | Outbox: every committed outbox entry eventually published; none stuck in pending | Req 26.5 |
| 53 | Rate limit: >10 failed logins per IP per 15 min → 429; resets after window | Req 21.7 |
| 54 | Audit tamper detection: modified entry signature mismatch detected and alerted | Req 21.12 |
| 55 | Line discount capped at role's max_line_discount_pct; exceeding returns 422 | Req 1.4 |
| 56 | Transaction discount capped at max_transaction_discount_pct; exceeding returns 422 | Req 1.5 |
| 57 | PO total > po_approval_threshold sets status=PendingApproval; ≤ threshold sets Pending | Req 1.10 |
| 58 | Installments count ≤ max_installments; exceeding returns 422 | Req 1.16 |
| 59 | Installment not marked overdue until grace_period_days after due_date | Req 1.17 |
| 60 | Loyalty points not accrued when transaction.total < loyalty_min_transaction_amount | Req 1.21 |
| 61 | Exchange cash adjustment rejected when exchange_cash_adjustment_allowed=false | Req 1.22 |
| 62 | Negative stock blocked when allow_negative_stock=false; allowed when true | Req 1.9 |
| 63 | Return value > max_return_value_without_auth requires manager auth regardless of window | Req 1.13 |
| 64 | Out-of-window refund method restricted to store_credit when refund_method_after_window=store_credit_only | Req 1.14 |
| 65 | SSE: in-app notification delivered to connected client within 5s of outbox publish | Req 27.2 |
| 66 | SSE: notification persisted in in_app_notifications even when no client connected | Req 27.5 |
