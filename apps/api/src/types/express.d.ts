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
    }
  }
}
