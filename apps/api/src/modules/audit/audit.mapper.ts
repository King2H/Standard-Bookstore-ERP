import type { AuditLogEntry } from '@bms/shared';
import type { AuditLogRecord } from './audit.types.js';

export function toAuditLogResponse(record: AuditLogRecord): AuditLogEntry {
  return { ...record, createdAt: record.createdAt.toISOString() };
}
