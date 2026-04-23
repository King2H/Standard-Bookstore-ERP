/**
 * NotificationWorker — maps outbox events to notification rows.
 *
 * For each event type, defines:
 *   - title / body (interpolated from payload)
 *   - targetRoles (who should see it)
 *   - severity (info | success | warning | error)
 *   - entityType / entityId (for frontend navigation)
 *
 * After inserting the notification row, broadcasts via SSEManager
 * to all active connections matching branchId + role.
 *
 * IMPORTANT: This worker must NEVER throw — errors are logged and swallowed
 * so that a notification failure never blocks the outbox poller.
 */
import { db } from '../db/index.js';
import { sseManager, type NotificationPayload } from '../lib/sseManager.js';

interface NotificationSpec {
  title: string;
  body: string;
  targetRoles: string[];
  severity: 'info' | 'success' | 'warning' | 'error';
  entityType: string | null;
  entityId: string | null;
}

// ── Event catalog ─────────────────────────────────────────────────────────────
// Maps event_type → function(payload) → NotificationSpec

type PayloadMapper = (p: Record<string, unknown>) => NotificationSpec;

const EVENT_CATALOG: Record<string, PayloadMapper> = {
  // ── Inventory ──────────────────────────────────────────────────────────────
  'inventory.stock_in': (p) => ({
    title: '📦 Stock Received',
    body: `${p.quantity} units of "${p.bookTitle}" added to ${p.locationName}`,
    targetRoles: ['Manager', 'Stock_Clerk'],
    severity: 'info',
    entityType: 'inventory',
    entityId: String(p.bookId ?? ''),
  }),
  'inventory.stock_out': (p) => ({
    title: '📤 Stock Removed',
    body: `${p.quantity} units of "${p.bookTitle}" removed from ${p.locationName}${p.reasonCode ? ` (reason: ${p.reasonCode})` : ''}`,
    targetRoles: ['Manager', 'Stock_Clerk'],
    severity: 'info',
    entityType: 'inventory',
    entityId: String(p.bookId ?? ''),
  }),
  'inventory.adjustment': (p) => ({
    title: '✏️ Inventory Adjusted',
    body: `"${p.bookTitle}" at ${p.locationName} adjusted by ${p.delta}${p.reasonCode ? ` (reason: ${p.reasonCode})` : ''}`,
    targetRoles: ['Manager', 'Admin'],
    severity: 'info',
    entityType: 'inventory',
    entityId: String(p.bookId ?? ''),
  }),
  'inventory.transfer_completed': (p) => ({
    title: '↔️ Stock Transferred',
    body: `${p.quantity} units of "${p.bookTitle}" moved from ${p.fromLocationName} to ${p.toLocationName}`,
    targetRoles: ['Manager', 'Stock_Clerk'],
    severity: 'info',
    entityType: 'inventory',
    entityId: String(p.bookId ?? ''),
  }),
  'inventory.low_stock': (p) => ({
    title: '⚠️ Low Stock Alert',
    body: `"${p.bookTitle}" at ${p.locationName} — ${p.quantity} remaining (reorder at ${p.reorderPoint})`,
    targetRoles: ['Manager', 'Admin', 'Stock_Clerk'],
    severity: 'warning',
    entityType: 'inventory',
    entityId: String(p.bookId ?? ''),
  }),
  'inventory.out_of_stock': (p) => ({
    title: '🚨 Out of Stock',
    body: `"${p.bookTitle}" at ${p.locationName} is now out of stock`,
    targetRoles: ['Manager', 'Admin', 'Stock_Clerk'],
    severity: 'error',
    entityType: 'inventory',
    entityId: String(p.bookId ?? ''),
  }),

  // ── POS ────────────────────────────────────────────────────────────────────
  'pos.sale_completed': (p) => ({
    title: '✅ Sale Completed',
    body: `${p.txNumber} — ETB ${Number(p.amount).toFixed(2)} collected`,
    targetRoles: ['Manager'],
    severity: 'success',
    entityType: 'pos_transaction',
    entityId: String(p.txId ?? ''),
  }),
  'pos.credit_sale': (p) => ({
    title: '🟡 Credit Sale',
    body: `${p.txNumber} — ETB ${Number(p.amountDue).toFixed(2)} outstanding${p.customerName ? ` for ${p.customerName}` : ''}`,
    targetRoles: ['Manager', 'Finance_Officer'],
    severity: 'warning',
    entityType: 'pos_transaction',
    entityId: String(p.txId ?? ''),
  }),
  'pos.transaction_voided': (p) => ({
    title: '❌ Transaction Voided',
    body: `${p.txNumber} voided${p.staffName ? ` by ${p.staffName}` : ''}`,
    targetRoles: ['Manager', 'Admin'],
    severity: 'warning',
    entityType: 'pos_transaction',
    entityId: String(p.txId ?? ''),
  }),
  'pos.payment_collected': (p) => ({
    title: '💰 Payment Collected',
    body: `ETB ${Number(p.amount).toFixed(2)} collected on ${p.txNumber}`,
    targetRoles: ['Manager', 'Finance_Officer'],
    severity: 'success',
    entityType: 'pos_transaction',
    entityId: String(p.txId ?? ''),
  }),

  // ── Orders ─────────────────────────────────────────────────────────────────
  'order.created': (p) => ({
    title: '📋 New Order',
    body: `Order ${p.orderNumber} created — ETB ${Number(p.total).toFixed(2)}${p.channel ? ` (${p.channel})` : ''}`,
    targetRoles: ['Manager', 'Admin'],
    severity: 'info',
    entityType: 'order',
    entityId: String(p.orderId ?? ''),
  }),
  'order.confirmed': (p) => ({
    title: '✅ Order Confirmed',
    body: `${p.orderNumber} confirmed — stock reserved`,
    targetRoles: ['Manager', 'Sales'],
    severity: 'success',
    entityType: 'order',
    entityId: String(p.orderId ?? ''),
  }),
  'order.backordered': (p) => ({
    title: '⚠️ Order Backordered',
    body: `${p.orderNumber} has backordered items — insufficient stock`,
    targetRoles: ['Manager', 'Admin', 'Stock_Clerk'],
    severity: 'warning',
    entityType: 'order',
    entityId: String(p.orderId ?? ''),
  }),
  'order.in_progress': (p) => ({
    title: '🔄 Order In Progress',
    body: `${p.orderNumber} is being prepared`,
    targetRoles: ['Manager', 'Stock_Clerk'],
    severity: 'info',
    entityType: 'order',
    entityId: String(p.orderId ?? ''),
  }),
  'order.fulfilled': (p) => ({
    title: '📦 Order Fulfilled',
    body: `${p.orderNumber} fulfilled and ready for delivery`,
    targetRoles: ['Manager', 'Sales'],
    severity: 'success',
    entityType: 'order',
    entityId: String(p.orderId ?? ''),
  }),
  'order.cancelled': (p) => ({
    title: '❌ Order Cancelled',
    body: `${p.orderNumber} cancelled${p.reason ? ` — reason: ${p.reason}` : ''}`,
    targetRoles: ['Manager', 'Admin', 'Sales'],
    severity: 'warning',
    entityType: 'order',
    entityId: String(p.orderId ?? ''),
  }),

  // ── Payments ───────────────────────────────────────────────────────────────
  'payment.recorded': (p) => ({
    title: '💳 Payment Recorded',
    body: `ETB ${Number(p.amount).toFixed(2)}${p.method ? ` (${p.method})` : ''} for order ${p.orderNumber}`,
    targetRoles: ['Finance_Officer', 'Manager'],
    severity: 'success',
    entityType: 'payment',
    entityId: String(p.paymentId ?? ''),
  }),
  'payment.refunded': (p) => ({
    title: '🔄 Refund Processed',
    body: `ETB ${Number(p.amount).toFixed(2)} refunded for order ${p.orderNumber}`,
    targetRoles: ['Finance_Officer', 'Manager'],
    severity: 'info',
    entityType: 'payment',
    entityId: String(p.paymentId ?? ''),
  }),
  'payment.bank_transfer': (p) => ({
    title: '🏦 Bank Transfer',
    body: `ETB ${Number(p.amount).toFixed(2)} bank transfer for ${p.orderNumber} — pending reconciliation`,
    targetRoles: ['Finance_Officer'],
    severity: 'info',
    entityType: 'payment',
    entityId: String(p.paymentId ?? ''),
  }),
  'installment.payment_recorded': (p) => ({
    title: '✅ Installment Paid',
    body: `Installment ${p.installmentNum}/${p.totalInstallments} paid for order ${p.orderNumber}`,
    targetRoles: ['Finance_Officer'],
    severity: 'success',
    entityType: 'payment',
    entityId: String(p.orderId ?? ''),
  }),
  'installment.overdue': (p) => ({
    title: '⚠️ Installment Overdue',
    body: `Order ${p.orderNumber} — installment ${p.installmentNum} overdue by ${p.daysOverdue} days`,
    targetRoles: ['Finance_Officer', 'Manager'],
    severity: 'warning',
    entityType: 'payment',
    entityId: String(p.orderId ?? ''),
  }),
  'installment.plan_completed': (p) => ({
    title: '🎉 Plan Completed',
    body: `Installment plan for order ${p.orderNumber} fully paid`,
    targetRoles: ['Finance_Officer', 'Manager'],
    severity: 'success',
    entityType: 'payment',
    entityId: String(p.orderId ?? ''),
  }),

  // ── Returns ────────────────────────────────────────────────────────────────
  'return.initiated': (p) => ({
    title: '🔄 Return Initiated',
    body: `Return ${p.returnNumber} for ${p.txNumber} — ETB ${Number(p.amount).toFixed(2)}`,
    targetRoles: ['Manager', 'Admin'],
    severity: 'info',
    entityType: 'return',
    entityId: String(p.returnId ?? ''),
  }),
  'return.approval_required': (p) => ({
    title: '⚠️ Return Needs Approval',
    body: `Return ${p.returnNumber} — ETB ${Number(p.amount).toFixed(2)} exceeds limit, requires approval`,
    targetRoles: ['Manager', 'Admin'],
    severity: 'warning',
    entityType: 'return',
    entityId: String(p.returnId ?? ''),
  }),
  'return.approved': (p) => ({
    title: '✅ Return Approved',
    body: `Return ${p.returnNumber} approved${p.refundMethod ? ` — ${p.refundMethod} refund issued` : ''}`,
    targetRoles: ['Sales', 'Finance_Officer'],
    severity: 'success',
    entityType: 'return',
    entityId: String(p.returnId ?? ''),
  }),
  'return.rejected': (p) => ({
    title: '❌ Return Rejected',
    body: `Return ${p.returnNumber} rejected${p.reason ? ` — reason: ${p.reason}` : ''}`,
    targetRoles: ['Sales'],
    severity: 'warning',
    entityType: 'return',
    entityId: String(p.returnId ?? ''),
  }),
  'return.completed': (p) => ({
    title: '✅ Return Completed',
    body: `Return ${p.returnNumber} completed — inventory restored`,
    targetRoles: ['Manager', 'Stock_Clerk'],
    severity: 'success',
    entityType: 'return',
    entityId: String(p.returnId ?? ''),
  }),

  // ── Procurement ────────────────────────────────────────────────────────────
  'po.created': (p) => ({
    title: '📄 PO Created',
    body: `${p.poNumber} created for ${p.supplierName} — ETB ${Number(p.total).toFixed(2)}`,
    targetRoles: ['Manager', 'Purchasor'],
    severity: 'info',
    entityType: 'purchase_order',
    entityId: String(p.poId ?? ''),
  }),
  'po.approval_required': (p) => ({
    title: '⚠️ PO Needs Approval',
    body: `${p.poNumber} — ETB ${Number(p.total).toFixed(2)} exceeds threshold, requires approval`,
    targetRoles: ['Manager', 'Admin'],
    severity: 'warning',
    entityType: 'purchase_order',
    entityId: String(p.poId ?? ''),
  }),
  'po.approved': (p) => ({
    title: '✅ PO Approved',
    body: `${p.poNumber} approved — ready to order`,
    targetRoles: ['Purchasor'],
    severity: 'success',
    entityType: 'purchase_order',
    entityId: String(p.poId ?? ''),
  }),
  'po.ordered': (p) => ({
    title: '📤 PO Ordered',
    body: `${p.poNumber} sent to ${p.supplierName}`,
    targetRoles: ['Manager', 'Purchasor'],
    severity: 'info',
    entityType: 'purchase_order',
    entityId: String(p.poId ?? ''),
  }),
  'po.partially_received': (p) => ({
    title: '📦 Partial Receipt',
    body: `${p.poNumber} — ${p.qtyReceived}/${p.qtyOrdered} items received`,
    targetRoles: ['Manager', 'Stock_Clerk'],
    severity: 'info',
    entityType: 'purchase_order',
    entityId: String(p.poId ?? ''),
  }),
  'po.fully_received': (p) => ({
    title: '✅ PO Fully Received',
    body: `${p.poNumber} fully received — inventory updated`,
    targetRoles: ['Manager', 'Stock_Clerk', 'Purchasor'],
    severity: 'success',
    entityType: 'purchase_order',
    entityId: String(p.poId ?? ''),
  }),
  'po.cancelled': (p) => ({
    title: '❌ PO Cancelled',
    body: `${p.poNumber} cancelled`,
    targetRoles: ['Manager', 'Purchasor'],
    severity: 'warning',
    entityType: 'purchase_order',
    entityId: String(p.poId ?? ''),
  }),

  // ── Exchanges ──────────────────────────────────────────────────────────────
  'exchange.completed': (p) => ({
    title: '🔁 Exchange Completed',
    body: `${p.exchangeRef} — ${p.settlementType} (ETB ${Number(p.netBalance).toFixed(2)})`,
    targetRoles: ['Manager'],
    severity: 'success',
    entityType: 'exchange',
    entityId: String(p.exchangeId ?? ''),
  }),
  'exchange.cancelled': (p) => ({
    title: '❌ Exchange Cancelled',
    body: `${p.exchangeRef} cancelled`,
    targetRoles: ['Manager'],
    severity: 'info',
    entityType: 'exchange',
    entityId: String(p.exchangeId ?? ''),
  }),
  'exchange.store_refund_due': (p) => ({
    title: '💰 Store Refund Due',
    body: `${p.exchangeRef} — ETB ${Number(p.amount).toFixed(2)} store credit to issue to customer`,
    targetRoles: ['Sales', 'Manager'],
    severity: 'warning',
    entityType: 'exchange',
    entityId: String(p.exchangeId ?? ''),
  }),

  // ── Customers ──────────────────────────────────────────────────────────────
  'customer.store_credit_added': (p) => ({
    title: '💳 Store Credit Added',
    body: `ETB ${Number(p.amount).toFixed(2)} added to ${p.customerName}'s store credit`,
    targetRoles: ['Sales', 'Manager'],
    severity: 'info',
    entityType: 'customer',
    entityId: String(p.customerId ?? ''),
  }),
  'customer.deactivated': (p) => ({
    title: '⚠️ Customer Deactivated',
    body: `${p.customerName}${p.customerCode ? ` (${p.customerCode})` : ''} has been deactivated`,
    targetRoles: ['Manager', 'Admin'],
    severity: 'warning',
    entityType: 'customer',
    entityId: String(p.customerId ?? ''),
  }),

  // ── Auth / Security ────────────────────────────────────────────────────────
  'auth.failed_login_attempts': (p) => ({
    title: '🔒 Account Locked',
    body: `${p.username} locked after ${p.attemptCount} failed attempts`,
    targetRoles: ['Admin', 'Super_Admin'],
    severity: 'warning',
    entityType: null,
    entityId: null,
  }),
  'auth.staff_deactivated': (p) => ({
    title: '⚠️ Staff Deactivated',
    body: `${p.username} has been deactivated`,
    targetRoles: ['Admin', 'Super_Admin'],
    severity: 'warning',
    entityType: null,
    entityId: null,
  }),
  'auth.password_reset': (p) => ({
    title: '🔑 Password Reset',
    body: `${p.username}'s password was reset${p.adminName ? ` by ${p.adminName}` : ''}`,
    targetRoles: ['Admin', 'Super_Admin'],
    severity: 'info',
    entityType: null,
    entityId: null,
  }),
};

