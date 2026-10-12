import { Role } from '@bms/shared';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      /** Parsed request parts, set by the validate() middleware. */
      valid?: Record<string, unknown>;
      staff?: {
        staffId: number;
        /** The sign-in session the access token belongs to. */
        sessionId: string;
        role: Role;          // primary role (backward compat)
        roles?: string[];    // the roles in effect in the active branch, read on every request
        branchId: number;
        permissions?: string[];
      };
      /** Which branches this request may touch; set by authenticate(). */
      scope?: {
        /** The signed-in account's tenant, read from the database (#13). */
        tenantId: number;
        staffId: number;
        /** The active branch, from the access token. */
        branchId: number;
        /** staff.is_all_branches: may read any branch, or all of them where an endpoint allows it. */
        allBranches: boolean;
      };
    }
  }
}
