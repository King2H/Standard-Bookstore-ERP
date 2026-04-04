import { db } from '../../db/index.js';
import { BusinessError, ConflictError, NotFoundError } from '../../lib/errors.js';
import {
  getLoyaltyAccrualRate,
  getLoyaltyMinTransactionAmount,
} from '../config/config.service.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StaffCtx { staffId: number; role: string; branchId: number; }

export interface CustomerRow {
  id: number;
  branchId: number | null;
  customerCode: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  gender: string | null;
  dateOfBirth: string | null;
  address: string | null;
  city: string | null;
  isActive: boolean;
  createdAt: string;
  loyaltyBalance: number;
  lifetimePoints: number;
  storeCreditBalance: number;
  groups: Array<{ id: number; name: string; discountPct: number }>;
}

export interface CustomerGroupRow {
  id: number;
  name: string;
  description: string | null;
  discountPct: number;
}

// ── Row mapper ────────────────────────────────────────────────────────────────

function mapCustomerRow(
  row: Record<string, unknown>,
  groups: Array<{ id: number; name: string; discountPct: number }> = [],
): CustomerRow {
  return {
    id: row.id as number,
    branchId: (row.branch_id as number | null) ?? null,
    customerCode: row.customer_code as string,
    fullName: row.full_name as string,
    phone: (row.phone as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    gender: (row.gender as string | null) ?? null,
    dateOfBirth: row.date_of_birth
      ? (row.date_of_birth instanceof Date
          ? row.date_of_birth.toISOString().split('T')[0]
          : String(row.date_of_birth))
      : null,
    address: (row.address as string | null) ?? null,
    city: (row.city as string | null) ?? null,
    isActive: row.is_active as boolean,
    createdAt: (row.created_at as Date).toISOString(),
    loyaltyBalance: Number(row.points_balance ?? 0),
    lifetimePoints: Number(row.lifetime_points ?? 0),
    storeCreditBalance: Number(row.store_credit_balance ?? 0),
    groups,
  };
}

// ── Fetch groups for a customer ───────────────────────────────────────────────

async function fetchGroups(customerId: number): Promise<Array<{ id: number; name: string; discountPct: number }>> {
  const result = await db.query(
    `SELECT cg.id, cg.name, cg.discount_pct
     FROM customer_group_membership cgm
     JOIN customer_groups cg ON cg.id = cgm.group_id
     WHERE cgm.customer_id = $1
     ORDER BY cg.name ASC`,
    [customerId],
  );
  return result.rows.map(r => ({
    id: r.id as number,
    name: r.name as string,
    discountPct: Number(r.discount_pct),
  }));
}

// ── Get by ID ─────────────────────────────────────────────────────────────────

export async function getCustomerById(id: number): Promise<CustomerRow> {
  const result = await db.query(
    `SELECT c.*,
       COALESCE(la.points_balance, 0) AS points_balance,
       COALESCE(la.lifetime_points, 0) AS lifetime_points,
       COALESCE(sca.balance, 0) AS store_credit_balance
     FROM customers c
     LEFT JOIN loyalty_accounts la ON la.customer_id = c.id
     LEFT JOIN store_credit_accounts sca ON sca.customer_id = c.id
     WHERE c.id = $1`,
    [id],
  );
  if (!result.rows.length) throw new NotFoundError('Customer');
  const groups = await fetchGroups(id);
  return mapCustomerRow(result.rows[0], groups);
}

// ── Create ────────────────────────────────────────────────────────────────────

export async function createCustomer(
  data: {
    fullName: string;
    phone?: string | null;
    email?: string | null;
    gender?: string | null;
    dateOfBirth?: string | null;
    address?: string | null;
    city?: string | null;
    branchId?: number | null;
  },
  staffCtx: StaffCtx,
): Promise<CustomerRow> {
  // Uniqueness checks
  if (data.phone) {
    const phoneCheck = await db.query(`SELECT id FROM customers WHERE phone = $1`, [data.phone]);
    if (phoneCheck.rows.length) {
      throw new ConflictError('DUPLICATE_CONTACT', 'Phone number already in use', { field: 'phone' });
    }
  }
  if (data.email) {
    const emailCheck = await db.query(`SELECT id FROM customers WHERE email = $1`, [data.email]);
    if (emailCheck.rows.length) {
      throw new ConflictError('DUPLICATE_CONTACT', 'Email address already in use', { field: 'email' });
    }
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Auto-generate customer_code (race-condition safe within transaction)
    const seqResult = await client.query(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(customer_code FROM 5) AS INTEGER)), 0) + 1 AS next_seq
       FROM customers`,
    );
    const nextSeq: number = seqResult.rows[0].next_seq as number;
    const customerCode = `CUS-${String(nextSeq).padStart(4, '0')}`;

    const result = await client.query(
      `INSERT INTO customers (branch_id, customer_code, full_name, phone, email, gender, date_of_birth, address, city, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        data.branchId ?? null,
        customerCode,
        data.fullName,
        data.phone ?? null,
        data.email ?? null,
        data.gender ?? null,
        data.dateOfBirth ?? null,
        data.address ?? null,
        data.city ?? null,
        staffCtx.staffId,
      ],
    );

    const customerId: number = result.rows[0].id as number;

    // Create loyalty account
    await client.query(
      `INSERT INTO loyalty_accounts (customer_id, points_balance, lifetime_points, updated_at)
       VALUES ($1, 0, 0, now())`,
      [customerId],
    );

    // Create store credit account
    await client.query(
      `INSERT INTO store_credit_accounts (customer_id, balance)
       VALUES ($1, 0)`,
      [customerId],
    );

    // Audit log
    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1, $2, 'CREATE', 'customer', $3, $4, $5)`,
      [
        staffCtx.staffId,
        staffCtx.role,
        String(customerId),
        staffCtx.branchId,
        JSON.stringify({ customerCode, fullName: data.fullName }),
      ],
    );

    await client.query('COMMIT');
    return getCustomerById(customerId);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Update ────────────────────────────────────────────────────────────────────

export async function updateCustomer(
  id: number,
  data: {
    fullName?: string;
    phone?: string | null;
    email?: string | null;
    gender?: string | null;
    dateOfBirth?: string | null;
    address?: string | null;
    city?: string | null;
    branchId?: number | null;
  },
  staffCtx: StaffCtx,
): Promise<CustomerRow> {
  // Verify customer exists
  const existing = await db.query(`SELECT id, phone, email FROM customers WHERE id = $1`, [id]);
  if (!existing.rows.length) throw new NotFoundError('Customer');

  const current = existing.rows[0] as { id: number; phone: string | null; email: string | null };

  // Uniqueness checks (exclude self)
  if (data.phone !== undefined && data.phone !== null && data.phone !== current.phone) {
    const phoneCheck = await db.query(`SELECT id FROM customers WHERE phone = $1 AND id != $2`, [data.phone, id]);
    if (phoneCheck.rows.length) {
      throw new ConflictError('DUPLICATE_CONTACT', 'Phone number already in use', { field: 'phone' });
    }
  }
  if (data.email !== undefined && data.email !== null && data.email !== current.email) {
    const emailCheck = await db.query(`SELECT id FROM customers WHERE email = $1 AND id != $2`, [data.email, id]);
    if (emailCheck.rows.length) {
      throw new ConflictError('DUPLICATE_CONTACT', 'Email address already in use', { field: 'email' });
    }
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  let p = 1;

  if (data.fullName !== undefined) { sets.push(`full_name = $${p++}`); params.push(data.fullName); }
  if (data.phone !== undefined) { sets.push(`phone = $${p++}`); params.push(data.phone); }
  if (data.email !== undefined) { sets.push(`email = $${p++}`); params.push(data.email); }
  if (data.gender !== undefined) { sets.push(`gender = $${p++}`); params.push(data.gender); }
  if (data.dateOfBirth !== undefined) { sets.push(`date_of_birth = $${p++}`); params.push(data.dateOfBirth); }
  if (data.address !== undefined) { sets.push(`address = $${p++}`); params.push(data.address); }
  if (data.city !== undefined) { sets.push(`city = $${p++}`); params.push(data.city); }
  if (data.branchId !== undefined) { sets.push(`branch_id = $${p++}`); params.push(data.branchId); }

  if (sets.length) {
    params.push(id);
    await db.query(`UPDATE customers SET ${sets.join(', ')} WHERE id = $${p}`, params);
  }

  await db.query(
    `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
     VALUES ($1, $2, 'UPDATE', 'customer', $3, $4, $5)`,
    [staffCtx.staffId, staffCtx.role, String(id), staffCtx.branchId, JSON.stringify(data)],
  );

  return getCustomerById(id);
}

// ── Deactivate ────────────────────────────────────────────────────────────────

export async function deactivateCustomer(id: number, staffCtx: StaffCtx): Promise<void> {
  const result = await db.query(
    `UPDATE customers SET is_active = false WHERE id = $1 RETURNING id`,
    [id],
  );
  if (!result.rows.length) throw new NotFoundError('Customer');

  await db.query(
    `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
     VALUES ($1, $2, 'UPDATE', 'customer', $3, $4, $5)`,
    [staffCtx.staffId, staffCtx.role, String(id), staffCtx.branchId, JSON.stringify({ action: 'deactivate' })],
  );
}

// ── Search ────────────────────────────────────────────────────────────────────

export async function searchCustomers(opts: {
  q?: string;
  branchId?: number;
  isActive?: boolean;
  groupId?: number;
  page?: number;
  pageSize?: number;
}): Promise<{ items: CustomerRow[]; total: number; page: number; totalPages: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, opts.pageSize ?? 25);
  const offset = (page - 1) * pageSize;

  const conditions: string[] = [];
  const params: unknown[] = [];
  let p = 1;

  if (opts.q) {
    conditions.push(
      `(c.full_name ILIKE $${p} OR c.phone ILIKE $${p} OR c.email ILIKE $${p} OR c.customer_code ILIKE $${p})`,
    );
    params.push(`%${opts.q.trim()}%`);
    p++;
  }
  if (opts.branchId !== undefined) { conditions.push(`c.branch_id = $${p++}`); params.push(opts.branchId); }
  if (opts.isActive !== undefined) { conditions.push(`c.is_active = $${p++}`); params.push(opts.isActive); }
  if (opts.groupId !== undefined) {
    conditions.push(`EXISTS (SELECT 1 FROM customer_group_membership cgm WHERE cgm.customer_id = c.id AND cgm.group_id = $${p++})`);
    params.push(opts.groupId);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const baseQuery = `
    FROM customers c
    LEFT JOIN loyalty_accounts la ON la.customer_id = c.id
    LEFT JOIN store_credit_accounts sca ON sca.customer_id = c.id
    ${where}
  `;

  const [countRes, dataRes] = await Promise.all([
    db.query(`SELECT COUNT(*) ${baseQuery}`, params),
    db.query(
      `SELECT c.*,
         COALESCE(la.points_balance, 0) AS points_balance,
         COALESCE(la.lifetime_points, 0) AS lifetime_points,
         COALESCE(sca.balance, 0) AS store_credit_balance
       ${baseQuery}
       ORDER BY c.full_name ASC
       LIMIT $${p++} OFFSET $${p++}`,
      [...params, pageSize, offset],
    ),
  ]);

  const total = parseInt(countRes.rows[0].count as string, 10);

  // Fetch groups for all returned customers
  const customerIds = dataRes.rows.map(r => r.id as number);
  let groupsMap = new Map<number, Array<{ id: number; name: string; discountPct: number }>>();
  if (customerIds.length) {
    const groupsRes = await db.query(
      `SELECT cgm.customer_id, cg.id, cg.name, cg.discount_pct
       FROM customer_group_membership cgm
       JOIN customer_groups cg ON cg.id = cgm.group_id
       WHERE cgm.customer_id = ANY($1)
       ORDER BY cg.name ASC`,
      [customerIds],
    );
    for (const row of groupsRes.rows) {
      const cid = row.customer_id as number;
      if (!groupsMap.has(cid)) groupsMap.set(cid, []);
      groupsMap.get(cid)!.push({ id: row.id as number, name: row.name as string, discountPct: Number(row.discount_pct) });
    }
  }

  return {
    items: dataRes.rows.map(r => mapCustomerRow(r, groupsMap.get(r.id as number) ?? [])),
    total,
    page,
    totalPages: Math.ceil(total / pageSize),
  };
}

// ── Loyalty: Accrue Points ────────────────────────────────────────────────────

export async function accruePoints(
  customerId: number,
  transactionAmount: number,
  transactionRef: string | null,
  staffCtx: StaffCtx,
): Promise<void> {
  const rate = await getLoyaltyAccrualRate();
  const minAmount = await getLoyaltyMinTransactionAmount();

  if (transactionAmount < minAmount) return; // no-op below threshold

  const points = Math.floor(transactionAmount * rate);
  if (points <= 0) return;

  await db.query(
    `UPDATE loyalty_accounts
     SET points_balance = points_balance + $1,
         lifetime_points = lifetime_points + $1,
         updated_at = now()
     WHERE customer_id = $2`,
    [points, customerId],
  );

  await db.query(
    `INSERT INTO loyalty_history (customer_id, transaction_ref, points_delta, reason)
     VALUES ($1, $2, $3, 'ACCRUAL')`,
    [customerId, transactionRef, points],
  );
}

// ── Loyalty: Redeem Points ────────────────────────────────────────────────────

export async function redeemPoints(
  customerId: number,
  points: number,
  transactionRef: string | null,
  staffCtx: StaffCtx,
): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const balRes = await client.query(
      `SELECT points_balance FROM loyalty_accounts WHERE customer_id = $1 FOR UPDATE`,
      [customerId],
    );
    if (!balRes.rows.length) throw new NotFoundError('Loyalty account');

    const balance = Number(balRes.rows[0].points_balance);
    if (balance < points) {
      throw new BusinessError('INSUFFICIENT_LOYALTY_POINTS', 'Insufficient loyalty points balance', {
        available: balance,
        requested: points,
      });
    }

    await client.query(
      `UPDATE loyalty_accounts SET points_balance = points_balance - $1, updated_at = now() WHERE customer_id = $2`,
      [points, customerId],
    );

    await client.query(
      `INSERT INTO loyalty_history (customer_id, transaction_ref, points_delta, reason)
       VALUES ($1, $2, $3, 'REDEMPTION')`,
      [customerId, transactionRef, -points],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Store Credit: Credit ──────────────────────────────────────────────────────

export async function creditStoreCredit(
  customerId: number,
  amount: number,
  refType: string | null,
  refId: string | null,
  staffCtx: StaffCtx,
): Promise<void> {
  await db.query(
    `UPDATE store_credit_accounts SET balance = balance + $1 WHERE customer_id = $2`,
    [amount, customerId],
  );

  await db.query(
    `INSERT INTO store_credit_history (customer_id, ref_type, ref_id, amount, direction)
     VALUES ($1, $2, $3, $4, 'credit')`,
    [customerId, refType, refId, amount],
  );
}

// ── Store Credit: Debit ───────────────────────────────────────────────────────

export async function debitStoreCredit(
  customerId: number,
  amount: number,
  refType: string | null,
  refId: string | null,
  staffCtx: StaffCtx,
): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const balRes = await client.query(
      `SELECT balance FROM store_credit_accounts WHERE customer_id = $1 FOR UPDATE`,
      [customerId],
    );
    if (!balRes.rows.length) throw new NotFoundError('Store credit account');

    const balance = Number(balRes.rows[0].balance);
    if (balance < amount) {
      throw new BusinessError('INSUFFICIENT_STORE_CREDIT', 'Insufficient store credit balance', {
        available: balance,
        requested: amount,
      });
    }

    await client.query(
      `UPDATE store_credit_accounts SET balance = balance - $1 WHERE customer_id = $2`,
      [amount, customerId],
    );

    await client.query(
      `INSERT INTO store_credit_history (customer_id, ref_type, ref_id, amount, direction)
       VALUES ($1, $2, $3, $4, 'debit')`,
      [customerId, refType, refId, amount],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Loyalty History ───────────────────────────────────────────────────────────

export async function getLoyaltyHistory(
  customerId: number,
  page: number,
  pageSize: number,
): Promise<{ items: unknown[]; total: number; page: number; totalPages: number }> {
  const offset = (page - 1) * pageSize;
  const [countRes, dataRes] = await Promise.all([
    db.query(`SELECT COUNT(*) FROM loyalty_history WHERE customer_id = $1`, [customerId]),
    db.query(
      `SELECT id, customer_id, transaction_ref, points_delta, reason, created_at
       FROM loyalty_history WHERE customer_id = $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [customerId, pageSize, offset],
    ),
  ]);
  const total = parseInt(countRes.rows[0].count as string, 10);
  return {
    items: dataRes.rows.map(r => ({
      id: r.id,
      customerId: r.customer_id,
      transactionRef: r.transaction_ref,
      pointsDelta: Number(r.points_delta),
      reason: r.reason,
      createdAt: (r.created_at as Date).toISOString(),
    })),
    total,
    page,
    totalPages: Math.ceil(total / pageSize),
  };
}

