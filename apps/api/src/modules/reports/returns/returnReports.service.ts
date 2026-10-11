import { Money, type ReturnReportRow } from '@bms/shared';
import { reportDb } from '../../../db/reportDb.js';
import type { ReportScope } from '../reportScope.js';
import * as returns from './returnReports.repository.js';

/** Return report use cases (#22), read on the report connection. */

export async function getReturnRows(scope: ReportScope): Promise<ReturnReportRow[]> {
  const rows = await returns.returnLines(reportDb, scope);
  return rows.map((row) => {
    const qty = row.quantity as number;
    const refund = Money.of(row.line_refund_amount as string);
    const originalCost = Money.of((row.resolved_unit_cost ?? 0) as string).times(qty).round(2);
    return {
      returnNo: row.return_number as string,
      originalInvoiceNo: (row.original_invoice_no as string | null) ?? '',
      customer: row.customer_name as string,
      book: row.book_title as string,
      qtyReturned: qty,
      refundAmount: refund.toNumber(),
      originalCost: originalCost.toNumber(),
      profitReversed: refund.minus(originalCost).toNumber(),
      refundMethod: row.refund_method as string,
      returnDate: row.return_date as string,
      user: (row.staff_username as string | null) ?? '',
    };
  });
}

export async function getTopReturned(scope: ReportScope, limit: number) {
  const rows = await returns.topReturned(reportDb, scope, limit);
  return rows.map((r) => ({ bookId: r.book_id, title: r.title, unitsReturned: r.units_returned, refundValue: Money.of(r.refund_value).toNumber() }));
}
