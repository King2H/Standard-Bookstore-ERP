import { useQuery } from '@tanstack/react-query';
import type { KpiPeriod } from '@bms/shared';
import {
  getCustomerReport,
  getExchangeReport,
  getGrossProfitTrend,
  getInventoryReport,
  getKpis,
  getPaymentReport,
  getPeriodKpis,
  getReceivablesAging,
  getSalesReport,
  getTopReturnedBooks,
  type ReportParams,
} from './api.js';

export type { ReportParams } from './api.js';

/** Query keys for reports. Every key starts with `reportKeys.all`, so Refresh refetches them all. */
export const reportKeys = {
  all: ['reports'] as const,
  /** A report family read with the Dashboard's filters, e.g. 'sales' or 'returns/top'. */
  report: (name: string, params: ReportParams) => [...reportKeys.all, name, params] as const,
  kpis: (branchId?: number) => [...reportKeys.all, 'kpis', branchId ?? null] as const,
  period: (period: KpiPeriod, branchId?: number) => [...reportKeys.all, 'kpis-period', period, branchId ?? null] as const,
};

/** The live KPIs: always fresh, refreshed every 30 seconds. */
export function useKpis(branchId?: number, enabled = true) {
  return useQuery({
    queryKey: reportKeys.kpis(branchId), queryFn: () => getKpis(branchId), enabled,
    staleTime: 0, refetchInterval: 30_000, refetchOnWindowFocus: true,
  });
}

export function usePeriodKpis(period: KpiPeriod, branchId?: number) {
  return useQuery({
    queryKey: reportKeys.period(period, branchId), queryFn: () => getPeriodKpis(period, branchId),
    staleTime: 30_000, refetchOnWindowFocus: true,
  });
}

/** A report read with the Dashboard's filters, fresh for 30 seconds. */
function useReport<T>(name: string, params: ReportParams, read: (p: ReportParams) => Promise<T>) {
  return useQuery({
    queryKey: reportKeys.report(name, params), queryFn: () => read(params),
    staleTime: 30_000, refetchOnWindowFocus: true,
  });
}

export const useInventoryReport = (params: ReportParams) => useReport('inventory', params, getInventoryReport);
export const useSalesReport = (params: ReportParams) => useReport('sales', params, getSalesReport);
export const usePaymentReport = (params: ReportParams) => useReport('payments', params, getPaymentReport);
export const useExchangeReport = (params: ReportParams) => useReport('exchanges', params, getExchangeReport);
export const useCustomerReport = (params: ReportParams) => useReport('customers', params, getCustomerReport);
export const useGrossProfitTrend = (params: ReportParams) => useReport('sales/gross-profit-trend', params, getGrossProfitTrend);
export const useTopReturnedBooks = (params: ReportParams) => useReport('returns/top', params, getTopReturnedBooks);
export const useReceivablesAging = (branchId?: number) =>
  useReport('receivables-aging', { branchId }, (p) => getReceivablesAging(p.branchId));
