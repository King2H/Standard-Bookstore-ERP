import { kysely } from '../../db/kysely.js';
import * as audit from './audit.repository.js';
import type { AuditLogFilter, AuditLogRecord } from './audit.types.js';

/** Use cases of the Audit module (A4). Entries are written by each module through audit.repository. */

export async function listAuditLogs(
  filter: AuditLogFilter,
  paging: { page: number; pageSize: number },
): Promise<{ items: AuditLogRecord[]; total: number; page: number; pageSize: number; totalPages: number }> {
  const { page, pageSize } = paging;
  const { items, total } = await audit.list(kysely, filter, { limit: pageSize, offset: (page - 1) * pageSize });
  return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
}
