import { db } from '../../db/index.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { redisGet, redisSet, redisDel } from '../../lib/redis.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ConfigRow {
  key: string;
  value: unknown;
  updatedBy: number;
  updatedAt: string;
  source?: 'branch' | 'system';
}

export interface StaffCtx {
  staffId: number;
  role: string;
  branchId: number;
}

// ── Config key schema — validates value types on write ────────────────────────

const CONFIG_SCHEMA: Record<string, { type: 'string' | 'number' | 'boolean' | 'jsonb' }> = {
  base_currency:                    { type: 'string' },
  tax_rate:                         { type: 'number' },
  fiscal_year_start_month:          { type: 'number' },
  max_line_discount_pct:            { type: 'jsonb' },
  max_transaction_discount_pct:     { type: 'number' },
  discount_approval_threshold_pct:  { type: 'number' },
  reorder_point_default:            { type: 'number' },
  allow_negative_stock:             { type: 'boolean' },
  po_approval_threshold:            { type: 'number' },
  default_supplier_lead_time_days:  { type: 'number' },
  return_window_days:               { type: 'number' },
  max_return_value_without_auth:    { type: 'number' },
  refund_method_after_window:       { type: 'string' },
  min_deposit_pct:                  { type: 'number' },
  max_installments:                 { type: 'number' },
  installment_grace_period_days:    { type: 'number' },
  loyalty_accrual_rate:             { type: 'number' },
  loyalty_redemption_rate:          { type: 'number' },
  loyalty_min_transaction_amount:   { type: 'number' },
  exchange_cash_adjustment_allowed: { type: 'boolean' },
  notification_prefs:               { type: 'jsonb' },
  allowed_payment_methods:          { type: 'jsonb' },
  // Security policy keys (added in migration 1700000006)
  max_failed_login_attempts:        { type: 'number' },
  account_lockout_minutes:          { type: 'number' },
  password_expiry_days:             { type: 'number' },
};

function validateConfigValue(key: string, value: unknown): void {
  const schema = CONFIG_SCHEMA[key];
  if (!schema) throw new ValidationError(`Unknown config key: ${key}`);

  if (schema.type === 'string' && typeof value !== 'string') {
    throw new ValidationError(`Config key '${key}' must be a string`);
  }
  if (schema.type === 'number' && typeof value !== 'number') {
    throw new ValidationError(`Config key '${key}' must be a number`);
  }
  if (schema.type === 'boolean' && typeof value !== 'boolean') {
    throw new ValidationError(`Config key '${key}' must be a boolean`);
  }
  // jsonb accepts any JSON-serialisable value
}

// ── Core: effective config lookup (branch override → system default) ──────────

export async function getEffectiveConfig(branchId: number, key: string): Promise<unknown> {
  // Check Redis cache first (TTL 5 min)
  const cacheKey = `cfg:${branchId}:${key}`;
  const cached = await redisGet(cacheKey);
  if (cached !== null) {
    try { return JSON.parse(cached); } catch { /* fall through to DB */ }
  }

  // Try branch override first
  const branchResult = await db.query(
    `SELECT value FROM branch_config WHERE branch_id = $1 AND key = $2`,
    [branchId, key],
  );
  if (branchResult.rows.length > 0) {
    await redisSet(cacheKey, JSON.stringify(branchResult.rows[0].value), 300);
    return branchResult.rows[0].value;
  }

  // Fall back to system default
  const sysResult = await db.query(
    `SELECT value FROM system_config WHERE key = $1`,
    [key],
  );
  if (sysResult.rows.length > 0) {
    await redisSet(cacheKey, JSON.stringify(sysResult.rows[0].value), 300);
    return sysResult.rows[0].value;
  }

  throw new NotFoundError(`Config key '${key}'`);
}

export async function getEffectiveConfigWithSource(
  branchId: number,
  key: string,
): Promise<{ value: unknown; source: 'branch' | 'system' }> {
  const branchResult = await db.query(
    `SELECT value FROM branch_config WHERE branch_id = $1 AND key = $2`,
    [branchId, key],
  );
  if (branchResult.rows.length > 0) {
    return { value: branchResult.rows[0].value, source: 'branch' };
  }

  const sysResult = await db.query(
    `SELECT value FROM system_config WHERE key = $1`,
    [key],
  );
  if (sysResult.rows.length > 0) {
    return { value: sysResult.rows[0].value, source: 'system' };
  }

  throw new NotFoundError(`Config key '${key}'`);
}

// ── System config ─────────────────────────────────────────────────────────────

