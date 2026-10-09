import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import * as notifications from './notifications.controller.js';

// URL -> middleware -> controller (A2), mounted at /notifications. Request
// and response contracts are in @bms/shared (notification.ts) and listed in
// src/openapi/operations.ts.

const router = Router();
const { schemas } = notifications;

router.get('/stream', authenticate, notifications.stream);
router.get('/', authenticate, validate(schemas.list), notifications.list);
router.get('/unread-count', authenticate, notifications.unreadCount);
router.put('/read-all', authenticate, notifications.markAllRead);
router.put('/:id/read', authenticate, validate(schemas.byId), notifications.markRead);

export default router;
