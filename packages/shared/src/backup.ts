import { z } from 'zod';

/**
 * The install's backups (#244, owner decision 3a), for Admin and
 * Super_Admin: the last good backup, the last failure, and whether to warn
 * (no good backup for 26 hours). `enabled` is false where backups are not
 * set up (a development install, not the shop's bundle): nothing to warn of.
 */
export const BackupStatusSchema = z.object({
  enabled: z.boolean(),
  lastSuccessAt: z.string().nullable(),
  /** The backup file the last good run wrote. */
  lastFile: z.string().nullable(),
  /** A failure after the last good backup, if any. */
  lastFailureAt: z.string().nullable(),
  lastError: z.string().nullable(),
  stale: z.boolean(),
});
export type BackupStatus = z.infer<typeof BackupStatusSchema>;