// ── Handler ───────────────────────────────────────────────────────────────────

export async function handleNotification(payload: Record<string, unknown>): Promise<void> {
  // The outbox poller injects _eventType into the payload before calling this handler
  const eventType = (payload._eventType as string | undefined) ?? '';
  const mapper = EVENT_CATALOG[eventType];
  if (!mapper) {
    // Unknown event type — skip silently (do not throw)
    return;
  }

  let spec: NotificationSpec;
  try {
    spec = mapper(payload);
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error',
      msg: 'NotificationWorker: failed to map event payload',
      eventType,
      error: (err as Error).message,
    }));
    return;
  }

  const branchId = (payload.branchId as number | null) ?? null;

  try {
    // INSERT notification row
    const result = await db.query(
      `INSERT INTO notifications
         (branch_id, target_roles, event_type, title, body, entity_type, entity_id, severity)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, created_at`,
      [
        branchId,
        spec.targetRoles,
        eventType,
        spec.title,
        spec.body,
        spec.entityType,
        spec.entityId,
        spec.severity,
      ],
    );

    const row = result.rows[0];
    const notification: NotificationPayload = {
      id: row.id as number,
      eventType,
      title: spec.title,
      body: spec.body,
      severity: spec.severity,
      entityType: spec.entityType,
      entityId: spec.entityId,
      isRead: false,
      createdAt: (row.created_at as Date).toISOString(),
    };

    // Broadcast to active SSE connections
    sseManager.broadcast(branchId, spec.targetRoles, notification);
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error',
      msg: 'NotificationWorker: failed to insert/broadcast notification',
      eventType,
      error: (err as Error).message,
    }));
    // Do NOT re-throw — notification failure must never block the poller
  }
}
