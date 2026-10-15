import type { AuditLogListResponse } from '@bms/shared';
import { api, toQuery } from '../../lib/api.js';

/** The audit log (#21), typed with its @bms/shared contract. */

export interface AuditLogParams {
  page: number;
  pageSize: number;
  entityType?: string;
}

export const listAuditLog = (params: AuditLogParams) => api.get<AuditLogListResponse>(`/audit-logs${toQuery({ ...params })}`);
