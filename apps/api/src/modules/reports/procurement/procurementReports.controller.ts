import type { Request, Response } from 'express';
import {
  buildCsv, sendCsv,
  PROCUREMENT_COLUMNS, OPEN_POS_COLUMNS, SUPPLIER_BALANCES_COLUMNS, AP_AGING_COLUMNS,
  PURCHASES_BY_SUPPLIER_COLUMNS, PURCHASES_BY_BOOK_COLUMNS, SUPPLIER_PAYMENT_HISTORY_COLUMNS,
} from '../../../lib/csvBuilder.js';
import { reportFilters, reportQuery } from '../reportScope.js';
import * as service from './procurementReports.service.js';

/** HTTP side of the procurement reports (A3). Balances are as of now: they take the branch, not the range. */

export const schemas = { report: reportQuery };

const today = () => new Date().toISOString().slice(0, 10);

export async function exportLines(req: Request, res: Response): Promise<void> {
  const rows = await service.getProcurementLines(reportFilters(req));
  sendCsv(res, `procurement-report-${today()}.csv`, buildCsv(rows, PROCUREMENT_COLUMNS));
}

export async function openPurchaseOrders(req: Request, res: Response): Promise<void> {
  res.json(await service.getOpenPurchaseOrders(reportFilters(req).branchId));
}

export async function openPurchaseOrdersCsv(req: Request, res: Response): Promise<void> {
  const rows = (await service.getOpenPurchaseOrders(reportFilters(req).branchId)).map((r) => ({
    po_reference: r.poReference, supplier: r.supplier, order_date: r.orderDate, expected_date: r.expectedDate,
    ordered_qty: r.orderedQty, received_qty: r.receivedQty, total_amount: r.totalAmount,
    outstanding_amount: r.outstandingAmount, receipt_status: r.receiptStatus, payment_status: r.paymentStatus,
  }));
  sendCsv(res, `open-pos-${today()}.csv`, buildCsv(rows, OPEN_POS_COLUMNS));
}

export async function supplierBalances(req: Request, res: Response): Promise<void> {
  res.json(await service.getSupplierBalances(reportFilters(req).branchId));
}

export async function supplierBalancesCsv(req: Request, res: Response): Promise<void> {
  const rows = (await service.getSupplierBalances(reportFilters(req).branchId)).map((r) => ({
    supplier: r.supplier, open_po_count: r.openPoCount, received_value: r.receivedValue,
    paid: r.paid, credited: r.credited, outstanding_balance: r.outstandingBalance,
  }));
  sendCsv(res, `supplier-balances-${today()}.csv`, buildCsv(rows, SUPPLIER_BALANCES_COLUMNS));
}

export async function apAging(req: Request, res: Response): Promise<void> {
  res.json(await service.getApAging(reportFilters(req).branchId));
}

export async function apAgingCsv(req: Request, res: Response): Promise<void> {
  const rows = (await service.getApAging(reportFilters(req).branchId)).rows.map((r) => ({
    supplier: r.supplier, po_reference: r.poReference, outstanding_amount: r.outstandingAmount,
    aging_bucket: r.agingBucket, last_receipt_date: r.lastReceiptDate,
  }));
  sendCsv(res, `ap-aging-${today()}.csv`, buildCsv(rows, AP_AGING_COLUMNS));
}

export async function purchasesBySupplier(req: Request, res: Response): Promise<void> {
  res.json(await service.getPurchasesBySupplier(reportFilters(req)));
}

export async function purchasesBySupplierCsv(req: Request, res: Response): Promise<void> {
  const rows = (await service.getPurchasesBySupplier(reportFilters(req))).map((r) => ({
    supplier: r.supplier, po_count: r.poCount, ordered_value: r.orderedValue, received_value: r.receivedValue,
  }));
  sendCsv(res, `purchases-by-supplier-${today()}.csv`, buildCsv(rows, PURCHASES_BY_SUPPLIER_COLUMNS));
}

export async function purchasesByBook(req: Request, res: Response): Promise<void> {
  res.json(await service.getPurchasesByBook(reportFilters(req)));
}

export async function purchasesByBookCsv(req: Request, res: Response): Promise<void> {
  const rows = (await service.getPurchasesByBook(reportFilters(req))).map((r) => ({
    title: r.title, isbn: r.isbn, ordered_qty: r.orderedQty, received_qty: r.receivedQty, total_value: r.totalValue,
  }));
  sendCsv(res, `purchases-by-book-${today()}.csv`, buildCsv(rows, PURCHASES_BY_BOOK_COLUMNS));
}

export async function supplierPaymentHistory(req: Request, res: Response): Promise<void> {
  res.json(await service.getSupplierPaymentHistory(reportFilters(req)));
}

export async function supplierPaymentHistoryCsv(req: Request, res: Response): Promise<void> {
  const rows = (await service.getSupplierPaymentHistory(reportFilters(req))).map((r) => ({
    date: r.date, supplier: r.supplier, po_reference: r.poReference, amount: r.amount,
    payment_method: r.paymentMethod, source: r.source, user: r.user,
  }));
  sendCsv(res, `supplier-payment-history-${today()}.csv`, buildCsv(rows, SUPPLIER_PAYMENT_HISTORY_COLUMNS));
}
