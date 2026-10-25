import type { LifecycleStatus, Money, ServiceKind } from '@bms/shared';
import type { LifecycleAction } from '../../lib/lifecycle.js';

export type { LifecycleAction };

/** The signed-in staff member; the branch is the session's. */
export interface Actor {
  staffId: number;
  role: string;
  branchId: number;
}

/** A service as the session branch sees it: its own fee, if any, and the shop's. */
export interface ServiceRecord {
  id: number;
  code: string;
  name: string;
  kind: ServiceKind;
  formatId: number | null;
  formatLabel: string | null;
  fee: Money;
  branchFee: Money | null;
  standardCost: Money;
  discountable: boolean;
  turnaroundDays: number;
  status: LifecycleStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** A service's own fields, as written. */
export interface ServiceFields {
  code: string;
  name: string;
  kind: ServiceKind;
  formatId: number;
  fee: Money;
  standardCost: Money;
  discountable: boolean;
  turnaroundDays: number;
}

export interface ServiceFilter {
  q?: string;
  /** Undefined lists every status. */
  statuses?: LifecycleStatus[];
}

export type Paging = { page: number; pageSize: number };
