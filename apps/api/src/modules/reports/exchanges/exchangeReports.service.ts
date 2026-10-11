import { Money, type ExchangeDetailRow, type ExchangeReport } from '@bms/shared';
import { reportDb } from '../../../db/reportDb.js';
import type { ReportFilters, ReportScope } from '../reportScope.js';
import * as exchanges from './exchangeReports.repository.js';

/** Exchange report use cases (#22), read on the report connection. */

const num = (v: unknown): number => Money.of((v ?? 0) as string).toNumber();

export async function getExchangeReport(filters: ReportFilters): Promise<ExchangeReport> {
  const [s, settlement, periods] = await Promise.all([
    exchanges.exchangeTotals(reportDb, filters),
    exchanges.bySettlementType(reportDb, filters),
    exchanges.byPeriod(reportDb, filters),
  ]);
  return {
    summary: {
      totalExchanges: s.total_exchanges,
      totalIncomingValue: num(s.total_incoming),
      totalOutgoingValue: num(s.total_outgoing),
      netExchangeImpact: num(s.net_impact),
    },
    bySettlementType: settlement.map((r) => ({ settlementType: r.settlement_type, count: r.count, totalNetBalance: num(r.total_net_balance) })),
    byPeriod: periods.map((r) => ({ period: r.period, count: r.count, incomingValue: num(r.incoming_value), outgoingValue: num(r.outgoing_value) })),
  };
}

export async function getExchangeDetail(scope: ReportScope): Promise<ExchangeDetailRow[]> {
  const rows = await exchanges.exchangeRows(reportDb, scope);
  return rows.map((row) => ({
    exchangeNo: row.exchange_reference as string,
    customer: row.customer_name as string,
    incomingBook: (row.incoming_book as string | null) ?? '',
    incomingValue: num(row.total_incoming_value),
    outgoingBook: (row.outgoing_book as string | null) ?? '',
    outgoingValue: num(row.total_outgoing_value),
    difference: num(row.net_balance),
    // No receivable: an even exchange, or the store paid the customer; nothing is owed.
    differencePaymentStatus: (row.receivable_status as string | null) ?? 'Settled',
    cashCollected: num(row.cash_collected),
    receivableBalance: num(row.receivable_balance),
    date: row.date_str as string,
    user: (row.staff_username as string | null) ?? '',
  }));
}
