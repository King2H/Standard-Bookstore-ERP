# BMS Notification System — Full Specification
**Version:** 1.0
**Date:** April 2026
**Status:** Approved for Implementation

---

## Overview

The BMS Notification System delivers real-time, role-targeted alerts to staff for every significant lifecycle event across all ERP modules. It uses **Server-Sent Events (SSE)** — a lightweight, unidirectional HTTP streaming protocol that works over standard HTTP/1.1 without WebSocket infrastructure.

### Design Principles

1. **Every lifecycle event generates a notification** — no silent state changes
2. **Role-targeted delivery** — notifications go only to staff who need to act on them
3. **Branch-scoped** — staff only see notifications for their branch (except Admin/Super_Admin)
4. **Persistent** — notifications are stored in DB; staff can see history even after reconnect
5. **Non-blocking** — notification creation never blocks the originating transaction
6. **Idempotent** — duplicate events produce at most one notification

---

## Architecture

```
Business Event (POS, Order, Inventory, etc.)
    │
    ▼
insertOutbox(client, eventType, payload)   ← inside DB transaction
    │
    ▼
outbox table (PostgreSQL)
    │
    ▼
OutboxPoller (1s interval, SELECT FOR UPDATE SKIP LOCKED)
    │
    ▼
NotificationWorker.handle(event)
    │
    ├── INSERT INTO notifications (staff_id, role_filter, branch_id, ...)
    │
    └── SSEManager.broadcast(branchId, roles, notification)
            │
            └── Active SSE connections → EventSource.onmessage
                    │
                    └── NotificationBell (React) → toast + badge count
```

### Key Components

| Component | Location | Responsibility |
|-----------|----------|----------------|
| `outbox` table | DB | Durable event queue |
| `notifications` table | DB | Persistent notification store |
| `OutboxPoller` | `workers/outboxPoller.ts` | Polls outbox, routes to handlers |
| `NotificationWorker` | `workers/notificationWorker.ts` | Creates notifications from events |
| `SSEManager` | `lib/sseManager.ts` | Manages active SSE connections |
| `GET /api/notifications/stream` | `routes/notifications.ts` | SSE endpoint |
| `GET /api/notifications` | `routes/notifications.ts` | List notifications (paginated) |
| `PUT /api/notifications/:id/read` | `routes/notifications.ts` | Mark as read |
| `PUT /api/notifications/read-all` | `routes/notifications.ts` | Mark all as read |
| `NotificationBell` | `components/NotificationBell.tsx` | UI bell + dropdown |

---

## Database Schema

### `notifications` table

```sql
CREATE TABLE notifications (
  id            BIGSERIAL PRIMARY KEY,
  branch_id     INTEGER REFERENCES branches(id),  -- NULL = system-wide
  target_roles  TEXT[] NOT NULL,                  -- e.g. ['Manager', 'Admin']
  target_staff_id INTEGER REFERENCES staff(id),   -- NULL = broadcast to roles
  event_type    TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  entity_type   TEXT,                             -- 'order', 'pos_transaction', etc.
  entity_id     TEXT,                             -- ID of the related entity
  severity      TEXT NOT NULL DEFAULT 'info',     -- 'info' | 'warning' | 'error' | 'success'
  is_read       BOOLEAN NOT NULL DEFAULT false,
  read_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_branch_roles ON notifications(branch_id, target_roles);
CREATE INDEX idx_notifications_staff ON notifications(target_staff_id) WHERE target_staff_id IS NOT NULL;
CREATE INDEX idx_notifications_unread ON notifications(branch_id, is_read) WHERE is_read = false;
```

---

## Full Event Catalog

### Inventory Events

