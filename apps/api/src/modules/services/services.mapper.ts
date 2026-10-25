import { Money, type LifecycleStatus, type Service, type ServiceKind } from '@bms/shared';
import type { ServiceRecord } from './services.types.js';

/** The columns services.repository selects. */
export interface ServiceRow {
  id: number;
  code: string;
  name: string;
  kind: string;
  format_id: number | null;
  format_label: string | null;
  fee: string;
  branch_fee: string | null;
  standard_cost: string;
  discountable: boolean;
  turnaround_days: number;
  status: string;
  created_at: Date;
  updated_at: Date;
}

// The database CHECK constraints limit kind and status to these values.
export function toServiceRecord(row: ServiceRow): ServiceRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    kind: row.kind as ServiceKind,
    formatId: row.format_id,
    formatLabel: row.format_label,
    fee: Money.of(row.fee),
    branchFee: row.branch_fee === null ? null : Money.of(row.branch_fee),
    standardCost: Money.of(row.standard_cost),
    discountable: row.discountable,
    turnaroundDays: row.turnaround_days,
    status: row.status as LifecycleStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toServiceResponse(r: ServiceRecord): Service {
  return {
    ...r,
    fee: r.fee.toNumber(),
    branchFee: r.branchFee?.toNumber() ?? null,
    effectiveFee: (r.branchFee ?? r.fee).toNumber(),
    standardCost: r.standardCost.toNumber(),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
