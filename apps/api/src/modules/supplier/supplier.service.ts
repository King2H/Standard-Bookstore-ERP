import { db } from '../../db/index.js';
import { BusinessError, ConflictError, NotFoundError } from '../../lib/errors.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StaffCtx { staffId: number; role: string; branchId: number; }

export interface SupplierRow {
  id: number;
  name: string;
  contactInfo: Record<string, unknown>;
  leadTimeDays: number;
  pricingTerms: string | null;
  supplierType: 'external' | 'publisher';
  publisherId: number | null;
  publisherName: string | null;
  isActive: boolean;
  isBlacklisted: boolean;
  createdAt: string;
}

export interface BookSupplierRow {
  bookId: number;
  supplierId: number;
  supplierName: string;
  supplierSku: string | null;
  isPrimary: boolean;
}

// ── Row mapper ────────────────────────────────────────────────────────────────

function mapSupplierRow(row: Record<string, unknown>): SupplierRow {
  return {
    id: row.id as number,
    name: row.name as string,
    contactInfo: (row.contact_info as Record<string, unknown>) ?? {},
    leadTimeDays: row.lead_time_days as number,
    pricingTerms: (row.pricing_terms as string | null) ?? null,
    supplierType: row.supplier_type as 'external' | 'publisher',
    publisherId: (row.publisher_id as number | null) ?? null,
    publisherName: (row.publisher_name as string | null) ?? null,
    isActive: row.is_active as boolean,
    isBlacklisted: row.is_blacklisted as boolean,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

// ── Supplier SELECT fragment ──────────────────────────────────────────────────

const SUPPLIER_SELECT = `
  SELECT s.id, s.name, s.contact_info, s.lead_time_days, s.pricing_terms,
         s.supplier_type, s.publisher_id, p.name AS publisher_name,
         s.is_active, s.is_blacklisted, s.created_at
  FROM suppliers s
  LEFT JOIN publishers p ON p.id = s.publisher_id
`;

// ── Validate supplier_type rules ──────────────────────────────────────────────

function validateSupplierTypeRules(
  supplierType: string | undefined,
  publisherId: number | null | undefined,
) {
  if (supplierType === 'publisher' && !publisherId) {
    throw new BusinessError('PUBLISHER_ID_REQUIRED', 'publisher_id is required when supplier_type is publisher');
  }
  if (supplierType === 'external' && publisherId != null) {
    throw new BusinessError('PUBLISHER_ID_NOT_ALLOWED', 'publisher_id must not be set when supplier_type is external');
  }
}

// ── Create ────────────────────────────────────────────────────────────────────

export async function create(
  data: {
    name: string;
    contactInfo: Record<string, unknown>;
    leadTimeDays?: number;
    pricingTerms?: string;
    supplierType: 'external' | 'publisher';
    publisherId?: number | null;
  },
  staffCtx: StaffCtx,
): Promise<SupplierRow> {
  validateSupplierTypeRules(data.supplierType, data.publisherId ?? null);

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    let result;
    try {
      result = await client.query(
        `INSERT INTO suppliers (name, contact_info, lead_time_days, pricing_terms, supplier_type, publisher_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          data.name,
          JSON.stringify(data.contactInfo),
          data.leadTimeDays ?? 7,
          data.pricingTerms ?? null,
          data.supplierType,
          data.publisherId ?? null,
        ],
      );
    } catch (err: unknown) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictError('DUPLICATE_SUPPLIER_NAME', `Supplier '${data.name}' already exists`);
      }
      throw err;
    }

    const id: number = result.rows[0].id;

    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1, $2, 'CREATE', 'supplier', $3, $4, $5)`,
      [staffCtx.staffId, staffCtx.role, String(id), staffCtx.branchId, JSON.stringify({ name: data.name })],
    );

    await client.query('COMMIT');
    return getById(id);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Update ────────────────────────────────────────────────────────────────────

export async function update(
  id: number,
  data: {
    name?: string;
    contactInfo?: Record<string, unknown>;
    leadTimeDays?: number;
    pricingTerms?: string | null;
    supplierType?: 'external' | 'publisher';
    publisherId?: number | null;
    isActive?: boolean;
  },
  staffCtx: StaffCtx,
): Promise<SupplierRow> {
  // Re-validate type rules if either field is being changed
  if (data.supplierType !== undefined || data.publisherId !== undefined) {
    // Fetch current values to fill in missing side
    const current = await db.query(`SELECT supplier_type, publisher_id FROM suppliers WHERE id = $1`, [id]);
    if (!current.rows.length) throw new NotFoundError('Supplier');
    const effectiveType = data.supplierType ?? (current.rows[0].supplier_type as string);
    const effectivePubId = data.publisherId !== undefined ? data.publisherId : (current.rows[0].publisher_id as number | null);
    validateSupplierTypeRules(effectiveType, effectivePubId);
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  let p = 1;

  if (data.name !== undefined) { sets.push(`name = $${p++}`); params.push(data.name); }
  if (data.contactInfo !== undefined) { sets.push(`contact_info = $${p++}`); params.push(JSON.stringify(data.contactInfo)); }
  if (data.leadTimeDays !== undefined) { sets.push(`lead_time_days = $${p++}`); params.push(data.leadTimeDays); }
  if (data.pricingTerms !== undefined) { sets.push(`pricing_terms = $${p++}`); params.push(data.pricingTerms); }
  if (data.supplierType !== undefined) { sets.push(`supplier_type = $${p++}`); params.push(data.supplierType); }
  if (data.publisherId !== undefined) { sets.push(`publisher_id = $${p++}`); params.push(data.publisherId); }
  if (data.isActive !== undefined) { sets.push(`is_active = $${p++}`); params.push(data.isActive); }

  if (!sets.length) return getById(id);

  params.push(id);
  const result = await db.query(
    `UPDATE suppliers SET ${sets.join(', ')} WHERE id = $${p} RETURNING id`,
    params,
  );
  if (!result.rows.length) throw new NotFoundError('Supplier');

  await db.query(
    `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
     VALUES ($1, $2, 'UPDATE', 'supplier', $3, $4, $5)`,
    [staffCtx.staffId, staffCtx.role, String(id), staffCtx.branchId, JSON.stringify(data)],
  );

  return getById(id);
}

// ── Deactivate ────────────────────────────────────────────────────────────────

export async function deactivate(id: number, staffCtx: StaffCtx): Promise<void> {
  const result = await db.query(
    `UPDATE suppliers SET is_active = false WHERE id = $1 RETURNING id`,
    [id],
  );
  if (!result.rows.length) throw new NotFoundError('Supplier');

  await db.query(
    `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
     VALUES ($1, $2, 'UPDATE', 'supplier', $3, $4, $5)`,
    [staffCtx.staffId, staffCtx.role, String(id), staffCtx.branchId, JSON.stringify({ action: 'deactivate' })],
  );
}

// ── Blacklist ─────────────────────────────────────────────────────────────────

export async function blacklist(id: number, staffCtx: StaffCtx): Promise<void> {
  const result = await db.query(
    `UPDATE suppliers SET is_blacklisted = true WHERE id = $1 RETURNING id`,
    [id],
  );
  if (!result.rows.length) throw new NotFoundError('Supplier');

  await db.query(
    `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
     VALUES ($1, $2, 'UPDATE', 'supplier', $3, $4, $5)`,
    [staffCtx.staffId, staffCtx.role, String(id), staffCtx.branchId, JSON.stringify({ action: 'blacklist' })],
  );
}

// ── Delete ────────────────────────────────────────────────────────────────────

export async function deleteSupplier(id: number, staffCtx: StaffCtx): Promise<void> {
  // Check for associated POs (table may not exist yet in early slices)
  const poTableExists = await db.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'purchase_orders'`,
  );
  if (poTableExists.rows.length > 0) {
    const poCheck = await db.query(
      `SELECT COUNT(*) FROM purchase_orders WHERE supplier_id = $1`,
      [id],
    );
    const poCount = parseInt(poCheck.rows[0].count as string, 10);
    if (poCount > 0) {
      throw new ConflictError('DEPENDENCY_CONFLICT', 'Supplier has associated purchase orders', { poCount });
    }
  }

  const result = await db.query(`DELETE FROM suppliers WHERE id = $1 RETURNING id`, [id]);
  if (!result.rows.length) throw new NotFoundError('Supplier');

  await db.query(
    `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
     VALUES ($1, $2, 'DELETE', 'supplier', $3, $4, $5)`,
    [staffCtx.staffId, staffCtx.role, String(id), staffCtx.branchId, JSON.stringify({ action: 'delete' })],
  );
}

// ── List ──────────────────────────────────────────────────────────────────────

export async function list(opts: {
  supplierType?: string;
  isActive?: boolean;
  isBlacklisted?: boolean;
  q?: string;
  page?: number;
  pageSize?: number;
}): Promise<{ items: SupplierRow[]; total: number; page: number; totalPages: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, opts.pageSize ?? 25);
  const offset = (page - 1) * pageSize;

  const conditions: string[] = [];
  const params: unknown[] = [];
  let p = 1;

  if (opts.supplierType) { conditions.push(`s.supplier_type = $${p++}`); params.push(opts.supplierType); }
  if (opts.isActive !== undefined) { conditions.push(`s.is_active = $${p++}`); params.push(opts.isActive); }
  if (opts.isBlacklisted !== undefined) { conditions.push(`s.is_blacklisted = $${p++}`); params.push(opts.isBlacklisted); }
  if (opts.q) {
    conditions.push(`lower(s.name) LIKE lower($${p++})`);
    params.push(`%${opts.q.trim()}%`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const [countRes, dataRes] = await Promise.all([
    db.query(
      `SELECT COUNT(*) FROM suppliers s LEFT JOIN publishers p ON p.id = s.publisher_id ${where}`,
      params,
    ),
    db.query(
      `${SUPPLIER_SELECT} ${where} ORDER BY s.name ASC LIMIT $${p++} OFFSET $${p++}`,
      [...params, pageSize, offset],
    ),
  ]);

  const total = parseInt(countRes.rows[0].count as string, 10);
  return {
    items: dataRes.rows.map(mapSupplierRow),
    total,
    page,
    totalPages: Math.ceil(total / pageSize),
  };
}

// ── Get by ID ─────────────────────────────────────────────────────────────────

export async function getById(id: number): Promise<SupplierRow> {
  const result = await db.query(`${SUPPLIER_SELECT} WHERE s.id = $1`, [id]);
  if (!result.rows.length) throw new NotFoundError('Supplier');
  return mapSupplierRow(result.rows[0]);
}

// ── Get suppliers for a book ──────────────────────────────────────────────────

export async function getSuppliersForBook(bookId: number): Promise<BookSupplierRow[]> {
  const result = await db.query(
    `SELECT bs.book_id, bs.supplier_id, s.name AS supplier_name,
            bs.supplier_sku, bs.is_primary
     FROM book_suppliers bs
     JOIN suppliers s ON s.id = bs.supplier_id
     LEFT JOIN publishers p ON p.id = s.publisher_id
     WHERE bs.book_id = $1
     ORDER BY bs.is_primary DESC, s.name ASC`,
    [bookId],
  );
  return result.rows.map(row => ({
    bookId: row.book_id as number,
    supplierId: row.supplier_id as number,
    supplierName: row.supplier_name as string,
    supplierSku: (row.supplier_sku as string | null) ?? null,
    isPrimary: row.is_primary as boolean,
  }));
}

// ── Validate supplier for procurement ────────────────────────────────────────

export async function validateSupplierForProcurement(supplierId: number): Promise<void> {
  const result = await db.query(
    `SELECT is_active, is_blacklisted FROM suppliers WHERE id = $1`,
    [supplierId],
  );
  if (!result.rows.length) throw new NotFoundError('Supplier');

  const { is_active, is_blacklisted } = result.rows[0] as { is_active: boolean; is_blacklisted: boolean };
  if (!is_active) {
    throw new BusinessError('SUPPLIER_INACTIVE', 'Supplier is inactive and cannot be used for procurement');
  }
  if (is_blacklisted) {
    throw new BusinessError('SUPPLIER_BLACKLISTED', 'Supplier is blacklisted and cannot be used for procurement');
  }
}

// ── Link book to supplier ─────────────────────────────────────────────────────

export async function linkBookToSupplier(
  bookId: number,
  supplierId: number,
  supplierSku: string | null,
  isPrimary: boolean,
  staffCtx: StaffCtx,
): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    if (isPrimary) {
      // Clear existing primary for this book
      await client.query(
        `UPDATE book_suppliers SET is_primary = false WHERE book_id = $1`,
        [bookId],
      );
    }

    await client.query(
      `INSERT INTO book_suppliers (book_id, supplier_id, supplier_sku, is_primary)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (book_id, supplier_id) DO UPDATE
         SET supplier_sku = EXCLUDED.supplier_sku,
             is_primary = EXCLUDED.is_primary`,
      [bookId, supplierId, supplierSku, isPrimary],
    );

    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1, $2, 'CREATE', 'book_supplier', $3, $4, $5)`,
      [staffCtx.staffId, staffCtx.role, `${bookId}:${supplierId}`, staffCtx.branchId,
       JSON.stringify({ bookId, supplierId, supplierSku, isPrimary })],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Unlink book from supplier ─────────────────────────────────────────────────

export async function unlinkBookFromSupplier(
  bookId: number,
  supplierId: number,
  staffCtx: StaffCtx,
): Promise<void> {
  await db.query(
    `DELETE FROM book_suppliers WHERE book_id = $1 AND supplier_id = $2`,
    [bookId, supplierId],
  );

  await db.query(
    `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
     VALUES ($1, $2, 'DELETE', 'book_supplier', $3, $4, $5)`,
    [staffCtx.staffId, staffCtx.role, `${bookId}:${supplierId}`, staffCtx.branchId,
     JSON.stringify({ bookId, supplierId })],
  );
}