| Event Type | Trigger | Title | Body | Target Roles | Severity |
|-----------|---------|-------|------|-------------|----------|
| `inventory.low_stock` | Stock drops to/below reorder point | ⚠️ Low Stock Alert | "{title}" at {location} — {qty} remaining (reorder at {reorder_point}) | Manager, Admin, Stock_Clerk | warning |
| `inventory.out_of_stock` | Stock reaches 0 | 🚨 Out of Stock | "{title}" at {location} is now out of stock | Manager, Admin, Stock_Clerk | error |
| `inventory.stock_in` | Stock-in recorded | 📦 Stock Received | {qty} units of "{title}" added to {location} | Manager, Stock_Clerk | info |
| `inventory.stock_out` | Manual stock-out recorded | 📤 Stock Removed | {qty} units of "{title}" removed from {location} (reason: {reason}) | Manager, Stock_Clerk | info |
| `inventory.transfer_completed` | Transfer between locations | ↔️ Stock Transferred | {qty} units of "{title}" moved from {from_location} to {to_location} | Manager, Stock_Clerk | info |
| `inventory.adjustment` | Manual adjustment | ✏️ Inventory Adjusted | "{title}" at {location} adjusted by {delta} (reason: {reason}) | Manager, Admin | info |

### POS Transaction Events

| Event Type | Trigger | Title | Body | Target Roles | Severity |
|-----------|---------|-------|------|-------------|----------|
| `pos.sale_completed` | Transaction completed (paid) | ✅ Sale Completed | {tx_number} — ETB {amount} collected | Manager | success |
| `pos.credit_sale` | Transaction with credit balance | 🟡 Credit Sale | {tx_number} — ETB {amount_due} outstanding for {customer_name} | Manager, Finance_Officer | warning |
| `pos.transaction_voided` | Transaction voided | ❌ Transaction Voided | {tx_number} voided by {staff_name} | Manager, Admin | warning |
| `pos.payment_collected` | Outstanding balance collected | 💰 Payment Collected | ETB {amount} collected on {tx_number} | Manager, Finance_Officer | success |
| `pos.high_value_sale` | Sale exceeds config threshold | 💎 High-Value Sale | {tx_number} — ETB {amount} (above threshold) | Manager, Admin | info |

### Order Events

| Event Type | Trigger | Title | Body | Target Roles | Severity |
|-----------|---------|-------|------|-------------|----------|
| `order.created` | New order created | 📋 New Order | Order {order_number} created — ETB {total} ({channel}) | Manager, Admin | info |
| `order.confirmed` | Order confirmed, stock reserved | ✅ Order Confirmed | {order_number} confirmed — stock reserved | Manager, Sales | success |
| `order.backordered` | Confirmation finds insufficient stock | ⚠️ Order Backordered | {order_number} has backordered items — insufficient stock | Manager, Admin, Stock_Clerk | warning |
| `order.in_progress` | Order moved to In_Progress | 🔄 Order In Progress | {order_number} is being prepared | Manager, Stock_Clerk | info |
| `order.fulfilled` | Order fulfilled, inventory decremented | 📦 Order Fulfilled | {order_number} fulfilled and ready for delivery | Manager, Sales | success |
| `order.cancelled` | Order cancelled | ❌ Order Cancelled | {order_number} cancelled — reason: {reason} | Manager, Admin, Sales | warning |
| `order.payment_received` | Payment recorded against order | 💳 Payment Received | ETB {amount} received for {order_number} | Manager, Finance_Officer | success |
| `order.overdue_payment` | Order unpaid after X days | 🔔 Overdue Payment | {order_number} — ETB {outstanding} unpaid for {days} days | Manager, Finance_Officer | warning |

### Payment Events

| Event Type | Trigger | Title | Body | Target Roles | Severity |
|-----------|---------|-------|------|-------------|----------|
| `payment.recorded` | Payment recorded | 💳 Payment Recorded | ETB {amount} ({method}) for order {order_number} | Finance_Officer, Manager | success |
| `payment.refunded` | Refund processed | 🔄 Refund Processed | ETB {amount} refunded for order {order_number} | Finance_Officer, Manager | info |
| `payment.bank_transfer` | Bank transfer payment | 🏦 Bank Transfer | ETB {amount} bank transfer for {order_number} — pending reconciliation | Finance_Officer | info |
| `installment.payment_recorded` | Installment paid | ✅ Installment Paid | Installment {n}/{total} paid for order {order_number} | Finance_Officer | success |
| `installment.overdue` | Installment past due date | ⚠️ Installment Overdue | Order {order_number} — installment {n} overdue by {days} days | Finance_Officer, Manager | warning |
| `installment.plan_completed` | All installments paid | 🎉 Plan Completed | Installment plan for order {order_number} fully paid | Finance_Officer, Manager | success |

### Returns & Refunds Events

