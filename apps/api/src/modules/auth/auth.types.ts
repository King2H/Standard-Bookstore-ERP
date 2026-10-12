/** Records the auth module passes between its layers (#21). */

export interface StaffCredentials {
  staffId: number;
  passwordHash: string;
  isActive: boolean;
  isAllBranches: boolean;
  mustChangePassword: boolean;
  lockedUntil: Date | null;
}

/** One role held in one branch. */
export interface RoleAssignment {
  branchId: number;
  role: string;
}

export type RevokeReason = 'logout' | 'password_changed' | 'password_reset' | 'deactivated' | 'token_reuse';

/** A refresh token found by its hash, with its session and staff member. */
export interface RefreshTokenRecord {
  tokenId: string;
  usedAt: Date | null;
  sessionId: string;
  staffId: number;
  branchId: number;
  expiresAt: Date;
  revokedAt: Date | null;
  staffActive: boolean;
  isAllBranches: boolean;
  mustChangePassword: boolean;
  now: Date;
}

/** What authenticate() needs on every request. */
export interface SessionState {
  tenantId: number;
  isActive: boolean;
  isAllBranches: boolean;
  mustChangePassword: boolean;
  /** The session exists, belongs to the staff member, and has neither ended nor expired. */
  sessionLive: boolean;
  assignments: RoleAssignment[];
}

/** Tokens a sign-in or refresh hands out. */
export interface IssuedTokens {
  accessToken: string;
  /** Null when a refresh fell in the reuse grace period: the browser keeps the cookie it has. */
  refreshToken: string | null;
  sessionExpiresAt: Date;
  mustChangePassword: boolean;
}

export interface BranchOption {
  branchId: number;
  branchName: string;
  roles: string[];
  isAllBranches: boolean;
}
