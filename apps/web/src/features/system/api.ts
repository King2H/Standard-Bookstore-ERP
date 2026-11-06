import type { BackupStatus } from '@bms/shared';
import { api } from '../../lib/api.js';

/** The install's backups (#244): Super_Admin and Admin only. */
export const getBackupStatus = () => api.get<BackupStatus>('/system/backup-status');
