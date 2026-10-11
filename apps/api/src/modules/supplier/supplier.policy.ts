import type { LifecycleStatus, SupplierListQuery, SupplierType } from '@bms/shared';
import { BusinessError, ConflictError } from '../../lib/errors.js';
import { nextStatus, type LifecycleAction } from '../../lib/lifecycle.js';

/**
 * Supplier rules as pure functions (A5): no I/O, so they are unit-tested
 * without a database (__tests__/supplier.policy.test.ts).
 */

/** A publisher supplier names its publisher; an external supplier must not. */
export function checkSupplierType(supplierType: SupplierType, publisherId: number | null): void {
  if (supplierType === 'publisher' && publisherId === null) {
    throw new BusinessError('PUBLISHER_ID_REQUIRED', 'publisher_id is required when supplier_type is publisher');
  }
  if (supplierType === 'external' && publisherId !== null) {
    throw new BusinessError('PUBLISHER_ID_NOT_ALLOWED', 'publisher_id must not be set when supplier_type is external');
  }
}

/**
 * Type and publisher after an update that may change either of them, so the
 * pair can be checked as a whole. Null when the update changes neither.
 */
export function typeAfterUpdate(
  current: { supplierType: SupplierType; publisherId: number | null },
  changes: { supplierType?: SupplierType; publisherId?: number | null },
): { supplierType: SupplierType; publisherId: number | null } | null {
  if (changes.supplierType === undefined && changes.publisherId === undefined) return null;
  return {
    supplierType: changes.supplierType ?? current.supplierType,
    publisherId: changes.publisherId !== undefined ? changes.publisherId : current.publisherId,
  };
}

export type { LifecycleAction } from '../../lib/lifecycle.js';

/**
 * The state a lifecycle action leads to, by the rule shared with the catalog
 * (#96); null when the supplier already has it. is_active follows the status
 * because procurement still checks is_active.
 */
export function lifecycleTransition(
  current: LifecycleStatus,
  action: LifecycleAction,
): { status: LifecycleStatus; isActive: boolean; archived: boolean } | null {
  const status = nextStatus(current, action);
  if (status === null) return null;
  return { status, isActive: status === 'ACTIVE', archived: status === 'ARCHIVED' };
}

/** The statuses a list request asks for; undefined means any status. */
export function statusesFor(choice: NonNullable<SupplierListQuery['status']>): LifecycleStatus[] | undefined {
  switch (choice) {
    case 'all':
      return undefined;
    case 'inactive':
      return ['INACTIVE'];
    case 'archived':
      return ['ARCHIVED'];
    case 'active':
      return ['ACTIVE'];
  }
}

/** New purchase orders need a supplier that is active and not blacklisted. */
export function checkUsableForProcurement(supplier: { isActive: boolean; isBlacklisted: boolean }): void {
  if (!supplier.isActive) {
    throw new BusinessError('SUPPLIER_INACTIVE', 'Supplier is inactive and cannot be used for procurement');
  }
  if (supplier.isBlacklisted) {
    throw new BusinessError('SUPPLIER_BLACKLISTED', 'Supplier is blacklisted and cannot be used for procurement');
  }
}

/** A supplier with purchase orders is kept for their history; archive it instead. */
export function checkDeletable(usage: { purchaseOrders: number }): void {
  if (usage.purchaseOrders > 0) {
    throw new ConflictError('DEPENDENCY_CONFLICT', 'Supplier has associated purchase orders', {
      poCount: usage.purchaseOrders,
    });
  }
}
