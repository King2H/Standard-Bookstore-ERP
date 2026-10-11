import { z } from 'zod';

/** Contracts for signing in and the signed-in staff member: /api/v1/auth and /api/v1/staff/me (#21). */

export const ROLES = ['Super_Admin', 'Admin', 'Manager', 'Finance_Officer', 'Stock_Clerk', 'Sales', 'Purchasor'] as const;
export const RoleSchema = z.enum(ROLES);

/** At least 10 characters, with an upper-case and a lower-case letter, a digit and another character. */
export const PasswordSchema = z
  .string()
  .regex(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{10,}$/,
    'Must be at least 10 characters and contain upper-case, lower-case, digit and special character',
  );

export const PreLoginRequestSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export type PreLoginRequest = z.infer<typeof PreLoginRequestSchema>;

export const BranchAccessSchema = z.object({
  branchId: z.number().int(),
  branchName: z.string(),
  /** The roles held in the branch; staff with access to all branches may hold none there. */
  roles: z.array(z.string()),
  isAllBranches: z.boolean(),
});
export type BranchAccess = z.infer<typeof BranchAccessSchema>;

export const PreLoginResponseSchema = z.object({
  staffId: z.number().int(),
  /** Open branches the staff member can sign in to. */
  branches: z.array(BranchAccessSchema),
  isAllBranches: z.boolean(),
  /** Sign in here without asking: the only branch, or the first for staff with access to all branches. */
  autoSelectBranchId: z.number().int().nullable(),
});
export type PreLoginResponse = z.infer<typeof PreLoginResponseSchema>;

export const LoginRequestSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  branchId: z.number().int().positive(),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

/** Login, refresh and switch-branch; the refresh token travels in the httpOnly `refreshToken` cookie. */
export const AccessTokenResponseSchema = z.object({
  accessToken: z.string(),
  /** Seconds until the access token expires. */
  expiresIn: z.number().int(),
  mustChangePassword: z.boolean(),
  csrfToken: z.string(),
});
export type AccessTokenResponse = z.infer<typeof AccessTokenResponseSchema>;

export const SwitchBranchRequestSchema = z.object({
  branchId: z.number().int().positive(),
});
export type SwitchBranchRequest = z.infer<typeof SwitchBranchRequestSchema>;

export const AuthBranchListResponseSchema = z.object({
  branches: z.array(BranchAccessSchema),
});
export type AuthBranchListResponse = z.infer<typeof AuthBranchListResponseSchema>;

export const StaffRoleAssignmentSchema = z.object({
  branchId: z.number().int(),
  branchName: z.string().nullable(),
  role: z.string(),
});

export const ProfileResponseSchema = z.object({
  id: z.number().int(),
  username: z.string(),
  fullName: z.string(),
  isActive: z.boolean(),
  createdAt: z.string(),
  mustChangePassword: z.boolean(),
  lastLoginAt: z.string().nullable(),
  passwordChangedAt: z.string().nullable(),
  isLocked: z.boolean(),
  isAllBranches: z.boolean(),
  /** Every role held, in every branch. */
  roles: z.array(StaffRoleAssignmentSchema),
  /** The first of the roles in effect in the session's branch. */
  currentRole: z.string(),
  /** The roles in effect in the session's branch. */
  currentRoles: z.array(z.string()),
  currentBranchId: z.number().int(),
  locationAccess: z.object({
    mode: z.enum(['full', 'restricted']),
    locations: z.array(z.object({ id: z.number().int(), name: z.string(), isDefaultFulfillment: z.boolean() })),
  }),
});
export type ProfileResponse = z.infer<typeof ProfileResponseSchema>;

export const ChangePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: PasswordSchema,
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;
