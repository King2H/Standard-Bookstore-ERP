import type { LifecycleStatus, Money, ServiceJobStatus, ServiceKind } from '@bms/shared';
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

// ── Services on a sale (#169 PR 2) ───────────────────────────────────────────

export type { ServiceJobStatus, ServiceJobStep, ServiceLineInput } from '@bms/shared';

/** A service as a sale in a branch charges it: the branch's fee, else the shop's. */
export interface ServiceForSale {
  id: number;
  code: string;
  name: string;
  status: LifecycleStatus;
  fee: Money;
  standardCost: Money;
  discountable: boolean;
  turnaroundDays: number;
}

/** A service line priced for a book line, ready to be written. */
export interface PricedServiceLine {
  serviceId: number;
  quantity: number;
  unitFee: Money;
  discountPct: number;
  discountAmount: Money;
  lineTotal: Money;
  standardCost: Money;
  turnaroundDays: number;
}

export interface ServiceJobRecord {
  id: number;
  jobNumber: string;
  status: ServiceJobStatus;
  readyDate: string;
  customerId: number;
  branchId: number;
  updatedAt: Date;
}

/** A service line as its sale recorded it, with its job (none on a draft order). */
export interface SaleServiceLineRecord {
  id: number;
  /** The book line it belongs to: a counter sale's or an order's. */
  posLineId: string | null;
  orderLineId: string | null;
  serviceId: number;
  serviceCode: string;
  serviceName: string;
  quantity: number;
  unitFee: Money;
  discountAmount: Money;
  lineTotal: Money;
  standardCost: Money;
  turnaroundDays: number;
  job: ServiceJobRecord | null;
}

/** The sale a set of service lines belongs to. */
export type SaleRef = { transactionId: string } | { orderId: string };
