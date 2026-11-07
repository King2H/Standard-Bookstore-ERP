import type { ProfileResponse } from '@bms/shared';
import type { ImportKind } from './api.js';

/**
 * Who brings in which list: the API's rules (imports.routes.ts). Admin and
 * Manager every list; who books stock (MANAGE_INVENTORY: Stock_Clerk,
 * Purchasor) opening stock, in their branch and locations.
 */
type Account = Pick<ProfileResponse, 'currentRoles'>;

const ALLOWED: Record<ImportKind, string[]> = {
  catalog: ['Admin', 'Manager'],
  'opening-stock': ['Admin', 'Manager', 'Stock_Clerk', 'Purchasor'],
  customers: ['Admin', 'Manager'],
  'customer-balances': ['Admin', 'Manager'],
  'supplier-balances': ['Admin', 'Manager'],
};

export const canImport = (me: Account | undefined, kind: ImportKind) => (me?.currentRoles ?? []).some((r) => ALLOWED[kind].includes(r));
