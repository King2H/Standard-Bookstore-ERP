import type { CashSession, CashSessionDetail } from '@bms/shared';
import type { CashSessionRecord, CashSessionView } from './cashSessions.types.js';

/** Records to the shared contract (A3): dates as ISO strings, money as numbers. */

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toCashSession(s: CashSessionRecord): CashSession {
  return {
    id: s.id,
    branchId: s.branchId,
    branchName: s.branchName,
    staffId: s.staffId,
    staffName: s.staffName,
    status: s.status,
    currency: s.currency,
    openingFloat: s.openingFloat.toNumber(),
    openedAt: s.openedAt.toISOString(),
    expectedCash: s.expectedCash?.toNumber() ?? null,
    countedCash: s.countedCash?.toNumber() ?? null,
    variance: s.variance?.toNumber() ?? null,
    closeNote: s.closeNote,
    closedBy: s.closedBy,
    closedByName: s.closedByName,
    closedAt: iso(s.closedAt),
    reviewedBy: s.reviewedBy,
    reviewedByName: s.reviewedByName,
    reviewedAt: iso(s.reviewedAt),
    reviewReason: s.reviewReason,
    zNumber: s.zNumber,
  };
}

export function toCashSessionDetail(s: CashSessionView): CashSessionDetail {
  return {
    ...toCashSession(s),
    totals: s.totals?.map((t) => ({ ...t, amount: t.amount.toNumber() })) ?? null,
    movements: s.movements.map((m) => ({ ...m, amount: m.amount.toNumber(), createdAt: m.createdAt.toISOString() })),
  };
}
