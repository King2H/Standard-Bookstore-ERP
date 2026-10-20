import type { InventoryReport, KpiPeriod, KpiReport, PeriodKpis } from '@bms/shared';
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

/** A report as CSV, for the date range and branch shown. */
export const exportReport = (type: string, params: ReportParams) =>
  downloadFile(
    `/reports/${type}/export${toQuery({ dateFrom: params.dateFrom, dateTo: params.dateTo, branchId: params.branchId, format: 'csv' })}`,
    `${type}-report-${new Date().toISOString().slice(0, 10)}.csv`,
  );