| Event Type | Trigger | Title | Body | Target Roles | Severity |
|-----------|---------|-------|------|-------------|----------|
| `return.initiated` | Return created by Sales | 🔄 Return Initiated | Return {return_number} for {tx_number} — ETB {amount} | Manager, Admin | info |
| `return.approval_required` | Return exceeds auto-approval limit | ⚠️ Return Needs Approval | Return {return_number} — ETB {amount} exceeds limit, requires approval | Manager, Admin | warning |
| `return.approved` | Return approved | ✅ Return Approved | Return {return_number} approved — {refund_method} refund issued | Sales, Finance_Officer | success |
| `return.rejected` | Return rejected | ❌ Return Rejected | Return {return_number} rejected — reason: {reason} | Sales | warning |
| `return.completed` | Return fully processed | ✅ Return Completed | Return {return_number} completed — inventory restored | Manager, Stock_Clerk | success |

### Procurement Events

| Event Type | Trigger | Title | Body | Target Roles | Severity |
|-----------|---------|-------|------|-------------|----------|
| `po.created` | PO created | 📄 PO Created | {po_number} created for {supplier_name} — ETB {total} | Manager, Purchasor | info |
| `po.approval_required` | PO exceeds approval threshold | ⚠️ PO Needs Approval | {po_number} — ETB {total} exceeds threshold, requires approval | Manager, Admin | warning |
| `po.approved` | PO approved | ✅ PO Approved | {po_number} approved — ready to order | Purchasor | success |
| `po.ordered` | PO sent to supplier | 📤 PO Ordered | {po_number} sent to {supplier_name} | Manager, Purchasor | info |
| `po.partially_received` | Partial receipt recorded | 📦 Partial Receipt | {po_number} — {qty_received}/{qty_ordered} items received | Manager, Stock_Clerk | info |
| `po.fully_received` | All items received | ✅ PO Fully Received | {po_number} fully received — inventory updated | Manager, Stock_Clerk, Purchasor | success |
| `po.cancelled` | PO cancelled | ❌ PO Cancelled | {po_number} cancelled | Manager, Purchasor | warning |
| `po.overdue` | PO expected date passed | ⏰ PO Overdue | {po_number} from {supplier_name} is overdue by {days} days | Manager, Purchasor | warning |

### Exchange Events

| Event Type | Trigger | Title | Body | Target Roles | Severity |
|-----------|---------|-------|------|-------------|----------|
| `exchange.completed` | Exchange completed | 🔁 Exchange Completed | {exchange_ref} — {settlement_type} (ETB {net_balance}) | Manager | success |
| `exchange.cancelled` | Exchange cancelled | ❌ Exchange Cancelled | {exchange_ref} cancelled | Manager | info |
| `exchange.store_refund_due` | Exchange with Store_Refunds settlement | 💰 Store Refund Due | {exchange_ref} — ETB {amount} store credit to issue to customer | Sales, Manager | warning |

### Customer Events

| Event Type | Trigger | Title | Body | Target Roles | Severity |
|-----------|---------|-------|------|-------------|----------|
| `customer.store_credit_added` | Store credit issued | 💳 Store Credit Added | ETB {amount} added to {customer_name}'s store credit | Sales, Manager | info |
| `customer.loyalty_accrued` | Loyalty points earned | ⭐ Loyalty Points Earned | {customer_name} earned {points} points | Sales | info |
| `customer.loyalty_redeemed` | Loyalty points redeemed | 🎁 Loyalty Redeemed | {customer_name} redeemed {points} points | Sales | info |
| `customer.deactivated` | Customer deactivated | ⚠️ Customer Deactivated | {customer_name} ({code}) has been deactivated | Manager, Admin | warning |

### System / Security Events

| Event Type | Trigger | Title | Body | Target Roles | Severity |
|-----------|---------|-------|------|-------------|----------|
| `auth.failed_login_attempts` | Staff hits lockout threshold | 🔒 Account Locked | {username} locked after {n} failed attempts | Admin, Super_Admin | warning |
| `auth.staff_deactivated` | Staff account deactivated | ⚠️ Staff Deactivated | {username} has been deactivated | Admin, Super_Admin | warning |
| `auth.password_reset` | Admin resets staff password | 🔑 Password Reset | {username}'s password was reset by {admin_name} | Admin, Super_Admin | info |
| `system.low_disk` | (Future) Disk usage high | 💾 Low Disk Space | Server disk usage at {pct}% | Super_Admin | warning |

