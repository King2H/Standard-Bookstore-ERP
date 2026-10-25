import type { LifecycleStatus } from '@bms/shared';

/** Pure rules of the services list (A5). */

/** The statuses a list filter names; active only when none is given. */
export function statusesFor(status: 'active' | 'inactive' | 'archived' | 'all' | undefined): LifecycleStatus[] | undefined {
  if (status === 'all') return undefined;
  if (status === 'inactive') return ['INACTIVE'];
  if (status === 'archived') return ['ARCHIVED'];
  return ['ACTIVE'];
}

/** Codes are unique ignoring case (owner decision 4a): kept in capitals. */
export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

// The lifecycle rule is shared with the catalog, suppliers and customers.
export { nextStatus } from '../../lib/lifecycle.js';
