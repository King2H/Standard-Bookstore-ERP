import type { StockCount, StockCountDetail } from '@bms/shared';
import * as policy from './stockCounts.policy.js';
import type { StockCountRecord, StockCountView } from './stockCounts.types.js';

/** Records to the shared contract (A3): dates as ISO strings, money as numbers; a blind count shows no expected quantity. */

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toStockCount(c: StockCountRecord): StockCount {
  return {
    id: c.id, countNumber: c.countNumber, branchId: c.branchId, locationId: c.locationId, locationName: c.locationName,
    scope: c.scope, status: c.status, notes: c.notes, createdBy: c.createdBy, createdByName: c.createdByName,
    createdAt: c.createdAt.toISOString(), submittedAt: iso(c.submittedAt), postedBy: c.postedBy, postedByName: c.postedByName,
    postedAt: iso(c.postedAt), cancelledAt: iso(c.cancelledAt), cancelReason: c.cancelReason,
    lineCount: c.lineCount, countedLines: c.countedLines,
  };
}

export function toStockCountDetail(c: StockCountView): StockCountDetail {
  const totals = policy.totals(c.lines);
  return {
    ...toStockCount(c),
    totals: c.blind ? null : {
      overQuantity: totals.overQuantity, shortQuantity: totals.shortQuantity,
      overValue: totals.overValue.toNumber(), shortValue: totals.shortValue.toNumber(),
    },
    lines: c.lines.map((l) => ({
      id: l.id,
      bookId: l.bookId,
      bookTitle: l.bookTitle,
      isbn: l.isbn,
      frozenQuantity: c.blind ? null : l.frozenQuantity,
      expectedQuantity: c.blind ? null : l.expectedQuantity,
      countedQuantity: l.countedQuantity,
      difference: c.blind ? null : policy.difference(l),
      differenceValue: c.blind ? null : policy.differenceValue(l)?.toNumber() ?? null,
      countedBy: l.countedBy,
      countedByName: l.countedByName,
      countedAt: iso(l.countedAt),
      previousCounts: l.counts.slice(0, -1),
      recountRequested: l.recountRequested,
      postedDelta: l.postedDelta,
      postedUnitCost: l.postedUnitCost?.toNumber() ?? null,
    })),
  };
}
