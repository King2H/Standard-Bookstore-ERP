import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import * as system from './system.controller.js';

// URL -> middleware -> controller (A2). The install itself, not a branch's
// business: who looks after the shop's system, as for the shop's settings.

const router = Router();

router.get('/system/backup-status', authenticate, requireRole('Super_Admin', 'Admin'), system.backupStatus);

export default router;
