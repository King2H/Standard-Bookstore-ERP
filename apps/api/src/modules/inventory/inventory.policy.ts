import type { AdjustmentReason, LifecycleStatus } from '@bms/shared';
import { BusinessError, ConflictError, ValidationError } from '../../lib/errors.js';
import type { StockAlert } from './inventory.types.js';

/** Pure rules of the Inventory module (A5). */

export function statusesFor(status: 'active' | 'inactive' | 'archived' | 'all'): LifecycleStatus[] | undefined {
  if (status === 'all') return undefined;
  if (status === 'inactive') return ['INACTIVE'];
  if (status === 'archived') return ['ARCHIVED'];
  return ['ACTIVE'];
}

/** `?is_active=`: active books only when omitted, both for "all". */
export function isActiveFilter(value: 'true' | 'false' | 'all' | undefined): boolean | undefined {
  if (value === undefined) return true;
  if (value === 'all') return undefined;
  return value === 'true';
}

/** Changes to a stock row name the version they were based on (optimistic locking). */
export function checkVersion(current: number, provided: number): void {
  if (current !== provided) {
    throw new ConflictError('VERSION_CONFLICT', 'Inventory was modified by another operation. Please refresh and retry.', {
      currentVersion: current,
      providedVersion: provided,
    });
  }
}

// Damage and loss are shrinkage, a return puts stock back; a correction of a
// count discrepancy may go either way (owner decision, #21).
const DIRECTION: Record<AdjustmentReason, 'in' | 'out' | 'either'> = {
  damage: 'out',
  loss: 'out',
  return: 'in',
  correction: 'either',
};

export function checkAdjustmentDirection(reason: AdjustmentReason, delta: number): void {
  const direction = DIRECTION[reason];
  if (direction === 'out' && delta > 0) {
    throw new ValidationError(`A ${reason} adjustment must reduce stock`, { field: 'delta' });
  }
  if (direction === 'in' && delta < 0) {
    throw new ValidationError(`A ${reason} adjustment must add stock`, { field: 'delta' });
  }
}

/** Manual adjustments never take stock below zero. */
export function quantityAfterAdjustment(quantity: number, delta: number): number {
  const after = quantity + delta;
  if (after < 0) {
    throw new BusinessError('INSUFFICIENT_STOCK', `Cannot reduce stock below 0. Current: ${quantity}, Delta: ${delta}`);
  }
  return after;
}

/**
 * The alert a stock change raises: only when it crosses a threshold, so a
 * shelf that stays low does not alert again on every sale (owner decision, #21).
 */
export function stockAlert(before: number, after: number, reorderPoint: number): StockAlert | null {
  if (after <= 0) return before > 0 ? 'inventory.out_of_stock' : null;
  if (after <= reorderPoint && before > reorderPoint) return 'inventory.low_stock';
  return null;
}
