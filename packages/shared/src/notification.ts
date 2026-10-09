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
