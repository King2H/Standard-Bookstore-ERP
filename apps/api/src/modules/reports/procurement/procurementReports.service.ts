import { Money } from '@bms/shared';
import { reportDb } from '../../../db/reportDb.js';
import type { ReportScope } from '../reportScope.js';
import { agingBucket, byBucket } from '../receivables/receivableReports.policy.js';
import * as procurement from './procurementReports.repository.js';

/** Procurement report use cases (#22), read on the report connection. */

const amount = (value: unknown) => Money.of((value ?? 0) as string).toNumber();

export async function getProcurementLines(scope: ReportScope) {
  const rows = await procurement.procurementLines(reportDb, scope);
  return rows.map((row) => ({
    po_reference: row.po_reference as string,
    date: row.date_str as string,
    supplier_name: row.supplier_name as string,
    status: row.status as string,
    book_code: (row.book_code as string | null) ?? '',
    title: row.title as string,
    ordered_quantity: row.ordered_quantity as number,
    received_quantity: row.received_quantity as number,
    unit_cost: amount(row.unit_cost),
    line_total: amount(row.line_total),
    po_total: amount(row.total_amount),
  }));
}

export async function getOpenPurchaseOrders(branchId: number | undefined) {
  const rows = await procurement.openPurchaseOrders(reportDb, branchId);
  return rows.map((row) => ({
    poReference: row.po_reference as string,
    supplier: row.supplier_name as string,
    orderDate: row.order_date as string,
    expectedDate: (row.expected_date as string | null) ?? '',
    orderedQty: row.ordered_qty as number,
    receivedQty: row.received_qty as number,
    totalAmount: amount(row.total_amount),
    outstandingAmount: amount(row.outstanding_amount),
    receiptStatus: row.status as string,
    paymentStatus: row.financial_status as string,
  }));
}

export async function getSupplierBalances(branchId: number | undefined) {
  const rows = await procurement.supplierBalances(reportDb, branchId);
  return rows.map((row) => {
    const receivedValue = Money.of(row.received_value);
    const paid = Money.of(row.paid);
    const credited = Money.of(row.credited);
    return {
      supplierId: row.supplier_id,
      supplier: row.supplier_name,
      openPoCount: row.open_po_count,
      receivedValue: receivedValue.toNumber(),
      paid: paid.toNumber(),
      credited: credited.toNumber(),
      outstandingBalance: receivedValue.minus(paid).minus(credited).toNumber(),
    };
  });
}

/** What is owed to suppliers, by days since the goods arrived; settled POs and those with nothing received are left out. */
export async function getApAging(branchId: number | undefined) {
  const owed = await procurement.payables(reportDb, branchId);
  const rows = owed
    .filter((row) => Money.of(row.outstanding_amount).greaterThan('0.01'))
    .map((row) => ({
      supplier: row.supplier_name,
      poReference: row.po_reference,
      outstandingAmount: amount(row.outstanding_amount),
      agingBucket: agingBucket(row.days_since_receipt ?? 0),
      lastReceiptDate: row.last_receipt_date ?? '',
    }));
  return { rows, byBucket: byBucket(rows) };
}

export async function getPurchasesBySupplier(scope: ReportScope) {
  const rows = await procurement.purchasesBySupplier(reportDb, scope);
  return rows.map((row) => ({
    supplierId: row.supplier_id,
    supplier: row.supplier_name,
    poCount: row.po_count,
    orderedValue: amount(row.ordered_value),
    receivedValue: amount(row.received_value),
  }));
}

export async function getPurchasesByBook(scope: ReportScope) {
  const rows = await procurement.purchasesByBook(reportDb, scope);
  return rows.map((row) => ({
    bookId: row.book_id,
    title: row.title,
    isbn: row.isbn ?? '',
    orderedQty: row.ordered_qty,
    receivedQty: row.received_qty,
    totalValue: amount(row.total_value),
  }));
}

export async function getSupplierPaymentHistory(scope: ReportScope) {
  const rows = await procurement.supplierPayments(reportDb, scope);
  return rows.map((row) => ({
    date: row.date_str,
    supplier: row.supplier_name,
    poReference: row.po_reference,
    amount: amount(row.amount),
    paymentMethod: row.payment_method,
    source: row.source,
    user: row.staff_username ?? '',
  }));
}
