import type { ProfileResponse, PurchaseOrder, SupplierReturnStatus } from '@bms/shared';

/**
 * Who may do what with a return to supplier: the API's rules
 * (supplierReturns.routes.ts and .service.ts), any role held in the session
 * branch (#173, decision 5a). The receiving branch, where the copies are,
 * drafts and sends.
 */
type Account = Pick<ProfileResponse, 'currentRoles' | 'currentBranchId'>;

const holds = (me: Account | undefined, allowed: string[]) => (me?.currentRoles ?? []).some((r) => allowed.includes(r));

/** Drafting, editing and cancelling a draft: Admin, Manager and Purchasor of the receiving branch. */
export const canDraft = (me: Account | undefined, branchId: number) => holds(me, ['Admin', 'Manager', 'Purchasor']) && me?.currentBranchId === branchId;

/** Sending: SEND_SUPPLIER_RETURN, which Admin and Manager hold. */
export const canSend = (me: Account | undefined, branchId: number) => holds(me, ['Admin', 'Manager']) && me?.currentBranchId === branchId;

/** Copies of each order line that can still go back: what arrived less what went back. */
export const returnable = (line: Pick<NonNullable<PurchaseOrder['lineItems']>[number], 'receivedQuantity' | 'returnedQuantity'>) =>
  Math.max(0, line.receivedQuantity - line.returnedQuantity);

/** A return can be drafted on the order while some received copy has not gone back. */
export const canReturnOrder = (po: PurchaseOrder, me: Account | undefined) =>
  canDraft(me, po.receivingBranchId) && (po.lineItems ?? []).some((l) => returnable(l) > 0);

export const STATUS_LABELS: Record<SupplierReturnStatus, string> = { draft: 'Draft', sent: 'Sent', cancelled: 'Cancelled' };

export const STATUS_CLASSES: Record<SupplierReturnStatus, string> = {
  draft: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  sent: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  cancelled: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
};
