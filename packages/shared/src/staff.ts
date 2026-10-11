import { z } from 'zod';
import { PasswordSchema, RoleSchema, ROLES, StaffRoleAssignmentSchema } from './auth.js';
import { IdSchema, ListPagingQuerySchema, PaginatedSchema } from './common.js';

/** Contracts for staff administration, /api/v1/staff (#21, auth part 2). */

type Role = (typeof ROLES)[number];

/**
 * Super_Admin > Admin > Manager > the other roles. Staff manage only people
 * ranked below them, and grant only roles below their own; a Super_Admin,
 * at the top, grants any role (owner decision 2a).
 */
export const ROLE_RANK: Record<Role, number> = {
  Super_Admin: 3,
  Admin: 2,
  Manager: 1,
  Finance_Officer: 0,
  Stock_Clerk: 0,
  Sales: 0,
  Purchasor: 0,
};

/** The highest rank among the roles; -1 for none. */
export function rankOf(roles: readonly string[]): number {
  return Math.max(-1, ...roles.map((r) => ROLE_RANK[r as Role] ?? 0));
}

/** The roles someone holding `roles` may grant. */
export function grantableRoles(roles: readonly string[]): Role[] {
  if (roles.includes('Super_Admin')) return [...ROLES];
  const rank = rankOf(roles);
  return ROLES.filter((r) => ROLE_RANK[r] < rank);
}

/** 3–50 letters, digits, dots, underscores or hyphens; unique ignoring case (owner decision 4a). */
export const UsernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(50)
  .regex(/^[A-Za-z0-9._-]+$/, 'Letters, digits, dots, underscores and hyphens only');

export const StaffSchema = z.object({
  id: z.number().int(),
  username: z.string(),
  fullName: z.string(),
  isActive: z.boolean(),
  createdAt: z.string(),
  mustChangePassword: z.boolean(),
  lockedUntil: z.string().nullable(),
  failedLoginAttempts: z.number().int(),
  lastLoginAt: z.string().nullable(),
  passwordChangedAt: z.string().nullable(),
  isAllBranches: z.boolean(),
  roles: z.array(StaffRoleAssignmentSchema),
  /** Whether the signed-in staff member may change this account. */
  canManage: z.boolean(),
});
export type Staff = z.infer<typeof StaffSchema>;

export const StaffListQuerySchema = ListPagingQuerySchema;
export const StaffListResponseSchema = PaginatedSchema(StaffSchema);
export type StaffListResponse = z.infer<typeof StaffListResponseSchema>;

export const RoleAssignmentInputSchema = z.object({
  branchId: IdSchema,
  role: RoleSchema,
});

export const CreateStaffRequestSchema = z.object({
  username: UsernameSchema,
  password: PasswordSchema,
  fullName: z.string().trim().min(1).max(100),
  /** The account is created with these roles, in one step (owner decision 5a). */
  roles: z.array(RoleAssignmentInputSchema).default([]),
  /** Super_Admin only (owner decision 3a). */
  isAllBranches: z.boolean().default(false),
});
export type CreateStaffRequest = z.infer<typeof CreateStaffRequestSchema>;

export const CreateStaffResponseSchema = z.object({ staffId: z.number().int() });

export const UpdateStaffRequestSchema = z.object({
  fullName: z.string().trim().min(1).max(100),
});

/**
 * Every role the staff member should hold. Roles in branches the caller does
 * not manage must be sent as they are; only the ones the caller may change can
 * differ.
 */
export const SetStaffRolesRequestSchema = z.array(RoleAssignmentInputSchema);
export type SetStaffRolesRequest = z.infer<typeof SetStaffRolesRequestSchema>;

export const SetAllBranchesRequestSchema = z.object({ isAllBranches: z.boolean() });

export const ResetPasswordRequestSchema = z.object({ temporaryPassword: PasswordSchema });
