import { ForbiddenError, ValidationError } from '../../lib/errors.js';
import type { ConfigRecord, ConfigValueType, EffectiveConfigRecord } from './config.types.js';

/**
 * Configuration rules as pure functions (A5): no I/O, so they are unit-tested
 * without a database (__tests__/config.policy.test.ts).
 */

/** The keys that can be written, with the type of their value. */
export const CONFIG_KEYS: Record<string, ConfigValueType> = {
  base_currency: 'string',
  // tax_rate is disabled for this phase — taxation is globally off; DB key preserved for future use
  fiscal_year_start_month: 'number',
  max_line_discount_pct: 'jsonb',
  max_transaction_discount_pct: 'number',
  discount_approval_threshold_pct: 'number',
  reorder_point_default: 'number',
  allow_negative_stock: 'boolean',
  po_approval_threshold: 'number',
  default_supplier_lead_time_days: 'number',
  return_window_days: 'number',
  max_return_value_without_auth: 'number',
  refund_method_after_window: 'string',
  loyalty_accrual_rate: 'number',
  loyalty_redemption_rate: 'number',
  loyalty_min_transaction_amount: 'number',
  exchange_cash_adjustment_allowed: 'boolean',
  notification_prefs: 'jsonb',
  allowed_payment_methods: 'jsonb',
  // Security policy keys (added in migration 1700000006)
  max_failed_login_attempts: 'number',
  account_lockout_minutes: 'number',
  password_expiry_days: 'number',
};

/** Throws 400 unless `key` is a known setting and `value` has its type. */
export function checkConfigValue(key: string, value: unknown): void {
  const type = Object.hasOwn(CONFIG_KEYS, key) ? CONFIG_KEYS[key] : undefined;
  if (!type) throw new ValidationError(`Unknown config key: ${key}`);
  if (type !== 'jsonb' && typeof value !== type) {
    throw new ValidationError(`Config key '${key}' must be a ${type}`);
  }
}

export function checkCanChangeSystemConfig(role: string): void {
  if (role !== 'Super_Admin') {
    throw new ForbiddenError('Only Super_Admin can modify system configuration');
  }
}

export function checkCanChangeBranchConfig(role: string): void {
  if (!['Super_Admin', 'Admin', 'Manager'].includes(role)) {
    throw new ForbiddenError('Only Super_Admin, Admin, or Manager can modify branch configuration');
  }
}

export function checkCanRemoveBranchOverride(role: string): void {
  if (!['Super_Admin', 'Admin'].includes(role)) {
    throw new ForbiddenError('Only Super_Admin or Admin can delete branch config overrides');
  }
}

/**
 * A branch's effective settings: every system key, with the branch's
 * override in its place where there is one. Overrides of keys that have no
 * system default are left out.
 */
export function mergeEffective(system: ConfigRecord[], branch: ConfigRecord[]): EffectiveConfigRecord[] {
  const overrides = new Map(branch.map((r) => [r.key, r]));
  return system.map((r) => {
    const override = overrides.get(r.key);
    return override ? { ...override, source: 'branch' } : { ...r, source: 'system' };
  });
}
