import type { ProfileResponse } from '@bms/shared';

/**
 * Who may change stock: the API's rules (inventory.routes.ts), so the page
 * offers only what the API accepts. Any role held in the session branch counts.
 */
type Account = Pick<ProfileResponse, 'currentRoles'>;

const holds = (me: Account | undefined, allowed: string[]) => (me?.currentRoles ?? []).some((r) => allowed.includes(r));

/** Stock in, stock out, adjustments and transfers: Admin, Manager and Stock_Clerk. */
export const canMoveStock = (me: Account | undefined) => holds(me, ['Admin', 'Manager', 'Stock_Clerk']);

/** Reorder points: Admin and Manager. */
export const canSetReorderPoint = (me: Account | undefined) => holds(me, ['Admin', 'Manager']);

/** The reason codes stock movements are recorded with, as History shows and filters them. */
export const REASON_LABELS: Record<string, string> = {
  correction: 'Correction', damage: 'Damage', initial: 'Initial', loss: 'Loss', return: 'Return', sale: 'Sale',
  stock_in: 'Stock In', transfer_in: 'Transfer In', transfer_out: 'Transfer Out',
};

export const MOVEMENT_LABELS: Record<string, string> = {
  stock_in: 'Stock In', stock_out: 'Stock Out', transfer_in: 'Transfer In', transfer_out: 'Transfer Out', adjustment: 'Adjustment',
};
