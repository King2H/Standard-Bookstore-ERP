import type { LifecycleStatus } from '@bms/shared';
import { ValidationError } from '../../lib/errors.js';

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

// The lifecycle rule is shared with books, suppliers and customers (#96).
export { nextStatus } from '../../lib/lifecycle.js';

/**
 * A category cannot sit under itself or under one of its own subcategories.
 * `parentChain` is the proposed parent followed by its ancestors.
 */
export function checkCategoryParent(categoryId: number, parentChain: number[]): void {
  if (parentChain.includes(categoryId)) {
    throw new ValidationError('A category cannot be placed under itself or one of its subcategories', { field: 'parentId' });
  }
}
