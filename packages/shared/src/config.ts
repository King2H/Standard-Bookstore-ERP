import { z } from 'zod';
import { ROLES } from './auth.js';
import { IdSchema } from './common.js';
import { NotificationPrefsSchema } from './notification.js';
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
 * would label its amounts wrongly. The time zone: a month is closed for the
 * whole shop, so its days are the same in every branch (#175). The shop's
 * name, motto and TIN: one shop, whichever branch prints (#228).
 */
export const SYSTEM_WIDE_CONFIG_KEYS: readonly string[] = [
  'base_currency', 'business_timezone', 'shop_name', 'shop_motto', 'shop_tin', 'tax_enabled', 'tax_rate_pct', 'tax_name',
];

/**
 * Tax (#247, ADR-0010): off, or on at one rate under a name, for the whole
 * shop. Prices include it. Super_Admin and Admin set it; Admin no other
 * shop-wide setting.
 */
export const TAX_CONFIG_KEYS: readonly string[] = ['tax_enabled', 'tax_rate_pct', 'tax_name'];
export const TAX_NAME_MAX = 20;

export const SHOP_NAME_MAX = 120;
export const SHOP_MOTTO_MAX = 200;

/**
 * The value each setting takes (#23). The API refuses any other key or value,
 * and the Settings page checks with the same rules before sending; a mistyped
 * value would otherwise be stored and read back as nothing (a discount limit
 * of 0 for every role). Messages complete "Config key '<key>' …".
 */
export const CONFIG_VALUE_SCHEMAS: Readonly<Record<string, z.ZodType>> = {
  base_currency: currencyCode,
  /** The shop's name on receipts, slips and the welcome banner; empty until the shop sets it (#228). */
  shop_name: text.max(SHOP_NAME_MAX, `must be at most ${SHOP_NAME_MAX} characters`),
  shop_motto: text.max(SHOP_MOTTO_MAX, `must be at most ${SHOP_MOTTO_MAX} characters`),
  /** The shop's tax identification number, 10 digits, on receipts and slips; empty when not given. */
  shop_tin: text.regex(/^(\d{10})?$/, 'must be a TIN of 10 digits, or empty'),
  tax_enabled: flag,
  /** The rate in percent: above 0, at most 100, two decimals at most (15 or 7.5). */
  tax_rate_pct: number
    .gt(0, 'must be above 0 and at most 100')
    .max(100, 'must be above 0 and at most 100')
    .refine((n) => Math.round(n * 100) === n * 100, 'must have at most two decimals'),
  /** How receipts name it, e.g. VAT or TOT. */
  tax_name: text.min(1, 'must not be empty').max(TAX_NAME_MAX, `must be at most ${TAX_NAME_MAX} characters`),
  /** The shop's local time zone, an IANA name such as Africa/Addis_Ababa: its days are closed and reported in it (#175). */
  business_timezone: text.regex(/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$|^UTC$/, 'must be a time zone name, e.g. Africa/Addis_Ababa'),
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
  /** Cash at the counter only with the staff member's open cash session (#171). */
  require_cash_session: flag,
  /** Over or short at a cash session's close beyond this waits for a Manager or Admin (#171). */
  cash_variance_limit: number.min(0, 'must not be negative'),
  /** Routine events turned on (#232); every other event always notifies. */
  notification_prefs: NotificationPrefsSchema,
  allowed_payment_methods: z.array(z.enum(OrderPaymentMethodSchema.options, { error: paymentMethods }), { error: paymentMethods }),
  max_failed_login_attempts: number,
  account_lockout_minutes: number,
  password_expiry_days: number,
};

// ── The shop's identity (#228) ────────────────────────────────────────────────

/**
 * GET /config/shop: what heads every receipt and slip, and the welcome
 * banner: the shop's name, motto and TIN (empty when not set), the name its
 * tax is printed under (#247), and the session branch's name, address and
 * phone. Any signed-in staff member.
 */
export const ShopIdentitySchema = z.object({
  name: z.string(),
  motto: z.string(),
  tin: z.string(),
  taxName: z.string(),
  branch: z.object({ id: z.number().int(), name: z.string(), address: z.string(), phone: z.string() }),
});
export type ShopIdentity = z.infer<typeof ShopIdentitySchema>;
