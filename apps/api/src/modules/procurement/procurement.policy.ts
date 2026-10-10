import { Money } from '@bms/shared';
import { BranchAccessError, BusinessError, ValidationError } from '../../lib/errors.js';
import type { Actor, FinancialStatus, NewLine, PurchaseOrderRecord, PurchaseOrderStatus } from './procurement.types.js';

/**
 * Rules of purchase orders (A5), pure: who may act on an order, which status
 * allows what, and what an order is worth.
 */

const TOLERANCE = Money.of('0.01');

function invalidStatus(message: string): BusinessError {
  return new BusinessError('PO_INVALID_STATUS', message);
}

// ── Branches (owner decision 1a, #66) ─────────────────────────────────────────

/** Buying, approving, cancelling and closing are for the branch that ordered. */
export function checkOrderingBranch(po: Pick<PurchaseOrderRecord, 'branchId'>, actor: Actor): void {
  if (po.branchId !== actor.branchId) throw new BranchAccessError(po.branchId);
}

/** Goods are received by the branch that physically gets them. */
export function checkReceivingBranch(po: Pick<PurchaseOrderRecord, 'receivingBranchId'>, actor: Actor): void {
  if (po.receivingBranchId !== actor.branchId) throw new BranchAccessError(po.receivingBranchId);
}

// ── Value ─────────────────────────────────────────────────────────────────────

export function orderTotal(lines: Pick<NewLine, 'quantity' | 'unitCost'>[]): Money {
  return Money.sum(lines.map((l) => l.unitCost.times(l.quantity))).round(2);
}

/**
 * What the order owes is what was received; settled is paid plus credited.
 * Nothing received means nothing owed yet.
 */
export function financialStatus(receivedValue: Money, settled: Money): FinancialStatus {
  if (!receivedValue.greaterThan(TOLERANCE) || !settled.greaterThan(TOLERANCE)) return 'unpaid';
  return settled.lessThan(receivedValue.minus(TOLERANCE)) ? 'partial' : 'paid';
}

// ── Status ────────────────────────────────────────────────────────────────────

export function checkEditable(status: PurchaseOrderStatus): void {
  if (status !== 'draft') throw new BusinessError('PO_NOT_EDITABLE', 'Purchase Order can only be edited in draft status');
}

/** A draft goes for approval above the threshold, and is approved on submit below it. */
export function statusAfterSubmit(status: PurchaseOrderStatus, total: Money, threshold: Money): 'approved' | 'pending_approval' {
  if (status !== 'draft') throw invalidStatus('Purchase Order must be in draft status to submit for approval');
  return total.greaterThan(threshold) ? 'pending_approval' : 'approved';
}

/** Whoever created an order does not approve it (owner decision 2a). */
export function checkCanApprove(po: Pick<PurchaseOrderRecord, 'status' | 'createdBy'>, actor: Actor): void {
  if (po.status !== 'pending_approval') throw invalidStatus('Purchase Order must be in pending_approval status to approve');
  if (po.createdBy === actor.staffId) {
    throw new BusinessError('SELF_APPROVAL_NOT_ALLOWED', 'A purchase order is approved by someone other than the person who created it');
  }
}

export function checkCanOrder(status: PurchaseOrderStatus): void {
  if (status !== 'approved') throw invalidStatus('Purchase Order must be in approved status to mark as ordered');
}

/** Until anything arrives, an order can be cancelled, also once it was sent to the supplier (owner decision 3a). */
export function checkCanCancel(status: PurchaseOrderStatus, hasReceipts: boolean): void {
  if (!['draft', 'pending_approval', 'approved', 'ordered'].includes(status)) {
    throw invalidStatus('Purchase Order cannot be cancelled in its current status');
  }
  if (hasReceipts) throw new BusinessError('CANNOT_CANCEL_WITH_RECEIPTS', 'Cannot cancel a Purchase Order that has receipts');
}

/**
 * A received order closes; a part-received one closes short, with a reason,
 * when the supplier will not deliver the rest (owner decision 3a).
 */
export function checkCanClose(status: PurchaseOrderStatus, reason: string | null): void {
  if (status === 'received') return;
  if (status !== 'partially_received') throw invalidStatus('Purchase Order must be received or partially received to close');
  if (!reason) {
    throw new ValidationError('A reason is required to close a purchase order before everything was received', { field: 'reason' });
  }
}

export function checkCanReceive(status: PurchaseOrderStatus): void {
  if (!['approved', 'ordered', 'partially_received'].includes(status)) {
    throw invalidStatus('Purchase Order must be approved, ordered, or partially_received to receive goods');
  }
}

/** One received line: it belongs to the order and does not take more than is still expected. */
export function checkReceiptLine(
  line: { poId: string; quantity: number; receivedQuantity: number },
  poId: string,
  lineId: number,
  quantity: number,
): void {
  if (line.poId !== poId) throw new BusinessError('LINE_ITEM_MISMATCH', `Line item ${lineId} does not belong to this PO`);
  if (line.receivedQuantity + quantity > line.quantity) {
    throw new BusinessError(
      'OVER_RECEIPT',
      `Cannot receive more than ordered. Ordered: ${line.quantity}, Already received: ${line.receivedQuantity}, Attempting: ${quantity}`,
    );
  }
}

export function statusAfterReceipt(lines: Array<{ quantity: number; receivedQuantity: number }>): 'received' | 'partially_received' {
  return lines.every((l) => l.receivedQuantity >= l.quantity) ? 'received' : 'partially_received';
}
