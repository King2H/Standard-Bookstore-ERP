import type {
  CustomerReport,
  ExchangeReport,
  GrossProfitTrend,
  InventoryReport,
  KpiPeriod,
  KpiReport,
  PaymentReport,
  PeriodKpis,
  ReceivablesAging,
  SalesReport,
  TopReturnedBooks,
} from '@bms/shared';
import { api, downloadFile, toQuery } from '../../lib/api.js';

/**
 * The report endpoints the Dashboard reads (#22), typed with their
 * @bms/shared contracts. The branch is the session's unless staff with access
 * to all branches name one, or none for all.
 */

export type ReportParams = {
  dateFrom?: string;
  dateTo?: string;
  groupBy?: 'day' | 'week' | 'month';
  branchId?: number;
};

export const getKpis = (branchId?: number) => api.get<KpiReport>(`/reports/kpis${toQuery({ branchId })}`);

export const getPeriodKpis = (period: KpiPeriod, branchId?: number) =>
  api.get<PeriodKpis>(`/reports/kpis/period${toQuery({ period, branchId })}`);

export const getInventoryReport = (params: ReportParams) => api.get<InventoryReport>(`/reports/inventory${toQuery(params)}`);
export const getSalesReport = (params: ReportParams) => api.get<SalesReport>(`/reports/sales${toQuery(params)}`);
export const getPaymentReport = (params: ReportParams) => api.get<PaymentReport>(`/reports/payments${toQuery(params)}`);
export const getExchangeReport = (params: ReportParams) => api.get<ExchangeReport>(`/reports/exchanges${toQuery(params)}`);
export const getCustomerReport = (params: ReportParams) => api.get<CustomerReport>(`/reports/customers${toQuery(params)}`);
export const getGrossProfitTrend = (params: ReportParams) =>
  api.get<GrossProfitTrend>(`/reports/sales/gross-profit-trend${toQuery(params)}`);
export const getTopReturnedBooks = (params: ReportParams) => api.get<TopReturnedBooks>(`/reports/returns/top${toQuery(params)}`);
/** Open balances now: only the branch applies, not the dates. */
export const getReceivablesAging = (branchId?: number) =>
  api.get<ReceivablesAging>(`/reports/receivables-aging${toQuery({ branchId })}`);

/** A report as CSV, for the date range and branch shown. */
export const exportReport = (type: string, params: ReportParams) =>
  downloadFile(
    `/reports/${type}/export${toQuery({ dateFrom: params.dateFrom, dateTo: params.dateTo, branchId: params.branchId, format: 'csv' })}`,
    `${type}-report-${new Date().toISOString().slice(0, 10)}.csv`,
  );
