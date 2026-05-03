import { Role } from '@bms/shared';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
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
