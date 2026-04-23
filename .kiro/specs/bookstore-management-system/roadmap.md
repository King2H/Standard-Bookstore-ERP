# BMS Industry-Grade Improvement Roadmap
**Date:** April 2026
**Baseline:** Post-MVP V1 + Bug Fix Session V2 (~99% operational)
**Goal:** Transform from a functional ERP into a production-grade, observable, real-time bookstore management platform.

---

## Executive Summary

The BMS core is solid. All 17 slices are implemented, 28 of 27 tracked bugs are resolved, and the system can run a real bookstore today. What separates a "working system" from an "industry-grade ERP" is:

1. **Observability** — staff know what's happening without polling or refreshing
2. **Financial trustworthiness** — KPIs and reports are accurate and auditable
3. **Operational completeness** — every workflow has a clear start, middle, and end
4. **Security depth** — tamper-evident logs, rate limiting, token revocation
5. **Scalability foundations** — async processing, caching, connection pooling

---

## Improvement Categories

### Category A — Real-Time Notifications (SSE)
**Priority: CRITICAL — ✅ COMPLETE (Phase 5)**

The outbox table and workers exist. The missing piece is surfacing events to staff in real-time. Every lifecycle event in the ERP should generate a notification to the relevant role(s).

See: `.kiro/specs/bookstore-management-system/notification-spec.md` for full event catalog.

**Implemented:**
- `notifications` table (migration 1700000030) with branch/role targeting, severity, read state
- `lib/sseManager.ts` — SSE connection registry with broadcast and direct push
- `workers/notificationWorker.ts` — 40+ event type catalog; resilient (never throws)
- `workers/outboxPoller.ts` — routes all notification event types to the worker
- `GET /api/notifications/stream` — SSE endpoint with heartbeat and initial unread count
- REST endpoints: list, unread-count, mark-read, mark-all-read
- `NotificationBell` component in Layout header with real-time badge and dropdown
- All 9 service modules wired with `insertOutbox()` calls
- 12 integration tests passing
- **Bug fixes applied:** `fetchList()` called on mount (not just on SSE connected event); stale closure chain in reconnect logic eliminated; Admin/Super_Admin now see notifications across all branches via `OR $2 IN ('Admin', 'Super_Admin')` in all 5 query endpoints

**Impact:** Transforms the system from "pull" (staff must check) to "push" (system tells staff what needs attention).

---

### Category B — Dashboard & KPI Accuracy

**B-1: KPI Query Audit**
- Current `dailyRevenue` may double-count POS + Order revenue
- `pendingOrders` doesn't distinguish "needs confirmation" vs "waiting payment"
- No "Today's Credit Sales" (outstanding balances created today)
- No "Overdue Installments" count
- No "POs Awaiting Approval" count

**B-2: New KPI Cards**
Add to the Live Overview section:
- POs Awaiting Approval (Purchasor/Manager)
- Overdue Installments (Finance_Officer)
- Today's Returns Count
- Today's Credit Sales Amount

**B-3: Procurement Report**
`GET /api/reports/procurement` — total PO spend, POs by status, top suppliers by spend, receiving history by period.

**B-4: Returns Report**
`GET /api/reports/returns` — return rate by book/category, refund totals by method, returns by reason code, average return value.

**B-5: Customer Transaction History**
Add a "Transactions" tab to the Customer profile showing all POS transactions and Orders for that customer, with amounts and dates.

---

### Category C — Financial Completeness

**C-1: Overdue Installments List**
A dedicated view for Finance_Officer showing all overdue installments with customer name, order number, amount due, and days overdue. The `installment_checker` worker already marks them — just needs a UI.

**C-2: PO Approval Notification**
When a PO exceeds the approval threshold and enters `PendingApproval`, the Manager/Admin must be notified immediately (via SSE notification). Currently they must manually check the PO list.

**C-3: Return Approval Queue**
When a Sales-initiated return exceeds the auto-approval limit, it enters a pending state. Manager needs a visible queue of returns awaiting approval, not just a status badge.

**C-4: Bank Reconciliation Running Balance**
The reconciliation panel shows individual entries but no running balance. Add a "Reconciled Balance" summary showing total cleared IN vs. total cleared OUT.

---

### Category D — Security Hardening

**D-1: HMAC Audit Log Signing**
The `audit_logs` table has a `hmac_signature` column that is never populated. Without it, audit logs can be silently modified. Implement: on every INSERT to `audit_logs`, compute `HMAC-SHA256(JSON.stringify(row), AUDIT_HMAC_KEY)` and store it. Add a verification endpoint for Super_Admin.

**D-2: Redis Token Revocation Cache**
Staff deactivation currently checks `staff.is_active` on every API request (DB hit). With Redis: cache `staff:{id}:active = true` with 60s TTL. On deactivation, `DEL staff:{id}:active`. Eliminates per-request DB query.

