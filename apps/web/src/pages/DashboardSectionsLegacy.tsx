import { useQuery } from '@tanstack/react-query';
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { api, toQuery } from '../lib/api.js';
import { reportKeys, type ReportParams } from '../features/dashboard/queries.js';

// The Dashboard's chart sections, kept as they were until Dashboard part 2
// (#23) moves them to features/dashboard. They read the same report queries
// as the page, keyed alike, so nothing is fetched twice.

interface GrossProfitTrendPoint { period: string; netSales: number; grossProfit: number; grossMarginPct: number; }
interface TopReturnedBook { bookId: number; title: string; unitsReturned: number; refundValue: number; }
interface ReceivablesAgingBucket { bucket: string; count: number; totalOutstanding: number; }
interface DiscountByType { Normal: number; Merchant: number; Special: number; }
interface SalesSummary {
  totalSales: number; totalOrders: number; averageOrderValue: number;
  totalPosSales: number; totalPosTransactions: number;
  totalDiscountAmount: number; discountByType: DiscountByType;
}
interface SalesReport {
  summary: SalesSummary;
  byPeriod: Array<{ period: string; totalSales: number; totalOrders: number; averageOrderValue: number }>;
  byBranch: Array<{ branchId: number; branchName: string; totalSales: number; totalOrders: number }>;
}
interface PaymentReport {
  summary: { totalCollected: number; totalRefunded: number; netCollected: number; pendingPayments: number };
  byMethod: Array<{ method: string; total: number; count: number }>;
  byPeriod: Array<{ period: string; collected: number; refunded: number }>;
}
interface ExchangeReport {
  summary: { totalExchanges: number; totalIncomingValue: number; totalOutgoingValue: number; netExchangeImpact: number };
  bySettlementType: Array<{ settlementType: string; count: number; totalNetBalance: number }>;
  byPeriod: Array<{ period: string; count: number; incomingValue: number; outgoingValue: number }>;
}
interface InventoryReport {
  // availableStock/reservedStock: the backend (reports.service.ts's
  // getInventoryReport()) has always computed and returned both — this
  // interface just never declared them, so the Inventory Insights panel
  // below silently dropped them instead of showing available stock.
  summary: { totalBooks: number; totalStockUnits: number; availableStock: number; reservedStock: number; lowStockItems: number; outOfStockItems: number };
  lowStockItems: Array<{ bookId: number; title: string; locationId: number; locationName: string; quantity: number; reorderPoint: number }>;
  topSellingBooks: Array<{ bookId: number; title: string; unitsSold: number; revenue: number }>;
  stockMovement: Array<{ period: string; stockIn: number; stockOut: number }>;
}
interface CustomerReport {
  summary: { totalCustomers: number; activeCustomers: number; repeatCustomers: number; newCustomersInPeriod: number };
  topCustomers: Array<{ customerId: number; fullName: string; totalSpend: number; orderCount: number }>;
  byPeriod: Array<{ period: string; newCustomers: number }>;
}


const fmt = (n: number) => `ETB ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtShort = (n: number) => n >= 1_000_000 ? `ETB ${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `ETB ${(n / 1_000).toFixed(1)}K` : `ETB ${n.toFixed(0)}`;
const fmtPeriod = (p: string) => { try { return new Date(p).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); } catch { return p; } };

const PIE_COLORS = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#f97316'];

// Shared themed tooltip for all Recharts <Tooltip> instances — a dark,
// glassy card (readable in both light/dark page themes since it doesn't
// rely on Tailwind's dark: variant, which can't reach inline chart styles)
// instead of Recharts' default plain white box.
const CHART_TOOLTIP_PROPS = {
  contentStyle: { backgroundColor: 'rgba(17,24,39,0.96)', border: 'none', borderRadius: 10, boxShadow: '0 8px 24px -4px rgba(0,0,0,0.35)', padding: '8px 12px' },
  labelStyle: { color: '#e5e7eb', fontWeight: 600, marginBottom: 4, fontSize: 11 },
  itemStyle: { color: '#f3f4f6', fontSize: 12 },
} as const;

