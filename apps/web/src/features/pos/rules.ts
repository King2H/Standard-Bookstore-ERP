import type { ProfileResponse } from '@bms/shared';

/**
 * Who may do what at the counter: the API's rules (pos.routes.ts), so the page
 * offers only what the API accepts. Any role held in the session branch counts.
 */
type Account = Pick<ProfileResponse, 'currentRoles'>;

const holds = (me: Account | undefined, allowed: string[]) => (me?.currentRoles ?? []).some((r) => allowed.includes(r));

/** Voiding a sale: Manager and Admin (was: offered to Super_Admin, whom the API refuses). */
export const canVoid = (me: Account | undefined) => holds(me, ['Admin', 'Manager']);
