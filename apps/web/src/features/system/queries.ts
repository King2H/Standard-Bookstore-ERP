import { useQuery } from '@tanstack/react-query';
import { getBackupStatus } from './api.js';

export const systemKeys = {
  backupStatus: ['system', 'backup-status'] as const,
};

/** Asked only by those who may read it; looked at again every 10 minutes. */
export function useBackupStatus(enabled: boolean) {
  return useQuery({ queryKey: systemKeys.backupStatus, queryFn: getBackupStatus, enabled, refetchInterval: 10 * 60_000, staleTime: 5 * 60_000 });
}
