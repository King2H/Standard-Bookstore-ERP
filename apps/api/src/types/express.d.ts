import { Role } from '@bms/shared';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      staff?: {
        staffId: number;
        role: Role;
        branchId: number;
      };
    }
  }
}
