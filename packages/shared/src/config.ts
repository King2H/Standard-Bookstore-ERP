import { z } from 'zod';
import { ROLES } from './auth.js';
import { IdSchema } from './common.js';
import { OrderPaymentMethodSchema } from './payment.js';

/** Contracts for /api/v1/config (#21). */

/** Where an effective value comes from: the branch's override or the system default. */
export const ConfigSourceSchema = z.enum(['branch', 'system']);
export type ConfigSource = z.infer<typeof ConfigSourceSchema>;

export const ConfigEntrySchema = z.object({
  key: z.string(),
  /** Any JSON value; its type depends on the key. */
  value: z.unknown(),
  updatedBy: z.number().int(),
  updatedAt: z.string(),
});
export type ConfigEntry = z.infer<typeof ConfigEntrySchema>;

export const EffectiveConfigEntrySchema = ConfigEntrySchema.extend({ source: ConfigSourceSchema });
export type EffectiveConfigEntry = z.infer<typeof EffectiveConfigEntrySchema>;

export const SystemConfigListResponseSchema = z.object({
  items: z.array(ConfigEntrySchema),
  total: z.number().int().min(0),
});
export type SystemConfigListResponse = z.infer<typeof SystemConfigListResponseSchema>;

export const BranchConfigListResponseSchema = z.object({
  items: z.array(EffectiveConfigEntrySchema),
  total: z.number().int().min(0),
});
export type BranchConfigListResponse = z.infer<typeof BranchConfigListResponseSchema>;

export const CurrencyResponseSchema = z.object({ currency: z.string() });
export type CurrencyResponse = z.infer<typeof CurrencyResponseSchema>;

/** `?keys=a,b` or `?keys=a&keys=b`; empty when absent. */
export const EffectiveConfigQuerySchema = z.object({
  keys: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) =>
      (Array.isArray(v) ? v.join(',') : (v ?? ''))
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean),
    ),
});
export type EffectiveConfigQuery = z.infer<typeof EffectiveConfigQuerySchema>;

export const EffectiveConfigResponseSchema = z.object({
  items: z.array(
    z.object({
      key: z.string(),
      /** Null when the key is not set anywhere. */
      value: z.unknown(),
      source: ConfigSourceSchema,
    }),
  ),
});
export type EffectiveConfigResponse = z.infer<typeof EffectiveConfigResponseSchema>;

export const ConfigKeyParamsSchema = z.object({ key: z.string().min(1) });
export const BranchConfigParamsSchema = z.object({ branchId: IdSchema });
export const BranchConfigKeyParamsSchema = z.object({ branchId: IdSchema, key: z.string().min(1) });

/** The value is checked per key with `CONFIG_VALUE_SCHEMAS`. */
export const SetConfigValueRequestSchema = z.object({ value: z.unknown() });
export type SetConfigValueRequest = z.infer<typeof SetConfigValueRequestSchema>;

// ── The settings and the values they take ─────────────────────────────────────

export const DISCOUNT_TYPES = ['Normal', 'Merchant', 'Special'] as const;
export const DISCOUNT_MODES = ['Percentage', 'Amount'] as const;

const text = z.string({ error: 'must be a string' });
const currencyCode = text.regex(/^[A-Z]{3}$/, 'must be a three-letter ISO 4217 code, e.g. ETB');
const number = z.number({ error: 'must be a number' });
const flag = z.boolean({ error: 'must be a boolean' });
const discountMode = z.enum(DISCOUNT_MODES, { error: `must be one of ${DISCOUNT_MODES.join(', ')}` });
const discountValue = number.min(0, 'must not be negative');
const roles: readonly string[] = ROLES;
const paymentMethods = `must be a list of payment methods: ${OrderPaymentMethodSchema.options.join(', ')}`;

/**
 * Settings that hold for every branch; a branch cannot override them. The
 * currency: every amount is recorded in it, so a branch showing another one
 * would label its amounts wrongly.
 */
export const SYSTEM_WIDE_CONFIG_KEYS: readonly string[] = ['base_currency'];

/**
 * The value each setting takes (#23). The API refuses any other key or value,
 * and the Settings page checks with the same rules before sending; a mistyped
 * value would otherwise be stored and read back as nothing (a discount limit
 * of 0 for every role). Messages complete "Config key '<key>' …".
 */
export const CONFIG_VALUE_SCHEMAS: Readonly<Record<string, z.ZodType>> = {
  base_currency: currencyCode,
  fiscal_year_start_month: number,
  max_line_discount_pct: z
    .record(z.string(), number.min(0, 'must give each role 0 to 100').max(100, 'must give each role 0 to 100'), {
      error: 'must be an object of role and percentage, e.g. {"Sales": 10}',
    })
    .refine((o) => Object.keys(o).every((k) => roles.includes(k)), `must name only roles: ${ROLES.join(', ')}`),
  max_transaction_discount_pct: number,
  discount_approval_threshold_pct: number,
  default_discount_type: z.enum(DISCOUNT_TYPES, { error: `must be one of ${DISCOUNT_TYPES.join(', ')}` }),
  default_discount_mode: discountMode,
  default_discount_value: discountValue,
  default_discount_mode_normal: discountMode,
  default_discount_value_normal: discountValue,
  default_discount_mode_merchant: discountMode,
  default_discount_value_merchant: discountValue,
  default_discount_mode_special: discountMode,
  default_discount_value_special: discountValue,
  reorder_point_default: number,
  allow_negative_stock: flag,
  po_approval_threshold: number,
  default_supplier_lead_time_days: number,
  return_window_days: number,
  max_return_value_without_auth: number,
  refund_method_after_window: text,
  loyalty_accrual_rate: number,
  loyalty_redemption_rate: number,
  loyalty_min_transaction_amount: number,
  exchange_cash_adjustment_allowed: flag,
  notification_prefs: z.record(z.string(), z.unknown(), { error: 'must be an object' }),
  allowed_payment_methods: z.array(z.enum(OrderPaymentMethodSchema.options, { error: paymentMethods }), { error: paymentMethods }),
  max_failed_login_attempts: number,
  account_lockout_minutes: number,
  password_expiry_days: number,
};
