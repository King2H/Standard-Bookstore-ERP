/**
 * Notification routes — Phase 5 Real-Time Notification System
 *
 * GET  /api/notifications/stream      — SSE endpoint (keep-alive)
 * GET  /api/notifications             — paginated list for authenticated staff
 * GET  /api/notifications/unread-count — unread badge count
 * PUT  /api/notifications/:id/read    — mark single notification as read
 * PUT  /api/notifications/read-all    — mark all as read
 */
import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../../db/index.js';
import { authenticate } from '../../middleware/auth.js';
import { sseManager } from '../../lib/sseManager.js';

const router = Router();

const qs = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : Array.isArray(v) ? (v[0] as string | undefined) : undefined;
const qi = (v: unknown, fallback: number): number => {
  const s = qs(v);
  return s ? parseInt(s, 10) || fallback : fallback;
};

// ── SSE stream ────────────────────────────────────────────────────────────────

router.get('/stream', authenticate, (req: Request, res: Response) => {
  const staff = req.staff!;

  // Register connection — sseManager sets headers and handles disconnect cleanup
  sseManager.register(staff.staffId, staff.branchId, staff.role, res);

  // Send initial connected event with unread count
  db.query(
    `SELECT COUNT(*) FROM notifications
     WHERE is_read = false
       AND (
         target_staff_id = $1
         OR ($2 = ANY(target_roles) AND (branch_id IS NULL OR branch_id = $3))
       )`,
    [staff.staffId, staff.role, staff.branchId],
  )
    .then((result) => {
      const unreadCount = parseInt(result.rows[0].count as string, 10);
      res.write(`event: connected\ndata: ${JSON.stringify({ unreadCount })}\n\n`);
    })
    .catch(() => {
      res.write(`event: connected\ndata: ${JSON.stringify({ unreadCount: 0 })}\n\n`);
    });

  // Heartbeat every 30s to keep connection alive through proxies
  const heartbeat = setInterval(() => {
    try {
      res.write(`: ping\n\n`);
    } catch {
      clearInterval(heartbeat);
    }
  }, 30_000);

  res.on('close', () => {
    clearInterval(heartbeat);
  });
});

// ── List notifications ────────────────────────────────────────────────────────

router.get('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const staff = req.staff!;
    const page = Math.max(1, qi(req.query.page, 1));
    const pageSize = Math.min(100, qi(req.query.pageSize, 20));
    const offset = (page - 1) * pageSize;
    const isReadFilter = qs(req.query.isRead);
    const severityFilter = qs(req.query.severity);

    const conditions: string[] = [
      `(n.target_staff_id = $1 OR ($2 = ANY(n.target_roles) AND (n.branch_id IS NULL OR n.branch_id = $3)))`,
    ];
    const params: unknown[] = [staff.staffId, staff.role, staff.branchId];
    let p = 4;

    if (isReadFilter !== undefined) {
      conditions.push(`n.is_read = $${p++}::boolean`);
      params.push(isReadFilter === 'true' ? 'true' : 'false');
    }
    if (severityFilter) {
      conditions.push(`n.severity = $${p++}`);
      params.push(severityFilter);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    // Build separate param arrays: count query uses base params only,
    // data query appends pageSize + offset with their own placeholders.
    const dataParams = [...params, pageSize, offset];
    const limitPlaceholder = p;
    const offsetPlaceholder = p + 1;

    const [countRes, dataRes] = await Promise.all([
      db.query(`SELECT COUNT(*) FROM notifications n ${where}`, params),
      db.query(
        `SELECT n.id, n.branch_id, n.target_roles, n.target_staff_id,
                n.event_type, n.title, n.body, n.entity_type, n.entity_id,
                n.severity, n.is_read, n.read_at, n.created_at
         FROM notifications n
         ${where}
         ORDER BY n.created_at DESC
         LIMIT $${limitPlaceholder} OFFSET $${offsetPlaceholder}`,
        dataParams,
      ),
    ]);

    const total = parseInt(countRes.rows[0].count as string, 10);

    res.json({
      data: dataRes.rows.map(mapNotificationRow),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (err) {
    next(err);
  }
});

// ── Unread count ──────────────────────────────────────────────────────────────

router.get('/unread-count', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const staff = req.staff!;
    const result = await db.query(
      `SELECT COUNT(*) FROM notifications
       WHERE is_read = false
         AND (
           target_staff_id = $1
           OR ($2 = ANY(target_roles) AND (branch_id IS NULL OR branch_id = $3))
         )`,
      [staff.staffId, staff.role, staff.branchId],
    );
    res.json({ count: parseInt(result.rows[0].count as string, 10) });
  } catch (err) {
    next(err);
  }
});

// ── Mark single as read ───────────────────────────────────────────────────────

router.put('/:id/read', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const staff = req.staff!;
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'INVALID_ID', message: 'Notification ID must be a number' });
      return;
    }

    await db.query(
      `UPDATE notifications
       SET is_read = true, read_at = now()
       WHERE id = $1
         AND is_read = false
         AND (
           target_staff_id = $2
           OR ($3 = ANY(target_roles) AND (branch_id IS NULL OR branch_id = $4))
         )`,
      [id, staff.staffId, staff.role, staff.branchId],
    );

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ── Mark all as read ──────────────────────────────────────────────────────────

router.put('/read-all', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const staff = req.staff!;
    const result = await db.query(
      `UPDATE notifications
       SET is_read = true, read_at = now()
       WHERE is_read = false
         AND (
           target_staff_id = $1
           OR ($2 = ANY(target_roles) AND (branch_id IS NULL OR branch_id = $3))
         )`,
      [staff.staffId, staff.role, staff.branchId],
    );
    res.json({ updated: result.rowCount ?? 0 });
  } catch (err) {
    next(err);
  }
});

// ── Row mapper ────────────────────────────────────────────────────────────────

function mapNotificationRow(row: Record<string, unknown>) {
  return {
    id: row.id as number,
    branchId: (row.branch_id as number | null) ?? null,
    targetRoles: row.target_roles as string[],
    targetStaffId: (row.target_staff_id as number | null) ?? null,
    eventType: row.event_type as string,
    title: row.title as string,
    body: row.body as string,
    entityType: (row.entity_type as string | null) ?? null,
    entityId: (row.entity_id as string | null) ?? null,
    severity: row.severity as string,
    isRead: row.is_read as boolean,
    readAt: row.read_at ? (row.read_at as Date).toISOString() : null,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

export default router;
