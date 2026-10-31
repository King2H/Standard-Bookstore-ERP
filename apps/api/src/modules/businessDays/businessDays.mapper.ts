import type { BusinessDay, BusinessDayDetail, BusinessMonth, BusinessMonthDetail } from '@bms/shared';
import type { BusinessDayRecord, BusinessMonthRecord } from './businessDays.types.js';

/** Records to the shared contract (A3): dates as ISO strings; reports are kept as the contract has them. */

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function closing(r: BusinessDayRecord | BusinessMonthRecord) {
  return {
    status: r.status,
    closedBy: r.closedBy,
    closedByName: r.closedByName,
    closedAt: r.closedAt.toISOString(),
    reopenedBy: r.reopenedBy,
    reopenedByName: r.reopenedByName,
    reopenedAt: iso(r.reopenedAt),
    reopenReason: r.reopenReason,
  };
}

export function toBusinessDay(d: BusinessDayRecord): BusinessDay {
  return { id: d.id, branchId: d.branchId, branchName: d.branchName, day: d.day, dayNumber: d.dayNumber, ...closing(d) };
}

export function toBusinessDayDetail(d: BusinessDayRecord): BusinessDayDetail {
  return { ...toBusinessDay(d), report: d.report };
}

export function toBusinessMonth(m: BusinessMonthRecord): BusinessMonth {
  return { id: m.id, month: m.month, ...closing(m) };
}

export function toBusinessMonthDetail(m: BusinessMonthRecord): BusinessMonthDetail {
  return { ...toBusinessMonth(m), summary: m.summary };
}
