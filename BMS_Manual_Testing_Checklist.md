# BMS Manual Testing Checklist

**Version:** 1.0
**Date:** April 2026
**System:** Bookstore Management System (BMS) — PERN Stack ERP
**Test Environment:** `docker compose up` → http://localhost:5173

---

## Prerequisites

```bash
# Start the full stack
docker compose up -d

# Apply migrations
cd apps/api && npm run migrate

# Restore seed data (if needed)
cd apps/api && npm run reseed

# Start API and Web
npm run dev:api   # terminal 1
npm run dev:web   # terminal 2
```

**Seed credentials:**
| Username | Password | Role |
|----------|----------|------|
| superadmin | password | Super_Admin |
| admin | password | Admin |

Create Manager / Sales / Stock_Clerk / Finance_Officer / Purchasor via Staff page after logging in as admin.

---

## Module 1 — Authentication & Security

### 1.1 Login
- [ ] Login with `superadmin / password` → lands on Settings page (not Dashboard)
- [ ] Login with `admin / password` → lands on Dashboard
- [ ] Login with wrong password → shows error message, does NOT lock account on first attempt
- [ ] Login with wrong password 10 times **for the same username** from same IP → 429 Too Many Requests (rate limit)
- [ ] Login with a **different username** from the same IP → NOT rate limited (each username has its own counter)
- [ ] Login with inactive account → 403 error shown
- [ ] After login, `csrf-token` cookie is set in browser (check DevTools → Application → Cookies)
- [ ] Token auto-refreshes after 15 minutes without re-login

### 1.2 Profile & Password
- [ ] Navigate to My Profile → shows username, role, branch, last login date
- [ ] Change password with wrong current password → error shown
- [ ] Change password with valid current password → success, can login with new password
- [ ] Password complexity enforced (min 10 chars, upper + lower + digit + special)

### 1.3 RBAC
- [ ] superadmin sees: Settings, Staff, Branches, Audit Log only (no operational pages)
- [ ] admin sees all pages including Dashboard
- [ ] Sales role does NOT see: Suppliers, Procurement, Bank Accounts, Settings, Audit Log
- [ ] Finance_Officer sees: Bank Accounts, Payments, Returns (read), Reports

---

## Module 2 — Staff Management

- [ ] Create new staff member (Admin role) → appears in staff list
- [ ] Assign Manager role to staff at Branch 1
- [ ] Deactivate staff → cannot login, refresh token rejected
- [ ] Reactivate staff → can login again
- [ ] Reset password (Admin) → staff must change password on next login
- [ ] Unlock locked account (Admin) → staff can login again
- [ ] Manager cannot assign Super_Admin role to staff

---

## Module 3 — Branch & Location Management

- [ ] Create new branch with name, address, contact info, operating hours
- [ ] Duplicate branch name → 409 error shown
- [ ] Deactivate branch → cannot create transactions against it
- [ ] Delete branch with no dependencies → succeeds
- [ ] Delete branch with locations/staff → 409 DEPENDENCY_CONFLICT with list
- [ ] Create location within branch → appears in location list
- [ ] Set default fulfillment location → previous default cleared
- [ ] Delete location with inventory → 409 blocked
- [ ] Delete empty location → succeeds

---

## Module 4 — Configuration & Settings

- [ ] Login as superadmin → Settings → General tab → change tax_rate → save
- [ ] Login as admin → Settings → General tab → system config fields are READ-ONLY
- [ ] Admin can set branch-level override for return_window_days
- [ ] Branch override shows "branch" source label; system default shows "system default"
- [ ] Delete branch override → reverts to system default
- [ ] Security tab shows: max_failed_login_attempts, account_lockout_minutes, password_expiry_days

---

## Module 5 — Catalog Management

