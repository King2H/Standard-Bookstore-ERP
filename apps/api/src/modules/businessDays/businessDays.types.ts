import type { DayReport, MonthSummary } from '@bms/shared';

export type { DayReport, MonthSummary };

/** The signed-in staff member. */
export interface Actor {
  staffId: number;
  role: string;
  /** Every role held in the session branch. */
  roles: string[];
  branchId: number;
}

interface Closing {
  status: 'closed' | 'reopened';
  closedBy: number;
  closedByName: string;
  closedAt: Date;
  reopenedBy: number | null;
  reopenedByName: string | null;
  reopenedAt: Date | null;
  reopenReason: string | null;
}

export interface BusinessDayRecord extends Closing {
  id: number;
  branchId: number;
  branchName: string;
  /** YYYY-MM-DD */
  day: string;
  dayNumber: string;
  report: DayReport;
}

export interface BusinessMonthRecord extends Closing {
  id: number;
  /** YYYY-MM */
  month: string;
  summary: MonthSummary;
}

/** A day's figures as the database sums them: amounts are decimal strings. */
export interface DayFigures {
  orders: { count: number; total: string };
  pos: { count: number; total: string };
  exchanges: number;
  money: Array<{ method: string; in: string; out: string }>;
  returns: { count: number; refunded: string };
  stock: Array<{ reason: string; in: number; out: number }>;
  cash: Array<{ id: number; zNumber: string | null; staffName: string; expected: string; counted: string; variance: string }>;
}

export interface OpenCashSession {
  id: number;
  staffName: string;
  status: string;
}

export interface BranchDays {
  branchId: number;
  branchName: string;
  days: string[];
}

/** A day as it stands, before or after it closes. */
export interface DayPreview {
  branchId: number;
  day: string;
  status: 'open' | 'closed' | 'reopened';
  businessDayId: number | null;
  openCashSessions: OpenCashSession[];
  monthClosed: boolean;
  report: DayReport;
}

/** A month as it stands, before or after it closes. */
export interface MonthPreview {
  month: string;
  status: 'open' | 'closed' | 'reopened';
  businessMonthId: number | null;
  ended: boolean;
  openDays: BranchDays[];
  summary: MonthSummary;
}
