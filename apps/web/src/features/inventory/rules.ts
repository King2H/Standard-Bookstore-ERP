import type { AdjustmentReason, ProfileResponse, StockInRequest, StockLevel, StockOutRequest } from '@bms/shared';

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

/** Revaluing the copies on hand, with a reason (#163): Admin and Manager. */
export const canRevalue = (me: Account | undefined, row: Pick<StockLevel, 'quantity'>) =>
  row.quantity > 0 && holds(me, ['Admin', 'Manager']);

/** Writing damaged copies off or putting them back for sale (#168): the stock movers, where there are some. */
export const canHandleDamaged = (me: Account | undefined, row: Pick<StockLevel, 'damaged'>) => row.damaged > 0 && canMoveStock(me);

/** Copies on hand with no cost: they add nothing to the inventory value until revalued. */
export const hasNoCost = (row: Pick<StockLevel, 'averageCost' | 'quantity'>) => row.averageCost === 0 && row.quantity > 0;

/**
 * Staff limited to certain locations change stock only there (#72): the API
 * refuses the others, so the page offers only these.
 */
export const canUseLocation = (me: Pick<ProfileResponse, 'locationAccess'> | undefined, locationId: number) =>
  !!me && (me.locationAccess.mode === 'full' || me.locationAccess.locations.some((l) => l.id === locationId));

/**
 * What a stock-in by hand may name. A purchase order is received in
 * Procurement, which also counts it as received (owner decision 1a, #23).
 */
export const STOCK_IN_REFERENCES: { value: NonNullable<StockInRequest['referenceType']>; label: string }[] = [
  { value: 'return', label: 'Customer Return' },
  { value: 'manual', label: 'Manual Entry' },
  { value: 'initial_stock', label: 'Opening Stock' },
];

/**
 * What a stock-out by hand may name: it is recorded as a loss; sales go
 * through POS and orders, damage through Adjust (owner decision 2a, #23).
 */
export const STOCK_OUT_REFERENCES: { value: NonNullable<StockOutRequest['referenceType']>; label: string }[] = [
  { value: 'manual', label: 'Manual Removal' },
];

/**
 * The way each adjustment reason moves stock, as the API checks it: damage and
 * loss remove, a return adds, a correction goes either way (#21).
 */
export const ADJUSTMENT_DIRECTION: Record<AdjustmentReason, 'add' | 'remove' | null> = {
  correction: null, damage: 'remove', loss: 'remove', return: 'add',
};

/** The reason codes stock movements are recorded with, as History shows and filters them. */
export const REASON_LABELS: Record<string, string> = {
  correction: 'Correction', damage: 'Damage', damage_repaired: 'Repaired', damage_write_off: 'Written Off', initial: 'Initial', loss: 'Loss',
  return: 'Return', revaluation: 'Revalued', sale: 'Sale',
  stock_in: 'Stock In', transfer_in: 'Transfer In', transfer_out: 'Transfer Out',
};

export const MOVEMENT_LABELS: Record<string, string> = {
  stock_in: 'Stock In', stock_out: 'Stock Out', transfer_in: 'Transfer In', transfer_out: 'Transfer Out', adjustment: 'Adjustment',
};