- [ ] Create book with valid ISBN-13 → appears in catalog
- [ ] Create book with invalid ISBN-13 → validation error
- [ ] Duplicate ISBN → 409 DUPLICATE_ISBN
- [ ] Edit book title → book_edit_history records the change
- [ ] Set branch price override → POS uses branch price, not default
- [ ] Deactivate book → cannot add to new POS transaction
- [ ] Full-text search by title → returns matching books
- [ ] Search by ISBN → exact match returned
- [ ] Filter by category → only books in that category shown

---

## Module 6 — Inventory Management

- [ ] Stock-in 10 units of a book at a location → quantity increases
- [ ] Stock-out 5 units → quantity decreases
- [ ] Manual adjustment with reason_code = 'damage' → recorded in history
- [ ] Transfer 3 units from Location A to Location B → both quantities updated atomically
- [ ] Transfer more than available → 422 INSUFFICIENT_STOCK
- [ ] Low-stock alert: set reorder_point to 20, stock-out to 15 → low-stock indicator visible
- [ ] Inventory history shows all movements with reason codes
- [ ] Stock-in with reference_type = 'purchase_order' → linked to PO

---

## Module 7 — Supplier Management

- [ ] Create external supplier → appears in supplier list
- [ ] Create publisher-type supplier without publisher_id → 422 error
- [ ] Blacklist supplier → cannot create PO against blacklisted supplier
- [ ] Link book to supplier → appears in book's supplier list
- [ ] Mark supplier as primary for a book → previous primary unset
- [ ] Delete supplier with POs → 409 DEPENDENCY_CONFLICT

---

## Module 8 — Procurement & Purchase Orders

- [ ] Create PO below approval threshold → status = Pending immediately
- [ ] Create PO above approval threshold → status = PendingApproval
- [ ] Manager approves PO → status = Pending
- [ ] Receive partial stock against PO → status = In_Progress, inventory incremented
- [ ] Receive remaining stock → status = Closed automatically
- [ ] Cancel PO in Pending status → status = Cancelled
- [ ] Cancel PO in In_Progress status → 409 INVALID_STATE_TRANSITION
- [ ] Purchasor cannot receive inventory (403 on receive endpoint)

---

## Module 9 — Customer Management

- [ ] Create customer with phone only (no email) → succeeds
- [ ] Create customer with neither phone nor email → validation error
- [ ] Duplicate phone number → 409 DUPLICATE_CONTACT
- [ ] Search customer by phone → found (tests PII lookup hash)
- [ ] Search customer by name → found
- [ ] Customer profile shows loyalty balance and store credit balance
- [ ] Deactivate customer → cannot use in new POS transaction

---

## Module 10 — Point of Sale (POS)

### 10.1 Normal Sale
- [ ] Select branch, location, add 2 books → subtotal, tax, grand total calculated correctly
- [ ] Pay with cash (exact amount) → transaction completed, inventory decremented
- [ ] Transaction number format: POS-YYYYMMDD-XXXX
- [ ] Receipt shows all line items, tax, total

### 10.2 Discount
- [ ] Apply 5% line discount (Sales role, within limit) → accepted
- [ ] Apply 15% line discount (Sales role, exceeds limit) → 422 DISCOUNT_EXCEEDS_LIMIT
- [ ] Apply 15% line discount (Manager role) → accepted

### 10.3 Customer Integration
- [ ] Attach customer to sale → loyalty points accrued (check after ~2 seconds via outbox worker)
- [ ] Redeem loyalty points as payment method → balance decremented
- [ ] Use store credit as payment method → balance decremented
- [ ] Credit sale (no payment) → paymentStatus = credit, amountDue > 0
- [ ] Collect outstanding balance on credit sale → paymentStatus = paid

### 10.4 Bank Payment
- [ ] Select bank payment method WITHOUT selecting bank account → 400 error
- [ ] Select bank payment method WITH bank account → succeeds
- [ ] After bank payment → bank_reconciliation entry created (check DB or Bank Accounts page)

