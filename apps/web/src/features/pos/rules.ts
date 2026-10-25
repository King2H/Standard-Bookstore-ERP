import type { ProfileResponse } from '@bms/shared';

/**
 * Who may do what at the counter: the API's rules (pos.routes.ts), so the page
 * offers only what the API accepts. Any role held in the session branch counts.
 */
type Account = Pick<ProfileResponse, 'currentRoles'>;

const holds = (me: Account | undefined, allowed: string[]) => (me?.currentRoles ?? []).some((r) => allowed.includes(r));

/** Moving a sale's binding job on: the selling roles (CREATE_SALE), as the API checks (#169). */
export const canSell = (me: Account | undefined) => holds(me, ['Admin', 'Manager', 'Sales']);

/** Voiding a sale: Manager and Admin (was: offered to Super_Admin, whom the API refuses). */
export const canVoid = (me: Account | undefined) => holds(me, ['Admin', 'Manager']);

/**
 * The largest line discount the cashier may give: the most any role held in
 * the branch allows (`max_line_discount_pct`, per role), as the API checks it.
 */
export function maxDiscountPct(limits: unknown, me: Account | undefined): number {
  if (!limits || typeof limits !== 'object') return 0;
  const byRole = limits as Record<string, unknown>;
  return Math.max(0, ...(me?.currentRoles ?? []).map((r) => Number(byRole[r] ?? 0) || 0));
}
