import type { Transfer, TransferSummary } from '@bms/shared';
import { outstanding } from './transfers.policy.js';
import type { TransferLineRecord, TransferRecord, TransferView } from './transfers.types.js';

/** Records to the shared contract (A3): dates as ISO strings, money as numbers. */

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toTransferSummary(t: TransferRecord): TransferSummary {
  return {
    id: t.id,
    transferNumber: t.transferNumber,
    fromBranchId: t.fromBranchId,
    fromBranchName: t.fromBranchName,
    fromLocationId: t.fromLocationId,
    fromLocationName: t.fromLocationName,
    toBranchId: t.toBranchId,
    toBranchName: t.toBranchName,
    status: t.status,
    notes: t.notes,
    inTransitValue: t.inTransitValue.toNumber(),
    totalQuantity: t.totalQuantity,
    createdBy: t.createdBy,
    createdByName: t.createdByName,
    createdAt: t.createdAt.toISOString(),
    dispatchedBy: t.dispatchedBy,
    dispatchedAt: iso(t.dispatchedAt),
    cancelledBy: t.cancelledBy,
    cancelledAt: iso(t.cancelledAt),
    completedAt: iso(t.completedAt),
  };
}

function toLine(l: TransferLineRecord) {
  return {
    id: l.id,
    bookId: l.bookId,
    bookTitle: l.bookTitle,
    isbn: l.isbn,
    quantity: l.quantity,
    unitCost: l.unitCost ? l.unitCost.toNumber(4) : null,
    receivedQuantity: l.receivedQuantity,
    lostQuantity: l.lostQuantity,
    damagedQuantity: l.damagedQuantity,
    returnedQuantity: l.returnedQuantity,
    // Nothing is on the way before dispatch.
    outstandingQuantity: l.unitCost === null ? 0 : outstanding(l),
  };
}

export function toTransferResponse(t: TransferView): Transfer {
  return {
    ...toTransferSummary(t),
    lines: t.lines.map(toLine),
    events: t.events.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
  };
}
