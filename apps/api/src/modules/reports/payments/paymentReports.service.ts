import { Money, type PaymentReport, type PaymentsLedgerRow } from '@bms/shared';
import { reportDb } from '../../../db/reportDb.js';
import type { ReportFilters, ReportScope } from '../reportScope.js';
import * as payments from './paymentReports.repository.js';

/** Payment report use cases (#22), read on the report connection. */

const num = (v: string | number): number => Money.of(v).toNumber();

export async function getPaymentReport(filters: ReportFilters): Promise<PaymentReport> {
  const [totals, byMethod, byPeriod, pending] = await Promise.all([
    payments.moneyTotals(reportDb, filters),
    payments.collectedByMethod(reportDb, filters),
    payments.moneyByPeriod(reportDb, filters),
    payments.pendingOrderPayments(reportDb, filters),
  ]);
  return {
    summary: {
      totalCollected: num(totals.collected),
      totalRefunded: num(totals.refunded),
      netCollected: Money.of(totals.collected).minus(totals.refunded).toNumber(),
      pendingPayments: num(pending),
    },
    // Method codes as stored; the dashboard labels them (mobile is Telebirr).
    byMethod: byMethod.map((r) => ({ method: r.method, total: num(r.total), count: r.count })),
    byPeriod: byPeriod.map((r) => ({ period: r.period, collected: num(r.collected), refunded: num(r.refunded) })),
  };
}

/** Customer receipts in and out, and supplier payments out, by date. */
export async function getPaymentsLedger(scope: ReportScope): Promise<PaymentsLedgerRow[]> {
  const s = await payments.ledgerSources(reportDb, scope);
  const row = (r: payments.LedgerRow, referenceType: PaymentsLedgerRow['referenceType'], direction: 'IN' | 'OUT'): PaymentsLedgerRow => ({
    receiptNo: r.receipt_no,
    party: r.party,
    referenceType,
    referenceNo: r.reference_no,
    paymentMethod: r.payment_method ?? '',
    payerBank: r.payer_bank ?? '',
    paymentReference: r.payment_ref ?? '',
    amount: num(r.amount),
    direction,
    date: r.date_str,
    user: r.staff_username ?? '',
  });
  return [
    ...s.order.map((r) => row(r, 'ORDER', 'IN')),
    ...s.pos.map((r) => row(r, 'POS', 'IN')),
    ...s.returnRefund.map((r) => row(r, 'RETURN', 'OUT')),
    ...s.orderRefund.map((r) => row(r, 'ORDER', 'OUT')),
    ...s.exchange.map((r) => row(r, 'EXCHANGE', r.entry_type === 'cash_payment' ? 'IN' : 'OUT')),
    ...s.exchangeCollection.map((r) => row(r, 'EXCHANGE', 'IN')),
    ...s.supplier.map((r) => row(r, 'PO', 'OUT')),
  ].sort((a, b) => a.date.localeCompare(b.date));
}
