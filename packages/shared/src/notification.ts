import { z } from 'zod';
import { IdSchema, MAX_PAGE_SIZE } from './common.js';

/** Contracts for /api/v1/notifications (#21). */

export const NotificationSchema = z.object({
  /** A bigint, sent as a string. */
  id: z.string(),
  /** Null for system-wide notifications. */
  branchId: z.number().int().nullable(),
  targetRoles: z.array(z.string()),
  targetStaffId: z.number().int().nullable(),
  eventType: z.string(),
  title: z.string(),
  body: z.string(),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  severity: z.string(),
  isRead: z.boolean(),
  readAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Notification = z.infer<typeof NotificationSchema>;

export const NotificationListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .default(20)
    .transform((n) => Math.min(n, MAX_PAGE_SIZE)),
  isRead: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  severity: z.string().min(1).optional(),
});
export type NotificationListQuery = z.infer<typeof NotificationListQuerySchema>;

/** The list keeps its `data` key, which the web app's notification bell reads. */
export const NotificationListResponseSchema = z.object({
  data: z.array(NotificationSchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  totalPages: z.number().int().min(0),
});
export type NotificationListResponse = z.infer<typeof NotificationListResponseSchema>;

export const UnreadCountResponseSchema = z.object({ count: z.number().int().min(0) });
export type UnreadCountResponse = z.infer<typeof UnreadCountResponseSchema>;

export const NotificationIdParamsSchema = z.object({ id: IdSchema });

export const MarkReadResponseSchema = z.object({ success: z.boolean() });
export type MarkReadResponse = z.infer<typeof MarkReadResponseSchema>;

export const MarkAllReadResponseSchema = z.object({ updated: z.number().int().min(0) });
export type MarkAllReadResponse = z.infer<typeof MarkAllReadResponseSchema>;

/**
 * Routine events (#232, owner decisions 1a, 2a): they notify only where the
 * shop or the branch turned them on, in the notification_prefs setting (event
 * to true). Every other event notifies: what someone must act on or should
 * know at once (approvals and reviews, transfers to receive, stock low or out,
 * bindings ready, special orders arrived, reopened periods, security).
 */
export const ROUTINE_NOTIFICATION_EVENTS = {
  'inventory.stock_in': 'Stock received',
  'inventory.stock_out': 'Stock removed',
  'inventory.adjustment': 'Stock adjusted',
  'inventory.transfer_completed': 'Stock moved between locations',
  'pos.sale_completed': 'Counter sale',
  'pos.credit_sale': 'Counter credit sale',
  'pos.transaction_voided': 'Counter sale voided',
  'pos.payment_collected': 'Counter sale payment collected',
  'order.created': 'Order created',
  'order.confirmed': 'Order confirmed',
  'order.in_progress': 'Order in progress',
  'order.fulfilled': 'Order delivered',
  'order.cancelled': 'Order cancelled',
  'payment.recorded': 'Payment recorded',
  'payment.refunded': 'Payment refunded',
  'payment.bank_transfer': 'Bank transfer received',
  'return.initiated': 'Return started',
  'return.approved': 'Return approved',
  'return.rejected': 'Return rejected',
  'return.completed': 'Return completed',
  'po.created': 'Purchase order created',
  'po.approved': 'Purchase order approved (by another approver)',
  'po.ordered': 'Purchase order sent',
  'po.partially_received': 'Purchase order part received',
  'po.fully_received': 'Purchase order received',
  'po.cancelled': 'Purchase order cancelled',
  'exchange.completed': 'Exchange completed',
  'exchange.cancelled': 'Exchange voided',
  'customer.store_credit_added': 'Store credit added',
  'customer.deactivated': 'Customer deactivated',
} as const satisfies Record<string, string>;
export type RoutineNotificationEvent = keyof typeof ROUTINE_NOTIFICATION_EVENTS;

const ROUTINE_EVENT_NAMES: readonly string[] = Object.keys(ROUTINE_NOTIFICATION_EVENTS);

/** notification_prefs: routine events turned on (true) or left off (false). */
export const NotificationPrefsSchema = z
  .record(z.string(), z.boolean({ error: 'must turn each event on (true) or off (false)' }), { error: 'must be an object of event and true or false' })
  .refine((o) => Object.keys(o).every((k) => ROUTINE_EVENT_NAMES.includes(k)), 'must name only routine events: ' + ROUTINE_EVENT_NAMES.join(', '));
export type NotificationPrefs = z.infer<typeof NotificationPrefsSchema>;

/**
 * Whether an event notifies, given the notification_prefs in effect. A
 * purchase order approved by its creator always does (owner decision,
 * 2026-10-23): Super_Admin is told.
 */
export function notifies(eventType: string, payload: { approvalKind?: unknown }, prefs: unknown): boolean {
  if (!ROUTINE_EVENT_NAMES.includes(eventType)) return true;
  if (eventType === 'po.approved' && (payload.approvalKind === 'creator' || payload.approvalKind === 'sole_approver')) return true;
  return typeof prefs === 'object' && prefs !== null && (prefs as Record<string, unknown>)[eventType] === true;
}
