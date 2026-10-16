import type { ProfileResponse } from '@bms/shared';

/**
 * Who may change the catalog: the API's rules (catalog.routes.ts,
 * catalogReference.routes.ts), so the page offers only what the API accepts.
 * Any role held in the session branch counts.
 */
type Account = Pick<ProfileResponse, 'currentRoles'>;

const holds = (me: Account | undefined, allowed: string[]) => (me?.currentRoles ?? []).some((r) => allowed.includes(r));

/** Adding and editing books, authors, categories and publishers, and changing their status: Admin, Manager and Stock_Clerk. */
export const canEditCatalog = (me: Account | undefined) => holds(me, ['Admin', 'Manager', 'Stock_Clerk']);

/** Deleting them: Admin only. */
export const canDeleteFromCatalog = (me: Account | undefined) => holds(me, ['Admin']);
