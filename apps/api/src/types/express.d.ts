import { Role } from '@bms/shared';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      /** Parsed request parts, set by the validate() middleware. */
      valid?: Record<string, unknown>;
      staff?: {
        staffId: number;
        role: Role;          // primary role (backward compat)
        roles?: string[];    // all roles for the active branch
        branchId: number;
        permissions?: string[];
      };
      /** Which branches this request may touch; set by authenticate(). */
      scope?: {
        staffId: number;
        /** The active branch, from the access token. */
        branchId: number;
        /** staff.is_all_branches: may read any branch, or all of them where an endpoint allows it. */
        allBranches: boolean;
      };
    }
  }
}