---

## Role-to-Notification Routing Matrix

| Role | Receives |
|------|---------|
| Super_Admin | System events, security events, all branch events (read-only) |
| Admin | All events for their branch + security events |
| Manager | Inventory alerts, order lifecycle, PO approvals, return approvals, payment events |
| Finance_Officer | Payment events, installment events, bank transfer events, reconciliation |
| Stock_Clerk | Inventory events (low stock, stock-in/out, transfer), PO receiving |
| Sales | Order created/fulfilled, return status, customer loyalty/credit events |
| Purchasor | PO lifecycle events (created, approved, ordered, received, overdue) |

---

## SSE Endpoint Specification

### `GET /api/notifications/stream`

**Auth:** Bearer token required
**Headers:** `Accept: text/event-stream`, `Cache-Control: no-cache`

**Behavior:**
1. Authenticate staff from JWT
2. Register connection in `SSEManager` keyed by `(staffId, branchId, role)`
3. Send `event: connected` with unread count immediately
4. Keep connection alive with `comment: ping` every 30s
5. On disconnect: deregister from `SSEManager`

**Event format:**
```
event: notification
data: {"id":123,"eventType":"order.created","title":"📋 New Order","body":"ORD-20260423-0001 created — ETB 450.00","severity":"info","entityType":"order","entityId":"42","createdAt":"2026-04-23T10:30:00Z"}

event: ping
data: {"ts":1714000000}
```

### `GET /api/notifications`

**Query params:** `page`, `pageSize`, `isRead` (true/false), `severity`
**Returns:** Paginated list of notifications for the authenticated staff member

### `PUT /api/notifications/:id/read`

Marks a single notification as read.

### `PUT /api/notifications/read-all`

Marks all unread notifications for the authenticated staff as read.

### `GET /api/notifications/unread-count`

Returns `{ count: number }` — used for the bell badge.

---

## Frontend Implementation

### `NotificationBell` Component

Location: `apps/web/src/components/NotificationBell.tsx`

**Features:**
- Bell icon in Layout header (right side, next to user menu)
- Red badge showing unread count (hidden when 0)
- Click opens dropdown showing last 10 notifications
- Each notification shows: icon (by severity), title, body, time ago
- "Mark all read" button
- "View all" link to a full notifications page
- Severity colors: info=blue, success=green, warning=amber, error=red

**SSE connection:**
```typescript
const eventSource = new EventSource('/api/notifications/stream', {
  headers: { Authorization: `Bearer ${token}` }
});
eventSource.addEventListener('notification', (e) => {
  const notif = JSON.parse(e.data);
  // Add to notification list
  // Show toast for high-severity events
  // Increment unread count
  // Invalidate relevant TanStack Query keys based on entityType
});
```

**TanStack Query invalidation on notification:**
When a notification arrives, invalidate the relevant query keys so the UI updates automatically:

| entityType | Invalidate |
|-----------|-----------|
| `order` | `['orders-list']`, `['order-detail', entityId]` |
| `pos_transaction` | `['pos-history']` |
| `inventory` | `['inventory']`, `['inventory-low-stock']` |
| `purchase_order` | `['purchase-orders']` |
| `return` | `['returns']` |
| `payment` | `['payments']`, `['orders-list']` |
| `exchange` | `['exchanges-list']` |
| `customer` | `['customers']` |

This means when a Manager receives "Order Confirmed" notification, the Orders list automatically refreshes — no manual reload needed.

---

## Outbox Event Emission Points

Every service that creates/updates a business entity must call `insertOutbox()` within its DB transaction. Here is the complete list of emission points:

### Already emitting (via existing outbox calls):
- POS loyalty accrual → `LoyaltyAccrualRequested`

### Must add:

**inventory.service.ts:**
- `stockIn()` → emit `inventory.stock_in`
- `stockOut()` → emit `inventory.stock_out`
- `adjustStock()` → emit `inventory.adjustment`
- `transferStock()` → emit `inventory.transfer_completed`
- After any stock change: check if `quantity <= reorder_point` → emit `inventory.low_stock` or `inventory.out_of_stock`

