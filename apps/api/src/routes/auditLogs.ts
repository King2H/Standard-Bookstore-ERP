import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { db } from '../db/index.js';

const router = Router();

router.get(
  '/audit-logs',
  authenticate,
  requireRole('Super_Admin', 'Admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = Math.max(1, parseInt(req.query.page as string ?? '1', 10));
      const pageSize = Math.min(100, parseInt(req.query.pageSize as string ?? '25', 10));
      const entityType = req.query.entityType as string | undefined;
      const staffId = req.query.staffId ? parseInt(req.query.staffId as string, 10) : undefined;

      const conditions: string[] = [];
      const params: unknown[] = [];

      if (entityType) {
        params.push(entityType);
        conditions.push(`al.entity_type = $${params.length}`);
      }
      if (staffId) {
        params.push(staffId);
        conditions.push(`al.staff_id = $${params.length}`);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const offset = (page - 1) * pageSize;

      const [dataResult, countResult] = await Promise.all([
        db.query(
          `SELECT al.id, al.staff_id, s.username AS staff_username, al.staff_role,
                  al.action, al.entity_type, al.entity_id, al.branch_id,
                  b.name AS branch_name, al.meta, al.created_at
           FROM audit_logs al
           LEFT JOIN staff s ON s.id = al.staff_id
           LEFT JOIN branches b ON b.id = al.branch_id
           ${where}
           ORDER BY al.created_at DESC
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, pageSize, offset],
        ),
        db.query(`SELECT COUNT(*) FROM audit_logs al ${where}`, params),
      ]);

      res.json({
        items: dataResult.rows.map(r => ({
          id: r.id,
          staffId: r.staff_id,
          staffUsername: r.staff_username,
          staffRole: r.staff_role,
          action: r.action,
          entityType: r.entity_type,
          entityId: r.entity_id,
          branchId: r.branch_id,
          branchName: r.branch_name,
          meta: r.meta,
          createdAt: r.created_at,
        })),
        total: parseInt(countResult.rows[0].count as string, 10),
        page,
        pageSize,
        totalPages: Math.ceil(parseInt(countResult.rows[0].count as string, 10) / pageSize),
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
