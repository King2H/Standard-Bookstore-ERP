import { useState } from 'react';
import type { KpiPeriod } from '@bms/shared';
import { useCurrency } from '../../../lib/useCurrency.js';
import { useInventoryReport, useKpis, usePeriodKpis, type ReportParams } from '../queries.js';
import { HighlightKpiCard, KpiCard, kpiToneClass, PERIOD_LABELS, PeriodSelector, shortMoney, TrendBadge, warningCountTone } from './cards.js';

/**
 * The Live Overview (Sales Performance, Cash & Receivables, Inventory &
 * Operations) and the alerts under it. Drill-downs leave the branch to the
 * session; Cash Collected opens Payments' Money In & Out on its period, the
 * rows behind its figure (owner decision b; before, Payment History, order
 * payments only).
 */
export function Overview({ params, onNavigate }: {
  params: ReportParams;
  onNavigate?: (page: string, context?: Record<string, string>) => void;
}) {
  const currency = useCurrency();
  const short = (n: number) => shortMoney(n, currency);
  const [salesPeriod, setSalesPeriod] = useState<KpiPeriod>('today');
  const { data: kpis, isLoading: kpiLoading, dataUpdatedAt: kpiUpdatedAt } = useKpis(params.branchId);
  const { data: periodKpis, isLoading: periodLoading } = usePeriodKpis(salesPeriod, params.branchId);
  const { data: inventory } = useInventoryReport(params);

  return (
    <>
      {/* ── KPI Cards ──────────────────────────────────────────────────────────
          Dashboard Standardization & Unified Reports Engine — reorganized
          into a 3-tier financial-impact hierarchy: Primary (Profit & Net
          Sales, bold/accent-badged), Secondary (Cash Flow & Liquidity),
          Tertiary (Operational & Inventory Controls). All figures sourced
          from GET /reports/kpis (reportsService.getKpis(), backed by
          FinancialReportService for the Primary row's *Unified fields) — the
          same engine and rows that back the Sales CSV export, so these
          totals reconcile 1:1 with it for the same date range. ── */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 shadow-xs p-4 sm:p-5">
        <div className="flex items-center gap-2 mb-4">
          <span className="text-sm font-bold text-gray-900 dark:text-white">Live Overview</span>
          <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse inline-block" />
            Live · 30s
          </span>
          {kpiUpdatedAt > 0 && (
            <span className="ml-auto text-xs text-gray-400 dark:text-gray-500">
              {new Date(kpiUpdatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          )}
        </div>

        {kpiLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {Array.from({ length: 9 }).map((_, i) => (
              <div key={i} className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3 h-24 animate-pulse" />
            ))}
          </div>
        ) : kpis ? (
          <div className="space-y-5">

            {/* ── Sales Performance ── */}
            <div>
              <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                <p className="text-[11px] font-bold uppercase tracking-wider text-gray-400 dark:text-gray-500">Sales Performance</p>
                <PeriodSelector value={salesPeriod} onChange={setSalesPeriod} />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {/* Not clickable: Net Sales aggregates ORDER + POS + RETURN +
                    EXCHANGE rows (the Unified engine), so a single "view
                    orders" drill-down would misrepresent it as order-only. */}
                <HighlightKpiCard
                  label="Net Sales"
                  value={short(periodKpis?.netSales ?? 0)}
                  sub={periodLoading ? 'Loading…' : `${PERIOD_LABELS[salesPeriod]} · vs. prior period`}
                  accent="blue"
                  negative={(periodKpis?.netSales ?? 0) < 0}
                  icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>}
                >
                  <TrendBadge changePct={periodKpis?.netSalesChangePct ?? null} />
                </HighlightKpiCard>
                {/* "Net Profit" — the dashboard's single unambiguous profit KPI:
                    actual economic profit after COGS, discounts, returns, and
                    exchange/settlement adjustments (Prompt 2). Cash collection
                    is never netted into this figure — see Cash & Receivables
                    below for the independent cash-flow view. */}
                <HighlightKpiCard
                  label="Net Profit"
                  value={short(periodKpis?.grossProfit ?? 0)}
                  sub={periodLoading ? 'Loading…' : `${PERIOD_LABELS[salesPeriod]} · Net Sales − COGS − Returns`}
                  accent="emerald"
                  negative={(periodKpis?.grossProfit ?? 0) < 0}
                  icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}
                >
                  <TrendBadge changePct={periodKpis?.grossProfitChangePct ?? null} />
                </HighlightKpiCard>
                <HighlightKpiCard
                  label="Gross Margin %"
                  value={`${(periodKpis?.grossMarginPct ?? 0).toFixed(1)}%`}
                  sub={periodLoading ? 'Loading…' : `Prior period: ${(periodKpis?.previous?.grossMarginPct ?? 0).toFixed(1)}%`}
                  accent="teal"
                  negative={(periodKpis?.grossMarginPct ?? 0) < 0}
                  icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg>}
                />
              </div>
            </div>

            {/* ── Cash & Receivables — independent of Sales Performance above:
                cash collection is a downstream settlement event on revenue
                already recognized, never a second profit adjustment. ── */}
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-2">Cash &amp; Receivables</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <KpiCard
                  label={`Cash Collected · ${PERIOD_LABELS[salesPeriod]}`}
                  value={short(periodKpis?.cashCollected ?? kpis.dailyRevenue)}
                  sub={periodKpis ? `In ${short(periodKpis.cashIn)} · Out ${short(periodKpis.cashOut)}` : 'Payments less refunds'}
                  icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 9V7a4 4 0 00-8 0v2M5 9h14l1 12H4L5 9z" /></svg>}
                  color={kpiToneClass('positive')}
                  onClick={() => periodKpis && onNavigate?.('payments', { tab: 'money', dateFrom: periodKpis.dateFrom, dateTo: periodKpis.dateTo })}
                />
                <KpiCard
                  label="Outstanding Receivables"
                  value={short(kpis.outstandingBalance)}
                  sub="Unpaid credit + exchange differences"
                  icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" /></svg>}
                  color={kpiToneClass(warningCountTone(kpis.outstandingBalance))}
                  onClick={() => onNavigate?.('receivables', { status: 'Pending,PartiallyPaid,Overdue' })}
                />
                <KpiCard
                  label="Overdue Receivables"
                  value={short(kpis.overdueReceivablesAmount)}
                  sub="Past due date"
                  icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}
                  color={kpiToneClass(kpis.overdueReceivablesAmount > 0 ? 'critical' : 'informational')}
                  onClick={() => onNavigate?.('receivables', { status: 'Overdue' })}
                />
              </div>
            </div>

            {/* ── Inventory & Operations ── */}
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-2">Inventory &amp; Operations</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <KpiCard
                  label="Low Stock Items"
                  value={kpis.lowStockAlerts.toString()}
                  sub={kpis.lowStockAlerts > 0 ? 'At or below reorder threshold' : 'All good'}
                  icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>}
                  color={kpiToneClass(warningCountTone(kpis.lowStockAlerts))}
                  onClick={() => onNavigate?.('inventory', { lowStockOnly: 'true' })}
                />
                <KpiCard
                  label="Inventory Value"
                  value={short(kpis.inventoryValue)}
                  sub="Qty on hand × average cost"
                  icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" /></svg>}
                  color={kpiToneClass('informational')}
                  onClick={() => onNavigate?.('inventory')}
                />
                <KpiCard
                  label="Pending Customer Orders"
                  value={kpis.pendingOrders.toString()}
                  sub={kpis.pendingOrders > 0 ? 'Awaiting fulfillment' : 'All clear'}
                  icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>}
                  color={kpiToneClass(warningCountTone(kpis.pendingOrders))}
                  onClick={() => onNavigate?.('orders', { status: 'Confirmed,In_Progress,CONFIRMED,PAID' })}
                />
              </div>
            </div>

          </div>
        ) : null}
      </div>

      {/* ── Alerts & Activity ── */}
      {inventory && (kpis?.lowStockAlerts ?? 0) + (kpis?.pendingOrders ?? 0) > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {/* Low stock alerts */}
          {(kpis?.lowStockAlerts ?? 0) > 0 && inventory.lowStockItems.length > 0 && (
            <div
              className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl p-4 cursor-pointer hover:border-amber-400 dark:hover:border-amber-600 transition-colors"
              onClick={() => onNavigate?.('inventory', { lowStockOnly: 'true' })}
            >
              <div className="flex items-center gap-2 mb-3">
                <span className="text-amber-600 dark:text-amber-400 shrink-0"><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg></span>
                <h3 className="text-sm font-semibold text-amber-800 dark:text-amber-300">Low Stock Items</h3>
                <span className="ml-auto text-xs font-medium bg-amber-200 dark:bg-amber-800 text-amber-800 dark:text-amber-200 px-2 py-0.5 rounded-full">
                  {kpis?.lowStockAlerts}
                </span>
              </div>
              <div className="space-y-1.5">
                {inventory.lowStockItems.slice(0, 4).map(item => (
                  <div key={`${item.bookId}-${item.locationId}`} className="flex items-center gap-2 text-xs">
                    <span className="flex-1 min-w-0 text-gray-700 dark:text-gray-300 truncate">{item.title}</span>
                    <span className="text-gray-500 dark:text-gray-400 truncate max-w-[80px]">{item.locationName}</span>
                    <span className="font-semibold text-amber-700 dark:text-amber-300 whitespace-nowrap">{item.quantity} left</span>
                  </div>
                ))}
                {inventory.lowStockItems.length > 4 && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 pt-1">+{inventory.lowStockItems.length - 4} more — View Inventory</p>
                )}
              </div>
            </div>
          )}

          {/* Pending orders */}
          {(kpis?.pendingOrders ?? 0) > 0 && (
            <div
              className="bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-xl p-4 cursor-pointer hover:border-orange-400 dark:hover:border-orange-600 transition-colors"
              onClick={() => onNavigate?.('orders', { status: 'Confirmed,In_Progress,CONFIRMED,PAID' })}
            >
              <div className="flex items-center gap-2 mb-3">
                <span className="text-orange-600 dark:text-orange-400 shrink-0"><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg></span>
              <h3 className="text-sm font-semibold text-orange-800 dark:text-orange-300">Pending Orders</h3>
                <span className="ml-auto text-xs font-medium bg-orange-200 dark:bg-orange-800 text-orange-800 dark:text-orange-200 px-2 py-0.5 rounded-full">
                  {kpis?.pendingOrders}
                </span>
              </div>
              <p className="text-xs text-gray-600 dark:text-gray-400">
                {kpis?.pendingOrders} confirmed order{(kpis?.pendingOrders ?? 0) !== 1 ? 's' : ''} awaiting fulfillment.
              </p>
              <p className="text-xs text-orange-600 dark:text-orange-400 mt-2 font-medium">View Orders</p>
            </div>
          )}
        </div>
      )}

    </>
  );
}
