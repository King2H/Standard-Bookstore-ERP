import { Money } from '@bms/shared';
import { BranchAccessError, BusinessError } from '../../lib/errors.js';
import type { Actor, LineCounts, TransferOutcome, TransferRecord, TransferStatus } from './transfers.types.js';

/**
 * Rules of transfers between branches (A5), pure (#170, owner decisions
 * 1a–4a, 2026-10-26): which branch does what, which status allows what, what
 * is still on the way and what it is worth.
 */

function invalidStatus(message: string): BusinessError {
  return new BusinessError('TRANSFER_INVALID_STATUS', message);
}

// ── Branches (decision 2a) ────────────────────────────────────────────────────

/** Drafting, editing, cancelling and dispatching are the sending branch's. */
export function checkSendingBranch(transfer: Pick<TransferRecord, 'fromBranchId'>, actor: Pick<Actor, 'branchId'>): void {
  if (transfer.fromBranchId !== actor.branchId) throw new BranchAccessError(transfer.fromBranchId);
}

/** Receiving is the receiving branch's, into its own locations. */
export function checkReceivingBranch(transfer: Pick<TransferRecord, 'toBranchId'>, actor: Pick<Actor, 'branchId'>): void {
  if (transfer.toBranchId !== actor.branchId) throw new BranchAccessError(transfer.toBranchId);
}

/**
 * Lost and damaged are said by the branch that was to receive the copies;
 * returned by the branch they come back to (decision 4a).
 */
export function checkResolverBranch(
  transfer: Pick<TransferRecord, 'fromBranchId' | 'toBranchId'>,
  actor: Pick<Actor, 'branchId'>,
  outcome: TransferOutcome,
): void {
  if (outcome === 'returned') checkSendingBranch(transfer, actor);
  else checkReceivingBranch(transfer, actor);
}

// ── Status (decision 1a) ──────────────────────────────────────────────────────

export function checkEditable(status: TransferStatus): void {
  if (status !== 'draft') throw invalidStatus('Only a draft transfer can be changed or cancelled');
}

export function checkCanDispatch(status: TransferStatus): void {
  if (status !== 'draft') throw invalidStatus('Only a draft transfer can be dispatched');
}

/** Copies are received or resolved while some are still on the way. */
export function checkCanReceive(status: TransferStatus): void {
  if (status !== 'in_transit' && status !== 'partially_received') {
    throw invalidStatus('Only a transfer on its way can be received or resolved');
  }
}

/**
 * After a receipt or a resolution: received when every copy arrived; closed
 * when every copy is accounted for and some did not arrive; otherwise on the
 * way, partly received once anything was received or resolved.
 */
export function statusAfter(lines: LineCounts[]): Exclude<TransferStatus, 'draft' | 'cancelled'> {
  if (lines.every((l) => l.receivedQuantity === l.quantity)) return 'received';
  if (lines.every((l) => outstanding(l) === 0)) return 'closed';
  return lines.some((l) => outstanding(l) < l.quantity) ? 'partially_received' : 'in_transit';
}

// ── Quantities and value (decision 3a) ────────────────────────────────────────

/** Copies sent and not yet received or resolved. */
export function outstanding(line: LineCounts): number {
  return line.quantity - line.receivedQuantity - line.lostQuantity - line.damagedQuantity - line.returnedQuantity;
}

export function checkWithinOutstanding(line: LineCounts, quantity: number): void {
  const left = outstanding(line);
  if (quantity > left) {
    throw new BusinessError('TRANSFER_OVER_OUTSTANDING', `Only ${left} of ${line.quantity} copies are still on the way`, {
      outstanding: left,
      requested: quantity,
    });
  }
}

/** What is on the way, at the cost it left at; nothing before dispatch. */
export function inTransitValue(lines: LineCounts[]): Money {
  return Money.sum(lines.map((l) => (l.unitCost ? l.unitCost.times(outstanding(l)) : Money.ZERO))).round(2);
}
