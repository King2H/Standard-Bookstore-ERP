import type { RoleAssignment } from '../auth/auth.types.js';

/** Records the staff module passes between its layers (#21, auth part 2). */

export type { RoleAssignment };

/** The signed-in staff member doing the administration. */
export interface Actor {
  staffId: number;
  /** The first of `roles`, for the audit log. */
  role: string;
  /** The roles in effect in the session branch. */
  roles: string[];
  branchId: number;
  isAllBranches: boolean;
  /** Every role held, in every branch. */
  assignments: RoleAssignment[];
}

export interface StaffRecord {
  id: number;
  username: string;
  fullName: string;
  isActive: boolean;
  createdAt: Date;
  mustChangePassword: boolean;
  lockedUntil: Date | null;
  failedLoginAttempts: number;
  lastLoginAt: Date | null;
  passwordChangedAt: Date | null;
  isAllBranches: boolean;
  roles: Array<RoleAssignment & { branchName: string | null }>;
}

/** Which staff a list shows: everyone, or those with a role in some branches (and those with none). */
export type Visibility = { all: true } | { all: false; branchIds: number[]; includeRoleless: boolean };

export interface NewStaff {
  username: string;
  password: string;
  fullName: string;
  roles: RoleAssignment[];
  isAllBranches: boolean;
}
