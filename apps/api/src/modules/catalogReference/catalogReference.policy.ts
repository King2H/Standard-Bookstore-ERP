import type { LifecycleStatus } from '@bms/shared';
import { BusinessError, ValidationError } from '../../lib/errors.js';
import type { LifecycleAction } from './catalogReference.types.js';

/** Pure rules of the catalog's reference data (A5). */

export function statusesFor(status: 'active' | 'inactive' | 'archived' | 'all' | undefined): LifecycleStatus[] | undefined {
  if (status === 'all') return undefined;
  if (status === 'inactive') return ['INACTIVE'];
  if (status === 'archived') return ['ARCHIVED'];
  return ['ACTIVE'];
}

/** Names are unique ignoring letter case and surrounding spaces. */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

const TARGET: Record<LifecycleAction, LifecycleStatus> = {
  ACTIVATE: 'ACTIVE',
  INACTIVATE: 'INACTIVE',
  ARCHIVE: 'ARCHIVED',
  RESTORE: 'ACTIVE',
};

/**
 * The status an action leads to, or null when the record already has it.
 * Active and inactive switch freely and either may be archived; an archived
 * record comes back only by restoring it, to active (owner decision, #21).
 */
export function nextStatus(current: LifecycleStatus, action: LifecycleAction): LifecycleStatus | null {
  const target = TARGET[action];
  if (current === target) return null;
  const allowed = current === 'ARCHIVED' ? action === 'RESTORE' : action !== 'RESTORE';
  if (!allowed) {
    throw new BusinessError(
      'INVALID_LIFECYCLE_TRANSITION',
      current === 'ARCHIVED' ? 'An archived record must be restored first' : 'Only an archived record can be restored',
      { currentStatus: current, action },
    );
  }
  return target;
}

/**
 * A category cannot sit under itself or under one of its own subcategories.
 * `parentChain` is the proposed parent followed by its ancestors.
 */
export function checkCategoryParent(categoryId: number, parentChain: number[]): void {
  if (parentChain.includes(categoryId)) {
    throw new ValidationError('A category cannot be placed under itself or one of its subcategories', { field: 'parentId' });
  }
}
