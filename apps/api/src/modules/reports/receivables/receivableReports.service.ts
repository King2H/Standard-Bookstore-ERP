import { Money, type ReceivablesAging } from '@bms/shared';
import { reportDb } from '../../../db/reportDb.js';
import type { ReportScope } from '../reportScope.js';
import * as policy from './receivableReports.policy.js';
import * as receivables from './receivableReports.repository.js';

/** Receivables report use cases (#22), read on the report connection. */

export interface ReceivableExportRow {
  order_reference: string;
  date: string;
  customer_name: string;
  original_amount: number;
  collected_amount: number;
  outstanding_amount: number;
  due_date: string;
  days_overdue: number;
  payment_status: string;
}

/** Open balances by age now; the date range does not apply to a balance. */
export async function getAging(branchId: number | undefined): Promise<ReceivablesAging> {
  const rows = (await receivables.openReceivables(reportDb, branchId)).map((r) => ({
    customer: r.customer_name,
    invoiceNo: r.invoice_no,
    invoiceDate: r.invoice_date,
    dueDate: r.due_date_str ?? '',
    outstandingAmount: Money.of(r.outstanding_amount).toNumber(),
    agingBucket: policy.agingBucket(r.days_overdue),
    lastPaymentDate: r.last_payment_date_str ?? '',
  }));
  return { rows, byBucket: policy.byBucket(rows) };
}

export async function getReceivableExportRows(scope: ReportScope): Promise<ReceivableExportRow[]> {
  const rows = await receivables.receivablesRaised(reportDb, scope);
  return rows.map((row) => ({
    order_reference: row.order_reference as string,
    date: row.date_str as string,
    customer_name: row.customer_name as string,
    original_amount: Money.of(row.original_amount as string).toNumber(),
    // A write-off, a cancelled sale or a return closes the balance without collecting it.
    collected_amount: Money.of(row.original_amount as string)
      .minus(row.outstanding_amount as string)
      .minus(row.closed_amount as string)
      .toNumber(),
    outstanding_amount: Money.of(row.outstanding_amount as string).toNumber(),
    due_date: (row.due_date_str as string | null) ?? '',
    days_overdue: (row.days_overdue as number | null) ?? 0,
    payment_status: row.payment_status as string,
  }));
}
