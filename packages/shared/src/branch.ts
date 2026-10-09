import { z } from 'zod';
import { ListPagingQuerySchema, PaginatedSchema } from './common.js';

/** Contracts for /api/v1/branches (#21). */

export const BranchSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  address: z.string(),
  contactInfo: z.record(z.string(), z.string()),
  /** Opening hours by day, e.g. `{ mon: '09:00-18:00', sun: 'closed' }`. */
  operatingHours: z.record(z.string(), z.string()),
  isActive: z.boolean(),
  createdAt: z.string(),
});
export type Branch = z.infer<typeof BranchSchema>;

export const BranchListQuerySchema = ListPagingQuerySchema.extend({
  isActive: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});
export type BranchListQuery = z.infer<typeof BranchListQuerySchema>;

export const BranchListResponseSchema = PaginatedSchema(BranchSchema);
export type BranchListResponse = z.infer<typeof BranchListResponseSchema>;

/** Active branches for the sign-in page: no token needed, so only id and name. */
export const PublicBranchListResponseSchema = z.object({
  items: z.array(z.object({ id: z.number().int(), name: z.string() })),
});
export type PublicBranchListResponse = z.infer<typeof PublicBranchListResponseSchema>;

const ContactInfoSchema = z.object({ phone: z.string().optional(), email: z.string().optional() });

export const DEFAULT_OPERATING_HOURS: Record<string, string> = {
  mon: '09:00-18:00',
  tue: '09:00-18:00',
  wed: '09:00-18:00',
  thu: '09:00-18:00',
  fri: '09:00-18:00',
  sat: '10:00-16:00',
  sun: 'closed',
};

export const CreateBranchRequestSchema = z.object({
  name: z.string().min(1).max(100),
  address: z.string().min(1),
  contactInfo: ContactInfoSchema.transform((c) => ({ phone: c.phone ?? '', email: c.email ?? '' })).prefault({}),
  operatingHours: z.record(z.string(), z.string()).default(DEFAULT_OPERATING_HOURS),
});
export type CreateBranchRequest = z.infer<typeof CreateBranchRequestSchema>;

/** Only the fields sent are changed; nothing falls back to a default. */
export const UpdateBranchRequestSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  address: z.string().min(1).optional(),
  contactInfo: ContactInfoSchema.optional(),
  operatingHours: z.record(z.string(), z.string()).optional(),
});
export type UpdateBranchRequest = z.infer<typeof UpdateBranchRequestSchema>;