// ── Store Credit History ──────────────────────────────────────────────────────

export async function getStoreCreditHistory(
  customerId: number,
  page: number,
  pageSize: number,
): Promise<{ items: unknown[]; total: number; page: number; totalPages: number }> {
  const offset = (page - 1) * pageSize;
  const [countRes, dataRes] = await Promise.all([
    db.query(`SELECT COUNT(*) FROM store_credit_history WHERE customer_id = $1`, [customerId]),
    db.query(
      `SELECT id, customer_id, ref_type, ref_id, amount, direction, created_at
       FROM store_credit_history WHERE customer_id = $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [customerId, pageSize, offset],
    ),
  ]);
  const total = parseInt(countRes.rows[0].count as string, 10);
  return {
    items: dataRes.rows.map(r => ({
      id: r.id,
      customerId: r.customer_id,
      refType: r.ref_type,
      refId: r.ref_id,
      amount: Number(r.amount),
      direction: r.direction,
      createdAt: (r.created_at as Date).toISOString(),
    })),
    total,
    page,
    totalPages: Math.ceil(total / pageSize),
  };
}

// ── Customer Groups ───────────────────────────────────────────────────────────

export async function listCustomerGroups(): Promise<CustomerGroupRow[]> {
  const result = await db.query(
    `SELECT id, name, description, discount_pct FROM customer_groups ORDER BY name ASC`,
  );
  return result.rows.map(r => ({
    id: r.id as number,
    name: r.name as string,
    description: (r.description as string | null) ?? null,
    discountPct: Number(r.discount_pct),
  }));
}

export async function createCustomerGroup(
  data: { name: string; description?: string | null; discountPct?: number },
  staffCtx: StaffCtx,
): Promise<CustomerGroupRow> {
  const result = await db.query(
    `INSERT INTO customer_groups (name, description, discount_pct)
     VALUES ($1, $2, $3)
     RETURNING id, name, description, discount_pct`,
    [data.name, data.description ?? null, data.discountPct ?? 0],
  );

  await db.query(
    `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
     VALUES ($1, $2, 'CREATE', 'customer_group', $3, $4, $5)`,
    [staffCtx.staffId, staffCtx.role, String(result.rows[0].id), staffCtx.branchId, JSON.stringify({ name: data.name })],
  );

  return {
    id: result.rows[0].id as number,
    name: result.rows[0].name as string,
    description: (result.rows[0].description as string | null) ?? null,
    discountPct: Number(result.rows[0].discount_pct),
  };
}
