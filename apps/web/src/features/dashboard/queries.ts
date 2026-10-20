import { useQuery } from '@tanstack/react-query';
import type { KpiPeriod } from '@bms/shared';
import { getInventoryReport, getKpis, getPeriodKpis, type ReportParams } from './api.js';

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

export function useInventoryReport(params: ReportParams) {
  return useQuery({
    queryKey: reportKeys.report('inventory', params), queryFn: () => getInventoryReport(params),
    staleTime: 30_000, refetchOnWindowFocus: true,
  });
}
