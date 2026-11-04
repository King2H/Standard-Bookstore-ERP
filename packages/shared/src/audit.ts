import { z } from 'zod';
import { IdSchema, ListPagingQuerySchema, PaginatedSchema } from './common.js';

/** Contracts for /api/v1/audit-logs (#21). */

/**
 * Every kind of record the API writes to the audit log. The API types each
 * write with it, so a new kind cannot be written without being listed, and the
 * Audit Log filters by it (#240, G2; was: a list in the page, 13 kinds behind).
 */
export const AUDIT_ENTITY_TYPES = [
  'author', 'bank_account', 'bank_statement', 'bank_statement_line', 'book', 'book_price', 'book_supplier', 'branch',
  'branch_config', 'branch_transfer', 'business_day', 'business_month', 'cash_session', 'category', 'customer',
  'customer_group', 'demo_data', 'exchange', 'inventory', 'inventory_cost', 'inventory_damaged', 'inventory_reorder',
  'inventory_stock_in', 'inventory_stock_out', 'location', 'order', 'payment', 'payment_refund', 'publisher',
  'purchase_order', 'receivable', 'receivable_payment', 'return', 'service', 'service_job', 'staff', 'staff_locations',
  'staff_roles', 'staff_session', 'stock_count', 'supplier', 'supplier_credit_note', 'supplier_payment',
  'supplier_refund', 'supplier_return', 'system_config', 'transaction',
] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

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
