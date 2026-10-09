import { z } from 'zod';
import { IdSchema } from './common.js';

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

/** The value's type is checked per key by the API (string, number, boolean or any JSON). */
export const SetConfigValueRequestSchema = z.object({ value: z.unknown() });
export type SetConfigValueRequest = z.infer<typeof SetConfigValueRequestSchema>;
