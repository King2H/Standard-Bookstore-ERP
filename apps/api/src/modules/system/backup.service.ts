import type { BackupStatus } from '@bms/shared';
import { kysely } from '../../db/kysely.js';
import { isStale } from './backup.policy.js';
import * as repo from './backup.repository.js';

/**
 * The install's backups, for Admin and Super_Admin (#244, 3a). Off where the
 * bundle's backup service is not set up (BMS_BACKUPS=on comes with it).
 */
export async function backupStatus(): Promise<BackupStatus> {
  if (process.env.BMS_BACKUPS !== 'on') {
    return { enabled: false, lastSuccessAt: null, lastFile: null, lastFailureAt: null, lastError: null, stale: false };
  }
  const [{ success, failure }, now] = await Promise.all([repo.lastRuns(kysely), repo.now(kysely)]);
  // A failure is told only when it came after the last good backup.
  const failedSince = failure !== null && (success === null || failure.finishedAt > success.finishedAt) ? failure : null;
  return {
    enabled: true,
    lastSuccessAt: success?.finishedAt.toISOString() ?? null,
    lastFile: success?.fileName ?? null,
    lastFailureAt: failedSince?.finishedAt.toISOString() ?? null,
    lastError: failedSince?.error ?? null,
    stale: isStale(success?.finishedAt ?? null, now),
  };
}