### 10.5 Void
- [ ] Void a completed transaction → inventory restored, customer effects reversed
- [ ] Void an already-voided transaction → 422 ALREADY_VOIDED

---

## Module 11 — Returns & Refunds

- [ ] Find transaction by ID → line items shown
- [ ] Return 1 of 2 units → partial return, inventory restored by 1
- [ ] Return more than sold quantity → 422 OVER_RETURN
- [ ] Return within window (Sales role, small amount) → succeeds
- [ ] Return exceeding max_return_value_without_auth (Sales role) → 422 APPROVAL_REQUIRED
- [ ] Same return processed by Manager → succeeds (auto-approved)
- [ ] Store credit refund → customer store credit balance increases
- [ ] Return after window expired → only store_credit allowed (if config = store_credit_only)
- [ ] Double-return of same items → 422 OVER_RETURN on second attempt

---

## Module 12 — Order Management

- [ ] Create order (in_store channel) → status = Pending
- [ ] Confirm order → stock reserved, status = Confirmed
- [ ] Confirm order with insufficient stock → is_backordered = true on line item
- [ ] Progress order → status = In_Progress
- [ ] Fulfill order → inventory decremented, status = Fulfilled
- [ ] Cancel Pending order → reserved stock released
- [ ] Cancel Fulfilled order → 409 ORDER_ALREADY_FULFILLED
- [ ] Order number format: ORD-YYYYMMDD-XXXX

---

## Module 13 — Payment Management

### 13.1 Order Payments
- [ ] Record cash payment for order → payment_status updates to partial or paid
- [ ] Record bank payment with bank_account_id → reconciliation entry created
- [ ] Record payment exceeding order total → 422 EXCEEDS_ORDER_TOTAL
- [ ] GET /api/orders/:id/balance → shows orderTotal, totalPaid, outstanding
- [ ] Refund payment → payment_status updates; refund cannot exceed payment amount

### 13.2 Idempotency
- [ ] Send same payment request twice with same Idempotency-Key → second returns X-Idempotent-Replayed: true, no duplicate record
- [ ] Send same order creation twice with same Idempotency-Key → second returns X-Idempotent-Replayed: true

### 13.3 Installment Plans
- [ ] Create installment plan for order (3 installments) → plan created with monthly due dates
- [ ] Deposit below minimum (config: min_deposit_pct) → 422 DEPOSIT_TOO_LOW
- [ ] More installments than max_installments → 422 EXCEEDS_MAX_INSTALLMENTS
- [ ] Create duplicate plan for same order → 422 PLAN_EXISTS
- [ ] Record payment on installment → status updates (pending → partial → paid)
- [ ] Pay more than installment amount → 422 EXCEEDS_INSTALLMENT_AMOUNT
- [ ] View plan via Installments page → shows schedule with status badges

---

## Module 14 — Merchant Exchange

- [ ] Create exchange with incoming + outgoing items → status = Completed
- [ ] Exchange reference format: EXC-YYYYMMDD-XXXX
- [ ] Equal value exchange → settlementType = Even, netBalance ≈ 0
- [ ] Outgoing > incoming → settlementType = Customer_Pays, netBalance > 0
- [ ] Incoming > outgoing → settlementType = Store_Refunds, netBalance < 0
- [ ] Inventory updated: incoming items +qty, outgoing items -qty
- [ ] Insufficient stock for outgoing → 422 INSUFFICIENT_STOCK
- [ ] Cancel Initiated exchange → status = Cancelled
- [ ] Cancel Completed exchange → 422 ALREADY_COMPLETED

---

## Module 15 — Bank Account Management

- [ ] Create bank account → account number encrypted (only last 4 digits shown in UI)
- [ ] Deactivate bank account → cannot use in new payments
- [ ] Import CSV reconciliation → matched entries = uncleared, unmatched = unmatched
- [ ] Clear reconciliation entry → status = cleared
- [ ] Clear already-cleared entry → 409 error

---

## Module 16 — Reporting & Dashboard