export async function listSystemConfig(): Promise<ConfigRow[]> {
  const result = await db.query(
    `SELECT key, value, updated_by, updated_at FROM system_config ORDER BY key`,
  );
  return result.rows.map(mapSystemRow);
}

export async function setSystemConfig(
  key: string,
  value: unknown,
  staffCtx: StaffCtx,
): Promise<ConfigRow> {
  if (staffCtx.role !== 'Super_Admin') {
    throw new ForbiddenError('Only Super_Admin can modify system configuration');
  }
  validateConfigValue(key, value);

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Fetch previous value for audit
    const prev = await client.query(`SELECT value FROM system_config WHERE key = $1`, [key]);
    const prevValue = prev.rows[0]?.value ?? null;

    const result = await client.query(
      `INSERT INTO system_config (key, value, updated_by, updated_at)
       VALUES ($1, $2::jsonb, $3, now())
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()
       RETURNING key, value, updated_by, updated_at`,
      [key, JSON.stringify(value), staffCtx.staffId],
    );

    // Audit log (Req 1.25 — write audit within same transaction)
    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1, $2, 'UPDATE', 'system_config', $3, NULL, $4)`,
      [
        staffCtx.staffId,
        staffCtx.role,
        key,
        JSON.stringify({ key, previousValue: prevValue, newValue: value }),
      ],
    );

    await client.query('COMMIT');
    // Invalidate Redis cache for all branches (system config affects all)
    // We use a pattern-based approach: delete known branch cache keys
    // Since we don't track all branches here, we rely on TTL expiry for system config
    // Branch-specific cache is invalidated in setBranchConfig
    return mapSystemRow(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Branch config ─────────────────────────────────────────────────────────────

export async function listBranchConfig(branchId: number): Promise<ConfigRow[]> {
  const result = await db.query(
    `SELECT key, value, updated_by, updated_at FROM branch_config WHERE branch_id = $1 ORDER BY key`,
    [branchId],
  );
  return result.rows.map(mapBranchRow);
}

/**
 * Returns merged effective config for a branch — each key shows its value and
 * whether it came from a branch override or the system default.
 */
export async function getEffectiveBranchConfig(branchId: number): Promise<Array<ConfigRow & { source: 'branch' | 'system' }>> {
  const [sysRows, branchRows] = await Promise.all([
    db.query(`SELECT key, value, updated_by, updated_at FROM system_config ORDER BY key`),
    db.query(`SELECT key, value, updated_by, updated_at FROM branch_config WHERE branch_id = $1`, [branchId]),
  ]);

  const branchMap = new Map<string, ConfigRow>(
    branchRows.rows.map((r: Record<string, unknown>) => [r.key as string, mapBranchRow(r)]),
  );

  return sysRows.rows.map((r: Record<string, unknown>) => {
    const key = r.key as string;
    const override = branchMap.get(key);
    if (override) return { ...override, source: 'branch' as const };
    return { ...mapSystemRow(r), source: 'system' as const };
  });
}

export async function setBranchConfig(
  branchId: number,
  key: string,
  value: unknown,
  staffCtx: StaffCtx,
): Promise<ConfigRow> {
  if (!['Super_Admin', 'Admin', 'Manager'].includes(staffCtx.role)) {
    throw new ForbiddenError('Only Super_Admin, Admin, or Manager can modify branch configuration');
  }
  validateConfigValue(key, value);

  // Verify branch exists
  const branchCheck = await db.query(`SELECT id FROM branches WHERE id = $1`, [branchId]);
  if (branchCheck.rows.length === 0) throw new NotFoundError('Branch');

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const prev = await client.query(
      `SELECT value FROM branch_config WHERE branch_id = $1 AND key = $2`,
      [branchId, key],
    );
    const prevValue = prev.rows[0]?.value ?? null;

    const result = await client.query(
      `INSERT INTO branch_config (branch_id, key, value, updated_by, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, now())
       ON CONFLICT (branch_id, key) DO UPDATE
         SET value = EXCLUDED.value,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()
       RETURNING key, value, updated_by, updated_at`,
      [branchId, key, JSON.stringify(value), staffCtx.staffId],
    );

    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1, $2, 'UPDATE', 'branch_config', $3, $4, $5)`,
      [
        staffCtx.staffId,
        staffCtx.role,
        key,
        branchId,
        JSON.stringify({ key, branchId, previousValue: prevValue, newValue: value }),
      ],
    );

    await client.query('COMMIT');
    // Invalidate Redis cache for this branch+key
    await redisDel(`cfg:${branchId}:${key}`);
    return mapBranchRow(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteBranchConfig(
  branchId: number,
  key: string,
  staffCtx: StaffCtx,
): Promise<void> {
  if (!['Super_Admin', 'Admin'].includes(staffCtx.role)) {
    throw new ForbiddenError('Only Super_Admin or Admin can delete branch config overrides');
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `DELETE FROM branch_config WHERE branch_id = $1 AND key = $2 RETURNING key`,
      [branchId, key],
    );
    if (result.rows.length === 0) throw new NotFoundError(`Branch config key '${key}'`);

    await client.query(
      `INSERT INTO audit_logs (staff_id, staff_role, action, entity_type, entity_id, branch_id, meta)
       VALUES ($1, $2, 'DELETE', 'branch_config', $3, $4, $5)`,
      [
        staffCtx.staffId,
        staffCtx.role,
        key,
        branchId,
        JSON.stringify({ key, branchId, action: 'override_removed' }),
      ],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Typed helper methods (used by other service modules) ──────────────────────

export async function getMaxLineDiscountPct(branchId: number, role: string): Promise<number> {
  const val = await getEffectiveConfig(branchId, 'max_line_discount_pct') as Record<string, number>;
  return val[role] ?? 0;
}

export async function getDiscountApprovalThresholdPct(branchId: number): Promise<number> {
  return Number(await getEffectiveConfig(branchId, 'discount_approval_threshold_pct'));
}

export async function getPOApprovalThreshold(): Promise<number> {
  const result = await db.query(`SELECT value FROM system_config WHERE key = 'po_approval_threshold'`);
  return Number(result.rows[0]?.value ?? 1000);
}

export async function getReturnWindowDays(branchId: number): Promise<number> {
  return Number(await getEffectiveConfig(branchId, 'return_window_days'));
}

export async function getMaxReturnValueWithoutAuth(): Promise<number> {
  const result = await db.query(`SELECT value FROM system_config WHERE key = 'max_return_value_without_auth'`);
  return Number(result.rows[0]?.value ?? 500);
}

export async function getRefundMethodAfterWindow(): Promise<'any' | 'store_credit_only'> {
  const result = await db.query(`SELECT value FROM system_config WHERE key = 'refund_method_after_window'`);
  return (result.rows[0]?.value ?? 'any') as 'any' | 'store_credit_only';
}

export async function getMinDepositPct(branchId: number): Promise<number> {
  return Number(await getEffectiveConfig(branchId, 'min_deposit_pct'));
}

export async function getMaxInstallments(): Promise<number> {
  const result = await db.query(`SELECT value FROM system_config WHERE key = 'max_installments'`);
  return Number(result.rows[0]?.value ?? 12);
}

export async function getInstallmentGracePeriodDays(): Promise<number> {
  const result = await db.query(`SELECT value FROM system_config WHERE key = 'installment_grace_period_days'`);
  return Number(result.rows[0]?.value ?? 0);
}

export async function getAllowedPaymentMethods(branchId: number): Promise<string[]> {
  try {
    const val = await getEffectiveConfig(branchId, 'allowed_payment_methods');
    return Array.isArray(val) ? val : [];
  } catch {
    // Key not set → all methods allowed
    return [];
  }
}

export async function getLoyaltyAccrualRate(): Promise<number> {
  const result = await db.query(`SELECT value FROM system_config WHERE key = 'loyalty_accrual_rate'`);
  return Number(result.rows[0]?.value ?? 0.01);
}

export async function getLoyaltyRedemptionRate(): Promise<number> {
  const result = await db.query(`SELECT value FROM system_config WHERE key = 'loyalty_redemption_rate'`);
  return Number(result.rows[0]?.value ?? 1.0);
}

export async function getLoyaltyMinTransactionAmount(): Promise<number> {
  const result = await db.query(`SELECT value FROM system_config WHERE key = 'loyalty_min_transaction_amount'`);
  return Number(result.rows[0]?.value ?? 0);
}

export async function isNegativeStockAllowed(): Promise<boolean> {
  const result = await db.query(`SELECT value FROM system_config WHERE key = 'allow_negative_stock'`);
  return result.rows[0]?.value === true;
}

export async function isExchangeCashAdjustmentAllowed(): Promise<boolean> {
  const result = await db.query(`SELECT value FROM system_config WHERE key = 'exchange_cash_adjustment_allowed'`);
  return result.rows[0]?.value === true;
}

// ── Row mappers ───────────────────────────────────────────────────────────────

function mapSystemRow(row: Record<string, unknown>): ConfigRow {
  return {
    key: row.key as string,
    value: row.value,
    updatedBy: row.updated_by as number,
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

function mapBranchRow(row: Record<string, unknown>): ConfigRow {
  return {
    key: row.key as string,
    value: row.value,
    updatedBy: row.updated_by as number,
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}
