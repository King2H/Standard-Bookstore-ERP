import type { LifecycleStatus } from '@bms/shared';
import { BusinessError } from './errors.js';

/**
 * The lifecycle shared by master data (authors, categories, publishers, books,
 * suppliers, customers): a pure rule (A5), applied by each module's service
 * inside its own transaction.
 */

export type LifecycleAction = 'ACTIVATE' | 'INACTIVATE' | 'ARCHIVE' | 'RESTORE';

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
