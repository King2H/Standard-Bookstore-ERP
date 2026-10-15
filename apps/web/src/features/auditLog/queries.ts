import { useQuery } from '@tanstack/react-query';
import { listAuditLog, type AuditLogParams } from './api.js';

export const auditLogKeys = {
  all: ['audit-logs'] as const,
  list: (params: AuditLogParams) => [...auditLogKeys.all, params] as const,
};

/** New entries show up every 30 seconds while the page is in view (was: every 3 seconds, even in a background tab). */
export function useAuditLog(params: AuditLogParams) {
  return useQuery({
    queryKey: auditLogKeys.list(params),
    queryFn: () => listAuditLog(params),
    staleTime: 0,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
}
