import type { Request, Response } from 'express';
import type { BackupStatus } from '@bms/shared';
import * as backups from './backup.service.js';

/** The install's backups (#244). */
export async function backupStatus(_req: Request, res: Response): Promise<void> {
  const body: BackupStatus = await backups.backupStatus();
  res.json(body);
}