**pos.service.ts:**
- `createTransaction()` on success → emit `pos.sale_completed` or `pos.credit_sale`
- `voidTransaction()` → emit `pos.transaction_voided`
- `recordPayment()` → emit `pos.payment_collected`

**orders.service.ts:**
- `create()` → emit `order.created`
- `confirm()` → emit `order.confirmed` or `order.backordered`
- `progress()` → emit `order.in_progress`
- `fulfill()` → emit `order.fulfilled`
- `cancel()` → emit `order.cancelled`

**payments.service.ts:**
- `createPayment()` → emit `payment.recorded`
- `createRefund()` → emit `payment.refunded`
- Bank transfer payment → emit `payment.bank_transfer`

**returns.service.ts:**
- `createReturn()` → emit `return.initiated` or `return.approval_required`
- `approveReturn()` → emit `return.approved`
- `rejectReturn()` → emit `return.rejected`

**procurement.service.ts:**
- `createPO()` → emit `po.created` or `po.approval_required`
- `approvePO()` → emit `po.approved`
- `orderPO()` → emit `po.ordered`
- `receivePO()` → emit `po.partially_received` or `po.fully_received`
- `cancelPO()` → emit `po.cancelled`

**exchanges.service.ts:**
- `createExchange()` → emit `exchange.completed` + `exchange.store_refund_due` if applicable
- `cancelExchange()` → emit `exchange.cancelled`

**installments.service.ts:**
- `recordInstallmentPayment()` → emit `installment.payment_recorded`
- `installmentChecker` worker → emit `installment.overdue`

**auth.service.ts:**
- Account lockout → emit `auth.failed_login_attempts`
- `deactivateStaff()` → emit `auth.staff_deactivated`
- `adminResetPassword()` → emit `auth.password_reset`

**customer.service.ts:**
- Store credit adjust → emit `customer.store_credit_added`
- `deactivateCustomer()` → emit `customer.deactivated`

---

## Migration

```sql
-- Migration: 1700000030_create_notifications
CREATE TABLE notifications (
  id              BIGSERIAL PRIMARY KEY,
  branch_id       INTEGER REFERENCES branches(id) ON DELETE CASCADE,
  target_roles    TEXT[] NOT NULL DEFAULT '{}',
  target_staff_id INTEGER REFERENCES staff(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  entity_type     TEXT,
  entity_id       TEXT,
  severity        TEXT NOT NULL DEFAULT 'info'
                  CHECK (severity IN ('info','success','warning','error')),
  is_read         BOOLEAN NOT NULL DEFAULT false,
  read_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notif_branch_roles ON notifications USING GIN (target_roles)
  WHERE branch_id IS NOT NULL;
CREATE INDEX idx_notif_staff ON notifications(target_staff_id, is_read, created_at DESC)
  WHERE target_staff_id IS NOT NULL;
CREATE INDEX idx_notif_branch_unread ON notifications(branch_id, is_read, created_at DESC)
  WHERE is_read = false;
```

---

## Implementation Checklist

### Phase 1 — Infrastructure (Day 1)
- [ ] Migration `1700000030_create_notifications`
- [ ] `lib/sseManager.ts` — connection registry
- [ ] `workers/notificationWorker.ts` — event → notification mapper
- [ ] Register `notificationWorker` in `outboxPoller.ts`
- [ ] `routes/notifications.ts` — SSE + REST endpoints
- [ ] Register routes in `app.ts`

### Phase 2 — Emission Points (Day 2)
- [ ] Add `insertOutbox()` calls to all services listed above
- [ ] Test each event type end-to-end

### Phase 3 — Frontend (Day 3)
- [ ] `components/NotificationBell.tsx`
- [ ] Add to `Layout.tsx` header
- [ ] SSE connection management (reconnect on disconnect)
- [ ] TanStack Query invalidation on notification receipt
- [ ] Toast for warning/error severity notifications
- [ ] Full notifications page (optional)

---

## Non-Goals (Out of Scope for V1)

- Email/SMS notifications (future: add email worker)
- Push notifications (mobile app, future)
- Notification preferences per staff (future)
- Notification templates (hardcoded for now)
- Read receipts per-device (single device assumed)

---

*This spec is the authoritative reference for the BMS Notification System implementation.*