// ── Section wrapper ───────────────────────────────────────────────────────────

function Section({ title, icon, children, loading, error, updatedAt, onRefresh }: {
  title: React.ReactNode; icon: React.ReactNode; children: React.ReactNode;
  loading?: boolean; error?: boolean;
  updatedAt?: number; onRefresh?: () => void;
}) {
  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 shadow-xs hover:shadow-md transition-shadow duration-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-800 flex items-center gap-2.5">
        <span className="w-7 h-7 rounded-lg bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">{icon}</span>
        <h2 className="text-sm font-bold text-gray-900 dark:text-white">{title}</h2>
        {updatedAt && updatedAt > 0 && (
          <span className="ml-1 text-xs text-gray-400 dark:text-gray-500">
            · {new Date(updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
        {onRefresh && (
          <button
            onClick={onRefresh}
            disabled={loading}
            title="Refresh"
            className="ml-auto p-1 rounded-md text-gray-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-950/40 transition-colors disabled:opacity-40"
          >
            <svg className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        )}
      </div>
      <div className="p-4">
        {loading && <div className="h-32 flex items-center justify-center text-gray-400 text-sm">Loading...</div>}
        {error && <div className="h-32 flex items-center justify-center text-red-400 text-sm">Failed to load data</div>}
        {!loading && !error && children}
      </div>
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function Empty() {
  return <p className="text-center text-gray-400 text-sm py-6">No data available</p>;
}

export default function DashboardSectionsLegacy({ params, onNavigate }: {
  params: ReportParams;
  onNavigate?: (page: string, context?: Record<string, string>) => void;
}) {
  const qs = toQuery(params);
  const { data: sales, isLoading: salesLoading, isError: salesError, dataUpdatedAt: salesUpdatedAt, refetch: refetchSales } = useQuery<SalesReport>({
    queryKey: reportKeys.report('sales', params), queryFn: () => api.get(`/reports/sales${qs}`), staleTime: 30_000, refetchOnWindowFocus: true,
  });
  const { data: payments, isLoading: payLoading, isError: payError, dataUpdatedAt: payUpdatedAt, refetch: refetchPayments } = useQuery<PaymentReport>({
    queryKey: reportKeys.report('payments', params), queryFn: () => api.get(`/reports/payments${qs}`), staleTime: 30_000, refetchOnWindowFocus: true,
  });
  const { data: exchanges, isLoading: excLoading, isError: excError, dataUpdatedAt: excUpdatedAt, refetch: refetchExchanges } = useQuery<ExchangeReport>({
    queryKey: reportKeys.report('exchanges', params), queryFn: () => api.get(`/reports/exchanges${qs}`), staleTime: 30_000, refetchOnWindowFocus: true,
  });
  const { data: inventory, isLoading: invLoading, isError: invError, dataUpdatedAt: invUpdatedAt, refetch: refetchInventory } = useQuery<InventoryReport>({
    queryKey: reportKeys.report('inventory', params), queryFn: () => api.get(`/reports/inventory${qs}`), staleTime: 30_000, refetchOnWindowFocus: true,
  });
  const { data: customers, isLoading: custLoading, isError: custError, dataUpdatedAt: custUpdatedAt, refetch: refetchCustomers } = useQuery<CustomerReport>({
    queryKey: reportKeys.report('customers', params), queryFn: () => api.get(`/reports/customers${qs}`), staleTime: 30_000, refetchOnWindowFocus: true,
  });
  const { data: gpTrend, isLoading: gpLoading, isError: gpError, dataUpdatedAt: gpUpdatedAt, refetch: refetchGp } = useQuery<GrossProfitTrendPoint[]>({
    queryKey: reportKeys.report('sales/gross-profit-trend', params), queryFn: () => api.get(`/reports/sales/gross-profit-trend${qs}`), staleTime: 30_000, refetchOnWindowFocus: true,
  });
  const { data: topReturned, isLoading: topReturnedLoading, isError: topReturnedError, dataUpdatedAt: topReturnedUpdatedAt, refetch: refetchTopReturned } = useQuery<TopReturnedBook[]>({
    queryKey: reportKeys.report('returns/top', params), queryFn: () => api.get(`/reports/returns/top${qs}`), staleTime: 30_000, refetchOnWindowFocus: true,
  });
  const agingParams = { branchId: params.branchId };
  const { data: aging, isLoading: agingLoading, isError: agingError, dataUpdatedAt: agingUpdatedAt, refetch: refetchAging } = useQuery<{ byBucket: ReceivablesAgingBucket[] }>({
    queryKey: reportKeys.report('receivables-aging', agingParams), queryFn: () => api.get(`/reports/receivables-aging${toQuery(agingParams)}`), staleTime: 30_000, refetchOnWindowFocus: true,
  });

  return (
    <>
      {/* ── Row 1: Sales trend + Payment methods ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">

        {/* Sales trend (2/3 width) */}
        <div className="lg:col-span-2">
          <Section title="Sales Trend" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg>} loading={salesLoading} error={salesError} updatedAt={salesUpdatedAt} onRefresh={() => refetchSales()}>
            {sales?.byPeriod && sales.byPeriod.length > 0 ? (
              <>
                {/* Module 10: this card and the trend line below are sourced from
                    getSalesReport(), which is Orders-channel only (o.total) —
                    POS sales are tracked separately in summary.totalPosSales.
                    Previously labeled bare "Total Sales", which read as the
                    all-channel figure the Monthly/Today's Sales KPI cards up
                    top actually show, silently excluding POS revenue. Relabeled
                    for accuracy and the (already-computed but unused) POS
                    figure is now surfaced alongside it instead of combining
                    the two into one number — combining would desync this
                    summary from the still-Orders-only trend line/branch chart
                    below it. */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                  <div className="text-center"><p className="text-xs text-gray-500 dark:text-gray-400">Order Sales</p><p className="text-base font-bold text-gray-900 dark:text-white">{fmtShort(sales.summary.totalSales)}</p></div>
                  <div className="text-center"><p className="text-xs text-gray-500 dark:text-gray-400">POS Sales</p><p className="text-base font-bold text-gray-900 dark:text-white">{fmtShort(sales.summary.totalPosSales)}</p></div>
                  <div className="text-center"><p className="text-xs text-gray-500 dark:text-gray-400">Orders</p><p className="text-base font-bold text-gray-900 dark:text-white">{sales.summary.totalOrders}</p></div>
                  <div className="text-center"><p className="text-xs text-gray-500 dark:text-gray-400">Avg Order</p><p className="text-base font-bold text-gray-900 dark:text-white">{fmtShort(sales.summary.averageOrderValue)}</p></div>
                </div>
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={sales.byPeriod.map(r => ({ ...r, period: fmtPeriod(r.period) }))}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis dataKey="period" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `${(v/1000).toFixed(0)}K`} />
                    <Tooltip formatter={(v: number) => fmt(v)} {...CHART_TOOLTIP_PROPS} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line type="monotone" dataKey="totalSales" name="Order Sales (ETB)" stroke="#3b82f6" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="totalOrders" name="Orders" stroke="#10b981" strokeWidth={2} dot={false} yAxisId={0} />
                  </LineChart>
                </ResponsiveContainer>
              </>
            ) : <Empty />}
          </Section>
        </div>

        {/* Payment method distribution (1/3 width) */}
        <Section title="Payment Methods" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" /></svg>} loading={payLoading} error={payError} updatedAt={payUpdatedAt} onRefresh={() => refetchPayments()}>
          {payments?.byMethod && payments.byMethod.length > 0 ? (
            <>
              <div className="grid grid-cols-2 gap-2 mb-3 text-center">
                <div><p className="text-xs text-gray-500 dark:text-gray-400">Collected</p><p className="text-sm font-bold text-green-600 dark:text-green-400">{fmtShort(payments.summary.totalCollected)}</p></div>
                <div><p className="text-xs text-gray-500 dark:text-gray-400">Refunded</p><p className="text-sm font-bold text-amber-600 dark:text-amber-400">{fmtShort(payments.summary.totalRefunded)}</p></div>
              </div>
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie
                    data={payments.byMethod}
                    dataKey="total"
                    nameKey="method"
                    cx="50%"
                    cy="45%"
                    outerRadius={65}
                    innerRadius={30}
                  >
                    {payments.byMethod.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                  </Pie>
                  <Tooltip formatter={(v: number) => fmt(v)} {...CHART_TOOLTIP_PROPS} />
                  <Legend
                    iconType="circle"
                    iconSize={8}
                    wrapperStyle={{ fontSize: 11, paddingTop: 4 }}
                    formatter={(value: string) => {
                      const clean = value.replace('_', ' ');
                      // Bug fix: 'store_credit' was collapsed into the same
                      // "Telebirr" label as 'mobile', hiding genuine Store
                      // Credit usage from this legend entirely. These are
                      // two distinct payment methods (see PaymentsPage.tsx's/
                      // OrdersPage.tsx's METHOD_LABELS) and should read
                      // distinctly here too.
                      if (clean === 'mobile') return 'Telebirr';
                      if (clean === 'store credit') return 'Store Credit';
                      return clean;
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </>
          ) : <Empty />}
        </Section>
      </div>

      {/* ── Row 2: Sales by branch + Exchange summary ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

        {/* Sales by branch */}
        <Section title="Order Sales by Branch" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>} loading={salesLoading} error={salesError} updatedAt={salesUpdatedAt} onRefresh={() => refetchSales()}>
          {sales?.byBranch && sales.byBranch.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={sales.byBranch} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={v => `${(v/1000).toFixed(0)}K`} />
                <YAxis type="category" dataKey="branchName" tick={{ fontSize: 10 }} width={80} />
                <Tooltip formatter={(v: number) => fmt(v)} {...CHART_TOOLTIP_PROPS} />
                <Bar dataKey="totalSales" name="Order Sales (ETB)" fill="#3b82f6" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <Empty />}
        </Section>

        {/* Exchange summary */}
        <Section title="Exchange Activity" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" /></svg>} loading={excLoading} error={excError} updatedAt={excUpdatedAt} onRefresh={() => refetchExchanges()}>
          {exchanges ? (
            <>
              <div className="grid grid-cols-2 gap-3 mb-4">
                <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 text-center">
                  <p className="text-xs text-gray-500 dark:text-gray-400">Total Exchanges</p>
                  <p className="text-xl font-bold text-gray-900 dark:text-white">{exchanges.summary.totalExchanges}</p>
                </div>
                <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 text-center">
                  <p className="text-xs text-gray-500 dark:text-gray-400">Net Impact</p>
                  <p className={`text-xl font-bold ${exchanges.summary.netExchangeImpact >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>{fmtShort(Math.abs(exchanges.summary.netExchangeImpact))}</p>
                </div>
                <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3 text-center">
                  <p className="text-xs text-gray-500 dark:text-gray-400">Incoming Value</p>
                  <p className="text-sm font-bold text-blue-600 dark:text-blue-400">{fmtShort(exchanges.summary.totalIncomingValue)}</p>
                </div>
                <div className="bg-purple-50 dark:bg-purple-900/20 rounded-lg p-3 text-center">
                  <p className="text-xs text-gray-500 dark:text-gray-400">Outgoing Value</p>
                  <p className="text-sm font-bold text-purple-600 dark:text-purple-400">{fmtShort(exchanges.summary.totalOutgoingValue)}</p>
                </div>
              </div>
              {exchanges.bySettlementType.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">Settlement Distribution</p>
                  {exchanges.bySettlementType.map(s => (
                    <div key={s.settlementType} className="flex items-center gap-2">
                      <span className="text-xs text-gray-600 dark:text-gray-400 w-28 truncate">{s.settlementType.replace('_', ' ')}</span>
                      <div className="flex-1 bg-gray-100 dark:bg-gray-800 rounded-full h-2">
                        <div className="bg-blue-500 h-2 rounded-full" style={{ width: `${Math.min(100, (s.count / exchanges.summary.totalExchanges) * 100)}%` }} />
                      </div>
                      <span className="text-xs text-gray-500 dark:text-gray-400 w-6 text-right">{s.count}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : <Empty />}
        </Section>
      </div>

      {/* ── Prompt 2 — Gross Profit Trend + Top Returned Books ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">

        {/* Gross Profit Trend (2/3 width) */}
        <div className="lg:col-span-2">
          <Section title="Gross Profit Trend" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>} loading={gpLoading} error={gpError} updatedAt={gpUpdatedAt} onRefresh={() => refetchGp()}>
            {gpTrend && gpTrend.length > 0 ? (
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={gpTrend.map(r => ({ ...r, period: fmtPeriod(r.period) }))}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="period" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `${(v/1000).toFixed(0)}K`} />
                  <Tooltip formatter={(v: number) => fmt(v)} {...CHART_TOOLTIP_PROPS} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line type="monotone" dataKey="netSales" name="Net Sales" stroke="#3b82f6" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="grossProfit" name="Net Profit" stroke="#10b981" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            ) : <Empty />}
          </Section>
        </div>

        {/* Top Returned Books (1/3 width) */}
        <Section title="Top Returned Books" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v0M3 10l6-6M3 10l6 6" /></svg>} loading={topReturnedLoading} error={topReturnedError} updatedAt={topReturnedUpdatedAt} onRefresh={() => refetchTopReturned()}>
          {topReturned && topReturned.length > 0 ? (
            <div className="space-y-1 max-h-56 overflow-y-auto">
              {topReturned.slice(0, 8).map((b, i) => (
                <div key={b.bookId} className="flex items-center gap-2 text-xs">
                  <span className="text-gray-400 w-4">{i + 1}.</span>
                  <span className="flex-1 min-w-0 text-gray-700 dark:text-gray-300 truncate">{b.title}</span>
                  <span className="text-gray-500 dark:text-gray-400 whitespace-nowrap">{b.unitsReturned} returned</span>
                  <span className="text-red-600 dark:text-red-400 whitespace-nowrap">{fmtShort(b.refundValue)}</span>
                </div>
              ))}
            </div>
          ) : <Empty />}
        </Section>
      </div>

      {/* ── Prompt 2 — Receivables Aging Summary ── */}
      <Section title="Receivables Aging Summary" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>} loading={agingLoading} error={agingError} updatedAt={agingUpdatedAt} onRefresh={() => refetchAging()}>
        {aging?.byBucket && aging.byBucket.some(b => b.count > 0) ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 cursor-pointer" onClick={() => onNavigate?.('receivables')}>
            {aging.byBucket.map(b => {
              const bucketColor: Record<string, string> = {
                Current: 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300',
                '1-30':  'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300',
                '31-60': 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300',
                '61-90': 'bg-orange-50 dark:bg-orange-900/20 text-orange-700 dark:text-orange-300',
                '90+':   'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300',
              };
              return (
                <div key={b.bucket} className={`rounded-lg p-3 text-center ${bucketColor[b.bucket] ?? 'bg-gray-50 dark:bg-gray-800'}`}>
                  <p className="text-xs font-medium">{b.bucket === 'Current' ? 'Current' : `${b.bucket} days`}</p>
                  <p className="text-base font-bold">{fmtShort(b.totalOutstanding)}</p>
                  <p className="text-[10px] opacity-75">{b.count} invoice{b.count !== 1 ? 's' : ''}</p>
                </div>
              );
            })}
          </div>
        ) : <Empty />}
      </Section>

      {/* ── Row 3: Inventory + Customer insights ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

        {/* Inventory panel */}
        <Section title="Inventory Insights" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" /></svg>} loading={invLoading} error={invError} updatedAt={invUpdatedAt} onRefresh={() => refetchInventory()}>
          {inventory ? (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mb-4">
                {[
                  { label: 'Books', value: inventory.summary.totalBooks, color: 'text-gray-900 dark:text-white' },
                  { label: 'Units', value: inventory.summary.totalStockUnits, color: 'text-gray-900 dark:text-white' },
                  { label: 'Available', value: inventory.summary.availableStock, color: 'text-emerald-600 dark:text-emerald-400' },
                  { label: 'Reserved', value: inventory.summary.reservedStock, color: 'text-blue-600 dark:text-blue-400' },
                  { label: 'Low Stock', value: inventory.summary.lowStockItems, color: 'text-amber-600 dark:text-amber-400' },
                  { label: 'Out of Stock', value: inventory.summary.outOfStockItems, color: 'text-red-600 dark:text-red-400' },
                ].map(c => (
                  <div key={c.label} className="bg-gray-50 dark:bg-gray-800 rounded-lg p-2 text-center">
                    <p className="text-xs text-gray-500 dark:text-gray-400">{c.label}</p>
                    <p className={`text-base font-bold ${c.color}`}>{c.value}</p>
                  </div>
                ))}
              </div>
              {inventory.topSellingBooks.length > 0 && (
                <>
                  <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">Top Selling Books</p>
                  <div className="space-y-1 max-h-40 overflow-y-auto">
                    {inventory.topSellingBooks.slice(0, 8).map((b, i) => (
                      <div key={b.bookId} className="flex items-center gap-2 text-xs">
                        <span className="text-gray-400 w-4">{i + 1}.</span>
                        <span className="flex-1 min-w-0 text-gray-700 dark:text-gray-300 truncate">{b.title}</span>
                        <span className="text-gray-500 dark:text-gray-400 whitespace-nowrap">{b.unitsSold} sold</span>
                        <span className="text-green-600 dark:text-green-400 whitespace-nowrap">{fmtShort(b.revenue)}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {inventory.lowStockItems.length > 0 && (
                <div className="mt-3">
                  <p className="text-xs font-medium text-amber-600 dark:text-amber-400 mb-2">Low Stock Alerts</p>
                  <div className="space-y-1 max-h-32 overflow-y-auto">
                    {inventory.lowStockItems.slice(0, 6).map(item => (
                      <div key={`${item.bookId}-${item.locationId}`} className="flex items-center gap-2 text-xs bg-amber-50 dark:bg-amber-900/20 rounded-sm px-2 py-1">
                        <span className="flex-1 min-w-0 text-gray-700 dark:text-gray-300 truncate">{item.title}</span>
                        <span className="text-gray-500 dark:text-gray-400 truncate">{item.locationName}</span>
                        <span className="text-amber-700 dark:text-amber-300 font-medium whitespace-nowrap">{item.quantity}/{item.reorderPoint}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : <Empty />}
        </Section>

        {/* Customer insights */}
        <Section title="Customer Insights" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>} loading={custLoading} error={custError} updatedAt={custUpdatedAt} onRefresh={() => refetchCustomers()}>
          {customers ? (
            <>
              <div className="grid grid-cols-2 gap-2 mb-4">
                {[
                  { label: 'Total', value: customers.summary.totalCustomers },
                  { label: 'Active', value: customers.summary.activeCustomers },
                  { label: 'Repeat', value: customers.summary.repeatCustomers },
                  { label: 'New (period)', value: customers.summary.newCustomersInPeriod },
                ].map(c => (
                  <div key={c.label} className="bg-gray-50 dark:bg-gray-800 rounded-lg p-2 text-center">
                    <p className="text-xs text-gray-500 dark:text-gray-400">{c.label}</p>
                    <p className="text-base font-bold text-gray-900 dark:text-white">{c.value}</p>
                  </div>
                ))}
              </div>
              {customers.topCustomers.length > 0 && (
                <>
                  <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">Top Customers by Spend</p>
                  <div className="space-y-1 max-h-48 overflow-y-auto">
                    {customers.topCustomers.slice(0, 8).map((c, i) => (
                      <div key={c.customerId} className="flex items-center gap-2 text-xs">
                        <span className="text-gray-400 w-4">{i + 1}.</span>
                        <span className="flex-1 min-w-0 text-gray-700 dark:text-gray-300 truncate">{c.fullName}</span>
                        <span className="text-gray-500 dark:text-gray-400 whitespace-nowrap">{c.orderCount} orders</span>
                        <span className="text-blue-600 dark:text-blue-400 font-medium whitespace-nowrap">{fmtShort(c.totalSpend)}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          ) : <Empty />}
        </Section>
      </div>

      {/* ── Row 4: Stock movement + Payment trend ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

        {/* Stock movement */}
        <Section title="Stock Movement" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>} loading={invLoading} error={invError} updatedAt={invUpdatedAt} onRefresh={() => refetchInventory()}>
          {inventory?.stockMovement && inventory.stockMovement.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={inventory.stockMovement.map(r => ({ ...r, period: fmtPeriod(r.period) }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="period" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip {...CHART_TOOLTIP_PROPS} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="stockIn"  name="Stock In"  fill="#10b981" radius={[4, 4, 0, 0]} />
                <Bar dataKey="stockOut" name="Stock Out" fill="#ef4444" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <Empty />}
        </Section>

        {/* Payment collected vs refunded trend */}
        <Section title="Payment Trend" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>} loading={payLoading} error={payError} updatedAt={payUpdatedAt} onRefresh={() => refetchPayments()}>
          {payments?.byPeriod && payments.byPeriod.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={payments.byPeriod.map(r => ({ ...r, period: fmtPeriod(r.period) }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="period" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `${(v/1000).toFixed(0)}K`} />
                <Tooltip formatter={(v: number) => fmt(v)} {...CHART_TOOLTIP_PROPS} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="collected" name="Collected" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                <Bar dataKey="refunded"  name="Refunded"  fill="#f59e0b" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <Empty />}
        </Section>
      </div>

      {/* ── Row 5: Discount Summary ── */}
      {sales?.summary?.discountByType && (
        <Section
          title="Discount Summary"
          icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" /></svg>}
          loading={salesLoading}
          error={salesError}
          updatedAt={salesUpdatedAt}
          onRefresh={() => refetchSales()}
        >
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 text-center">
              <p className="text-xs text-gray-500 dark:text-gray-400">Total Discounts</p>
              <p className="text-lg font-bold text-gray-900 dark:text-white">{fmtShort(sales.summary.totalDiscountAmount)}</p>
            </div>
            <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3 text-center">
              <p className="text-xs text-gray-500 dark:text-gray-400">Normal</p>
              <p className="text-lg font-bold text-blue-600 dark:text-blue-400">{fmtShort(sales.summary.discountByType.Normal)}</p>
            </div>
            <div className="bg-purple-50 dark:bg-purple-900/20 rounded-lg p-3 text-center">
              <p className="text-xs text-gray-500 dark:text-gray-400">Merchant</p>
              <p className="text-lg font-bold text-purple-600 dark:text-purple-400">{fmtShort(sales.summary.discountByType.Merchant)}</p>
            </div>
            <div className="bg-amber-50 dark:bg-amber-900/20 rounded-lg p-3 text-center">
              <p className="text-xs text-gray-500 dark:text-gray-400">Special</p>
              <p className="text-lg font-bold text-amber-600 dark:text-amber-400">{fmtShort(sales.summary.discountByType.Special)}</p>
            </div>
          </div>
          {sales.summary.totalDiscountAmount > 0 && (
            <div className="mt-3 space-y-1.5">
              {(['Normal', 'Merchant', 'Special'] as const).map(type => {
                const amount = sales.summary.discountByType[type];
                const pct = sales.summary.totalDiscountAmount > 0
                  ? (amount / sales.summary.totalDiscountAmount) * 100
                  : 0;
                const colors: Record<string, string> = { Normal: 'bg-blue-500', Merchant: 'bg-purple-500', Special: 'bg-amber-500' };
                return (
                  <div key={type} className="flex items-center gap-2">
                    <span className="text-xs text-gray-600 dark:text-gray-400 w-16">{type}</span>
                    <div className="flex-1 bg-gray-100 dark:bg-gray-800 rounded-full h-2">
                      <div className={`${colors[type]} h-2 rounded-full transition-all`} style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-xs text-gray-500 dark:text-gray-400 w-12 text-right">{pct.toFixed(1)}%</span>
                  </div>
                );
              })}
            </div>
          )}
        </Section>
      )}
    </>
  );
}
