import { Money, type Receivable, type ReceivableSummary } from '@bms/shared';
import type { ReceivableRecord, ReceivableSourceType, ReceivableStatus, ReceivableSummaryRecord } from './receivables.types.js';

/** The columns receivables.repository selects. */
export interface ReceivableRow {
  id: string | number | bigint;
  source_type: string;
  source_ref_id: string;
  source_entity_id: string | number | bigint;
  customer_id: number;
  customer_name: string | null;
  customer_code: string | null;
  branch_id: number;
  original_amount: string;
  outstanding_amount: string;
  currency: string;
  /** TO_CHAR'd in SQL: a DATE read as a JS Date shifts a day in some time zones. */
  due_date: string | null;
  settlement_date: Date | null;
  status: string;
  notes: string | null;
  written_off_amount: string | null;
  written_off_at: Date | null;
  written_off_by: number | null;
  write_off_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

// The database CHECK constraints limit source_type and status to the enum values.
export function toReceivableRecord(row: ReceivableRow): ReceivableRecord {
  return {
    id: String(row.id),
    sourceType: row.source_type as ReceivableSourceType,
    sourceRefId: row.source_ref_id,
    sourceEntityId: String(row.source_entity_id),
    customerId: row.customer_id,
    customerName: row.customer_name,
    customerCode: row.customer_code,
    branchId: row.branch_id,
    originalAmount: Money.of(row.original_amount),
    outstandingAmount: Money.of(row.outstanding_amount),
    currency: row.currency,
    dueDate: row.due_date,
    settlementDate: row.settlement_date,
    status: row.status as ReceivableStatus,
    notes: row.notes,
    writtenOffAmount: row.written_off_amount === null ? null : Money.of(row.written_off_amount),
    writtenOffAt: row.written_off_at,
    writtenOffBy: row.written_off_by,
    writeOffReason: row.write_off_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toReceivableResponse(r: ReceivableRecord): Receivable {
  return {
    ...r,
    originalAmount: r.originalAmount.toNumber(),
    outstandingAmount: r.outstandingAmount.toNumber(),
    settlementDate: r.settlementDate?.toISOString() ?? null,
    writtenOffAmount: r.writtenOffAmount?.toNumber() ?? null,
    writtenOffAt: r.writtenOffAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function toSummaryResponse(s: ReceivableSummaryRecord): ReceivableSummary {
  return { ...s, totalOutstanding: s.totalOutstanding.toNumber() };
}
