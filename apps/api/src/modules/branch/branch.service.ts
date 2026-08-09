import { db } from '../../db/index.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';

export interface Branch {
  id: number;
  name: string;
  address: string;
  contactInfo: Record<string, string>;
  operatingHours: Record<string, string>;
  isActive: boolean;
  createdAt: string;
}

// ── Create ───────────────────────────────────────────────────────────────────

export async function createBranch(
  data: {
    name: string;
    address: string;
    contactInfo: Record<string, string>;
    operatingHours: Record<string, string>;
  },
  staffCtx: { staffId: number; role: string },
): Promise<Branch> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    let result;
    try {
      result = await client.query(
        `INSERT INTO branches (name, address, contact_info, operating_hours, is_active)
         VALUES ($1, $2, $3, $4, true)
         RETURNING id, name, address, contact_info, operating_hours, is_active, created_at`,
        [
          data.name,
          data.address,
          JSON.stringify(data.contactInfo),
          JSON.stringify(data.operatingHours),
        ],
      );
    } catch (err: unknown) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictError('DUPLICATE_BRANCH_NAME', `Branch name '${data.name}' already exists`);
      }
      throw err;
    }

    const branch = mapRow(result.rows[0]);

    // Write audit log
    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1, $2, 'CREATE', 'branch', $3, $4, $5)`,
      [
        staffCtx.staffId,
        staffCtx.role,
        String(branch.id),
        branch.id,
        JSON.stringify({ name: branch.name }),
      ],
    );

    await client.query('COMMIT');
    return branch;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Update ───────────────────────────────────────────────────────────────────

export async function updateBranch(
  id: number,
  data: Partial<{
    name: string;
    address: string;
    contactInfo: Record<string, string>;
    operatingHours: Record<string, string>;
  }>,
  staffCtx: { staffId: number; role: string },
): Promise<Branch> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT id FROM branches WHERE id = $1`,
      [id],
    );
    if (existing.rows.length === 0) throw new NotFoundError('Branch');

    const result = await client.query(
      `UPDATE branches
       SET name = COALESCE($1, name),
           address = COALESCE($2, address),
           contact_info = COALESCE($3, contact_info),
           operating_hours = COALESCE($4, operating_hours)
       WHERE id = $5
       RETURNING id, name, address, contact_info, operating_hours, is_active, created_at`,
      [
        data.name ?? null,
        data.address ?? null,
        data.contactInfo ? JSON.stringify(data.contactInfo) : null,
        data.operatingHours ? JSON.stringify(data.operatingHours) : null,
        id,
      ],
    );

    const branch = mapRow(result.rows[0]);

    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1, $2, 'UPDATE', 'branch', $3, $4, $5)`,
      [staffCtx.staffId, staffCtx.role, String(id), id, JSON.stringify(data)],
    );

    await client.query('COMMIT');
    return branch;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Deactivate ───────────────────────────────────────────────────────────────

export async function deactivateBranch(
  id: number,
  staffCtx: { staffId: number; role: string },
): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `UPDATE branches SET is_active = false WHERE id = $1 RETURNING id`,
      [id],
    );
    if (result.rows.length === 0) throw new NotFoundError('Branch');

    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1, $2, 'DEACTIVATE', 'branch', $3, $4, $5)`,
      [staffCtx.staffId, staffCtx.role, String(id), id, JSON.stringify({ id })],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Reactivate ───────────────────────────────────────────────────────────────

export async function reactivateBranch(
  id: number,
  staffCtx: { staffId: number; role: string },
): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `UPDATE branches SET is_active = true WHERE id = $1 RETURNING id`,
      [id],
    );
    if (result.rows.length === 0) throw new NotFoundError('Branch');

    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1, $2, 'REACTIVATE', 'branch', $3, $4, $5)`,
      [staffCtx.staffId, staffCtx.role, String(id), id, JSON.stringify({ id })],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Delete ───────────────────────────────────────────────────────────────────

export async function deleteBranch(
  id: number,
  staffCtx: { staffId: number; role: string },
): Promise<void> {
  // Check blocking dependencies before attempting delete
  const deps = await checkDependencies(id);
  if (deps.length > 0) {
    throw new ConflictError('DEPENDENCY_CONFLICT', 'Branch has blocking dependencies', {
      blockingDependencies: deps,
    });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `DELETE FROM branches WHERE id = $1 RETURNING id`,
      [id],
    );
    if (result.rows.length === 0) throw new NotFoundError('Branch');

    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1, $2, 'DELETE', 'branch', $3, $4, $5)`,
      [staffCtx.staffId, staffCtx.role, String(id), id, JSON.stringify({ id })],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Get / List ───────────────────────────────────────────────────────────────

export async function getBranch(id: number): Promise<Branch> {
  const result = await db.query(
    `SELECT id, name, address, contact_info, operating_hours, is_active, created_at
     FROM branches WHERE id = $1`,
    [id],
  );
  if (result.rows.length === 0) throw new NotFoundError('Branch');
  return mapRow(result.rows[0]);
}

export async function listBranches(filters: {
  isActive?: boolean;
  page: number;
  pageSize: number;
}): Promise<{ items: Branch[]; total: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.isActive !== undefined) {
    params.push(filters.isActive);
    conditions.push(`is_active = $${params.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const offset = (filters.page - 1) * filters.pageSize;

  const [dataResult, countResult] = await Promise.all([
    db.query(
      `SELECT id, name, address, contact_info, operating_hours, is_active, created_at
       FROM branches ${where}
       ORDER BY name ASC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filters.pageSize, offset],
    ),
    db.query(`SELECT COUNT(*) FROM branches ${where}`, params),
  ]);

  return {
    items: dataResult.rows.map(mapRow),
    total: parseInt(countResult.rows[0].count, 10),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function checkDependencies(
  branchId: number,
): Promise<Array<{ type: string; count: number }>> {
  const deps: Array<{ type: string; count: number }> = [];

  const checks = [
    { type: 'staff_assignments', query: `SELECT COUNT(*) FROM staff_branch_roles WHERE branch_id = $1` },
  ];

  for (const check of checks) {
    const result = await db.query(check.query, [branchId]);
    const count = parseInt(result.rows[0].count, 10);
    if (count > 0) deps.push({ type: check.type, count });
  }

  return deps;
}

function mapRow(row: Record<string, unknown>): Branch {
  return {
    id: row.id as number,
    name: row.name as string,
    address: row.address as string,
    contactInfo: row.contact_info as Record<string, string>,
    operatingHours: row.operating_hours as Record<string, string>,
    isActive: row.is_active as boolean,
    createdAt: (row.created_at as Date).toISOString(),
  };
}
