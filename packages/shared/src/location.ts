import { z } from 'zod';
import { IdSchema } from './common.js';

/** Contracts for /api/v1/branches/{branchId}/locations and /api/v1/staff/{id}/locations (#21). */

export const LocationSchema = z.object({
  id: z.number().int(),
  branchId: z.number().int(),
  name: z.string(),
  /** Where orders are fulfilled when they name no location; at most one per branch. */
  isDefaultFulfillment: z.boolean(),
  createdAt: z.string(),
});
export type Location = z.infer<typeof LocationSchema>;

/** `restricted` when the caller may use only the locations assigned to them in this branch. */
export const LocationAccessModeSchema = z.enum(['full', 'restricted']);
export type LocationAccessMode = z.infer<typeof LocationAccessModeSchema>;

export const LocationListResponseSchema = z.object({
  items: z.array(LocationSchema),
  total: z.number().int().min(0),
  accessMode: LocationAccessModeSchema,
});
export type LocationListResponse = z.infer<typeof LocationListResponseSchema>;

export const BranchLocationsParamsSchema = z.object({ branchId: IdSchema });
export const BranchLocationParamsSchema = z.object({ branchId: IdSchema, id: IdSchema });

export const LocationNameRequestSchema = z.object({ name: z.string().min(1).max(100) });
export type LocationNameRequest = z.infer<typeof LocationNameRequestSchema>;

export const StaffLocationSchema = z.object({
  locationId: z.number().int(),
  locationName: z.string(),
  branchId: z.number().int(),
});
export type StaffLocation = z.infer<typeof StaffLocationSchema>;

export const StaffLocationListResponseSchema = z.object({
  items: z.array(StaffLocationSchema),
  total: z.number().int().min(0),
  /** True when the staff member has no assignments, so may use every location of their branches. */
  fallbackMode: z.boolean(),
});
export type StaffLocationListResponse = z.infer<typeof StaffLocationListResponseSchema>;

/**
 * The staff member's locations, replacing the current ones; `[]` lifts every
 * restriction. Locations of a branch the caller cannot manage may be listed
 * only as they already are.
 */
export const SetStaffLocationsRequestSchema = z.array(z.number().int().positive());
export type SetStaffLocationsRequest = z.infer<typeof SetStaffLocationsRequestSchema>;