### 16.1 Dashboard (Admin/Manager)
- [ ] Dashboard loads with 7 KPI cards (no errors)
- [ ] Sales trend chart shows data after creating some transactions
- [ ] Payment method pie chart shows distribution
- [ ] Filter by date range → charts update
- [ ] groupBy=month → period labels show month names
- [ ] Sales role → access denied message shown

### 16.2 Report Exports
- [ ] GET /api/reports/sales/export → downloads CSV file
- [ ] Open CSV in Excel → no encoding issues (BOM present)
- [ ] CSV contains correct headers and data rows
- [ ] Empty date range → CSV with headers only, no data rows

---

## Module 17 — Audit Log

- [ ] Every write action (create branch, create staff, POS transaction) → appears in audit log
- [ ] Audit log shows: staff_id, role, action, entity_type, entity_id, timestamp
- [ ] Filter by entity_type → only matching entries shown
- [ ] Sales role cannot access audit log (403)
- [ ] Audit log entries cannot be deleted or modified

---

## Non-Functional Checks

### Performance
- [ ] POS transaction completes in < 2 seconds (with Redis running)
- [ ] Loyalty accrual does NOT block POS response (async via outbox)
- [ ] Config reads served from Redis cache (< 5ms) after first request
- [ ] Report endpoints return in < 3 seconds for typical data volumes

### Security
- [ ] Login rate limit: 10 failed attempts from same IP → 429 with Retry-After header
- [ ] CSRF: POST request without X-CSRF-Token header (after login) → 403 CSRF_INVALID
- [ ] JWT expired → 401 TOKEN_EXPIRED
- [ ] Wrong role for endpoint → 403 FORBIDDEN
- [ ] Missing auth header → 401 UNAUTHORIZED
- [ ] Bank account numbers shown as ****XXXX in UI (last 4 only)
- [ ] Customer email/phone encrypted in DB (verify via direct DB query)

### Async Workers (requires Redis running)
- [ ] After POS transaction with customer → loyalty points appear in customer profile within ~2 seconds
- [ ] Outbox table: pending events → published after poller runs
- [ ] Installment checker: manually set an installment due_date to yesterday → status flips to overdue on next check cycle (or restart API)

### Data Integrity
- [ ] Concurrent POS transactions for same book → no negative inventory (optimistic locking)
- [ ] Order confirmation with insufficient stock → is_backordered = true, no inventory error
- [ ] Return refund amount never exceeds amount paid on original transaction
- [ ] Payment total never exceeds order total

### UI/UX
- [ ] Dark mode toggle works on all pages
- [ ] Sidebar collapses to icon-only mode
- [ ] All tables paginate correctly (prev/next buttons)
- [ ] Toast notifications appear for success and error actions
- [ ] Loading states shown while API calls are in progress
- [ ] Empty states shown when no data (e.g. no orders, no customers)
- [ ] Form validation errors shown inline (not just toast)

---

## Known Limitations (Not Bugs)

These are documented gaps — do not file as bugs:

| Item | Status | Notes |
|------|--------|-------|
| Loyalty accrual on POS void reversal | Synchronous | Still in pos.service.ts; outbox only for new accruals |
| Exchange lifecycle | Simplified | Single-step (Evaluated → Completed); no Merchant directory UI |
| Outbox workers | In-process | No BullMQ yet; workers run in same Node.js process |
| SSE notifications | Not implemented | No real-time push to browser |
| Report export PDF | Not implemented | CSV only |
| Audit log HMAC signing | Not implemented | Tamper detection deferred |
| PgBouncer | Not implemented | Direct pg.Pool only |
| Nginx | Not implemented | Direct Express only |

---

## Test Execution Log

| Date | Tester | Module | Pass | Fail | Notes |
|------|--------|--------|------|------|-------|
| | | | | | |

---

*Generated from BMS_MVP_Evaluation_1.md v1.1 — April 2026*
