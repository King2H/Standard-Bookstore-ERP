import { useMyProfile } from '../../account/queries.js';
import { useBackupStatus } from '../queries.js';

const LOOKS_AFTER = ['Super_Admin', 'Admin'];

/**
 * Across the app, for Admin and Super_Admin (#244, decision 3a): when the
 * install has had no good backup for 26 hours, with the last failure's
 * reason. Nothing where backups are not set up.
 */
export function BackupBanner() {
  const { data: me } = useMyProfile();
  const mine = (me?.currentRoles ?? []).some((r) => LOOKS_AFTER.includes(r));
  const { data } = useBackupStatus(mine);
  if (!mine || !data?.enabled || !data.stale) return null;
  return (
    <div role="alert" className="bg-red-50 dark:bg-red-950/40 border-b border-red-200 dark:border-red-900 px-4 py-2 text-sm text-red-800 dark:text-red-200 flex flex-wrap items-center gap-x-2">
      <span aria-hidden="true">💾</span>
      {data.lastSuccessAt === null
        ? <span>No backup has been made yet. Check that the backup folder is reachable (docs/install.md, Backups).</span>
        : <span>No backup for more than a day. Last good backup: {new Date(data.lastSuccessAt).toLocaleString()}.</span>}
      {data.lastError && <span>The last attempt failed: {data.lastError}</span>}
    </div>
  );
}
