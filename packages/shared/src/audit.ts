import { z } from 'zod';
import { IdSchema, ListPagingQuerySchema, PaginatedSchema } from './common.js';

/** Contracts for /api/v1/audit-logs (#21). */

export const AuditLogEntrySchema = z.object({
  /** A bigint, sent as a string. */
  id: z.string(),
  staffId: z.number().int().nullable(),
  staffUsername: z.string().nullable(),
  staffRole: z.string().nullable(),
  /** CREATE, UPDATE, DELETE or a lifecycle action such as ARCHIVE. */
  action: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  /** Null for changes that belong to no branch, such as system settings. */
  branchId: z.number().int().nullable(),
  branchName: z.string().nullable(),
  meta: z.unknown(),
  createdAt: z.string(),
});
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;

export const AuditLogListQuerySchema = ListPagingQuerySchema.extend({
  entityType: z.string().min(1).optional(),
  staffId: IdSchema.optional(),
  /** Another branch than the session's needs access to all branches. */
  branchId: IdSchema.optional(),
});
export type AuditLogListQuery = z.infer<typeof AuditLogListQuerySchema>;

export const AuditLogListResponseSchema = PaginatedSchema(AuditLogEntrySchema);
export type AuditLogListResponse = z.infer<typeof AuditLogListResponseSchema>;