**D-3: API Rate Limiting (Beyond Login)**
Currently only login is rate-limited. Add per-staff rate limiting to:
- `POST /api/payments` — max 30/min per staff
- `POST /api/pos/transactions` — max 60/min per staff
- `POST /api/orders` — max 30/min per staff
- `POST /api/returns` — max 20/min per staff

**D-4: Session Invalidation on Role Change**
When a staff member's roles are updated via `PUT /api/staff/:id/roles`, their current access token should be invalidated (revoke refresh tokens). Currently role changes only take effect on next login.

---

### Category E — Operational Completeness

**E-1: Cross-Branch Stock Transfer Request**
Current transfer is within-branch only. Add a transfer request workflow:
1. Stock_Clerk at Branch A creates a transfer request to Branch B
2. Manager at Branch B approves/rejects
3. On approval: stock-out at Branch A, stock-in at Branch B
4. Both branches notified via SSE

**E-2: Supplier Performance Tracking**
Track per-supplier: on-time delivery rate, average lead time, return rate. Surface in Suppliers page as a "Performance" tab.

**E-3: Book Reorder Automation**
When stock drops below reorder point, automatically create a draft PO for the primary supplier. Staff reviews and submits. Currently only an alert is shown.

**E-4: Customer Merge**
When duplicate customers are created (same phone/email), provide a merge tool that consolidates loyalty points, store credit, and transaction history.

---

### Category F — Infrastructure & Performance

**F-1: PostgreSQL Connection Pooling (PgBouncer)**
Direct `pg.Pool` connections work but don't scale under load. Add PgBouncer as a sidecar in Docker Compose for connection pooling.

**F-2: Audit Log Partitioning**
The `audit_logs` table will grow unbounded. Add monthly range partitioning (already in the design spec, never implemented). Partition by `created_at` month.

**F-3: Read Replica for Reports**
All report queries hit the primary DB. Add a read replica in Docker Compose. Route all `GET /api/reports/*` queries to the replica.

**F-4: Background Report Generation**
Large date-range reports (e.g., annual sales) can time out. Add async report generation: POST creates a job, GET polls for completion, result stored in S3/local file.

---

## Implementation Priority Matrix

| # | Feature | Category | Effort | Impact | Priority |
|---|---------|----------|--------|--------|----------|
| 1 | SSE Notifications (full lifecycle) | A | 3 days | Critical | P0 |
| 2 | Dashboard KPI audit + new KPIs | B-1, B-2 | 1 day | High | P1 |
| 3 | Customer transaction history | B-5 | 1 day | High | P1 |
| 4 | Procurement + Returns reports | B-3, B-4 | 1 day | High | P1 |
| 5 | Overdue installments list | C-1 | 0.5 day | Medium | P2 |
| 6 | Return approval queue UI | C-3 | 0.5 day | Medium | P2 |
| 7 | Bank reconciliation running balance | C-4 | 0.5 day | Medium | P2 |
| 8 | HMAC audit log signing | D-1 | 0.5 day | Medium | P2 |
| 9 | Redis token revocation cache | D-2 | 0.5 day | Medium | P2 |
| 10 | API rate limiting (beyond login) | D-3 | 0.5 day | Medium | P2 |
| 11 | Session invalidation on role change | D-4 | 0.5 day | Medium | P2 |
| 12 | Cross-branch transfer request | E-1 | 3 days | Medium | P3 |
| 13 | Book reorder automation | E-3 | 1 day | Medium | P3 |
| 14 | Supplier performance tracking | E-2 | 1 day | Low-Med | P3 |
| 15 | Audit log partitioning | F-2 | 0.5 day | Low | P4 |
| 16 | PgBouncer connection pooling | F-1 | 0.5 day | Low | P4 |
| 17 | Read replica for reports | F-3 | 1 day | Low | P4 |
| 18 | Background report generation | F-4 | 2 days | Low | P4 |
| 19 | Customer merge tool | E-4 | 1 day | Low | P4 |

**Total estimated effort: ~20 days**

---

## Current System Gaps vs. Industry Standard

| Dimension | Current State | Industry Standard | Gap |
|-----------|--------------|-------------------|-----|
| Real-time awareness | Polling (30s KPI refresh) | SSE/WebSocket push | Large |
| Audit integrity | Unsigned logs | HMAC-signed, tamper-evident | Medium |
| Financial reporting | 5 report types | 7+ including procurement/returns | Medium |
| Notification system | None | Role-based, event-driven | Large |
| Connection pooling | Direct pg.Pool | PgBouncer | Small |
| Token revocation | DB check per request | Redis cache | Small |
| Cross-branch ops | Not supported | Transfer request workflow | Medium |
| Report performance | Synchronous | Async with job queue | Small |
| Reorder automation | Alert only | Draft PO creation | Medium |

---

*This document is the master roadmap for BMS Phase 2 improvements. Each item should be tracked as a spec task before implementation.*
