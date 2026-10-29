import type { CashMovementCategory, CashMovementKind, CashSessionStatus, Money } from '@bms/shared';

export type { CashMovementCategory, CashMovementKind, CashSessionStatus };

/** The signed-in staff member. */
export interface Actor {
  staffId: number;
  role: string;
  /** Every role held in the session branch. */
  roles: string[];
  branchId: number;
}

export interface CashSessionRecord {
  id: number;
  branchId: number;
  branchName: string;
  staffId: number;
  staffName: string;
  status: CashSessionStatus;
  currency: string;
  openingFloat: Money;
  openedAt: Date;
  expectedCash: Money | null;
  countedCash: Money | null;
  variance: Money | null;
  closeNote: string | null;
  closedBy: number | null;
  closedByName: string | null;
  closedAt: Date | null;
  zNumber: string | null;
  reviewedBy: number | null;
  reviewedByName: string | null;
  reviewedAt: Date | null;
  reviewReason: string | null;
}

export interface CashMovementRecord {
  id: number;
  kind: CashMovementKind;
  sourceId: string | null;
  method: string;
  direction: 'in' | 'out';
  amount: Money;
  category: CashMovementCategory | null;
  reason: string | null;
  staffId: number;
  staffName: string;
  createdAt: Date;
}

export interface CashTotal {
  kind: CashMovementKind;
  method: string;
  direction: 'in' | 'out';
  count: number;
  amount: Money;
}

/**
 * A session as its viewer may see it: expected cash and the totals hidden
 * from its own staff member while it is open (null), and then only the
 * cash they put in or took out by hand.
 */
export interface CashSessionView extends CashSessionRecord {
  totals: CashTotal[] | null;
  movements: CashMovementRecord[];
}

/**
 * Money a counter flow took or gave back, recorded on the open session.
 * `reverses` names the movement it undoes (a void): it goes to the session
 * that recorded that one while that session is open.
 */
export interface CounterMoney {
  kind: Exclude<CashMovementKind, 'pay_in' | 'pay_out'>;
  sourceId: string;
  method: string;
  direction: 'in' | 'out';
  amount: Money;
  reverses?: { kind: CashMovementKind; sourceId: string };
}

export interface CashMovementInput {
  direction: 'in' | 'out';
  category: CashMovementCategory;
  amount: Money;
  reason: string;
}

export interface CashSessionFilter {
  branchId: number | null;
  /** Set to the viewer's own id when they may not see others'. */
  staffId?: number;
  status?: CashSessionStatus;
  dateFrom?: string;
  dateTo?: string;
}

export interface Paging {
  page: number;
  pageSize: number;
}
