import { useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import WelcomeBanner from '../components/WelcomeBanner.js';
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { api, getAccessToken, getCurrentBranchId } from '../lib/api.js';

type Role = string;
interface DashboardPageProps { userRole?: Role; onNavigate?: (page: string, context?: Record<string, string>) => void; }

// ── API types ─────────────────────────────────────────────────────────────────

interface KpiReport {
  dailySales: number;
  monthlySales: number;
  dailyRevenue: number;
  monthlyRevenue: number;
  averageOrderValue: number;
  totalActiveCustomers: number;
  lowStockAlerts: number;
  pendingOrders: number;
  totalExchangesToday: number;
  outstandingBalance: number;
  // Net profit breakdown
  netProfit: number;
  fulfilledRevenue: number;
  outstandingReceivables: number;
  cashSalesRevenue: number;
  creditSalesRevenue: number;
  collectedCreditRevenue: number;
  purchaseCost: number;
  totalDiscounts: number;
  // Executive financial KPIs
  grossProfit: number;
  dailyNetProfit: number;
  monthlyNetProfit: number;
  // Dashboard Standardization & Unified Reports Engine — gross-invoiced/accrual
  // figures sourced from FinancialReportService, reconciling 1:1 with the
  // Sales CSV export for the same date range. dailyNetProfitUnified /
  // monthlyNetProfitUnified / grossProfitUnified are THE dashboard's single
  // "Net Profit" KPI (Prompt 2) — never render dailyNetProfit/monthlyNetProfit
  // above under that same label (collected-cash revenue recognition for
  // credit sales — a separate accounting policy, used only for Cash &
  // Receivables cards / integrity tests).
  dailyNetSalesRevenue: number;
  monthlyNetSalesRevenue: number;
  dailyNetProfitUnified: number;
  monthlyNetProfitUnified: number;
  dailyGrossMarginPct: number;
  monthlyGrossMarginPct: number;
  grossProfitUnified: number;
  overdueReceivablesAmount: number;
  inventoryValue: number;
}

// Prompt 2 — Today/Week/Month/Year selector for the Sales Performance
// section, with previous-period comparison. Independent of the KpiReport
// query above (which stays fixed Today/This-Month for the other sections).
type KpiPeriod = 'today' | 'week' | 'month' | 'year';
interface PeriodSalesKpis {
  period: KpiPeriod;
  dateFrom: string; dateTo: string;
  netSales: number; grossProfit: number; grossMarginPct: number;
  previous: { dateFrom: string; dateTo: string; netSales: number; grossProfit: number; grossMarginPct: number };
  netSalesChangePct: number | null;
  grossProfitChangePct: number | null;
  cashCollected: number;
  previousCashCollected: number;
}
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

// ── Helpers ───────────────────────────────────────────────────────────────────

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

type GroupBy = 'day' | 'week' | 'month';

// ── KPI Card ──────────────────────────────────────────────────────────────────

function KpiCard({ label, value, sub, icon, color, onClick }: { label: string; value: string; sub?: string; icon: React.ReactNode; color: string; onClick?: () => void }) {
  return (
    <div
      onClick={onClick}
      className={`bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 shadow-sm p-3 flex flex-col gap-2 min-w-0 ${onClick ? 'cursor-pointer hover:border-blue-300 dark:hover:border-blue-700 hover:shadow-md hover:-translate-y-0.5 transition-all duration-150' : ''}`}
    >
      <div className="flex items-center gap-2">
        <div className={`w-8 h-8 rounded-xl flex items-center justify-center text-base flex-shrink-0 ${color}`}>{icon}</div>
        <p className="text-xs text-gray-500 dark:text-gray-400 font-medium leading-tight">{label}</p>
      </div>
      <p className="text-xl font-bold text-gray-900 dark:text-white leading-none pl-1">{value}</p>
      {sub && <p className="text-xs text-gray-400 dark:text-gray-500 pl-1">{sub}</p>}
    </div>
  );
}

// ── Highlight KPI Card ────────────────────────────────────────────────────────
// Dashboard Standardization & Unified Reports Engine — Primary Row (Profit &
// Net Sales) cards. Visually distinct from KpiCard: bolder typography, a
// tinted accent background badge instead of a plain white card, so the
// bottom-line financial metrics read as top priority at a glance. Supports
// either a single `value` or a today+monthly pair (`todayValue`/`monthlyValue`,
// e.g. Net Profit) rendered side-by-side within the same card.

const HIGHLIGHT_ACCENTS: Record<'emerald' | 'teal' | 'blue' | 'rose', { card: string; badge: string }> = {
  emerald: { card: 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800', badge: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
  teal:    { card: 'bg-teal-50 dark:bg-teal-950/30 border-teal-200 dark:border-teal-800',             badge: 'bg-teal-500/15 text-teal-700 dark:text-teal-300' },
  blue:    { card: 'bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800',             badge: 'bg-blue-500/15 text-blue-700 dark:text-blue-300' },
  rose:    { card: 'bg-rose-50 dark:bg-rose-950/30 border-rose-200 dark:border-rose-800',             badge: 'bg-rose-500/15 text-rose-700 dark:text-rose-300' },
};

function HighlightKpiCard({ label, value, todayValue, monthlyValue, sub, icon, accent, negative, onClick, children }: {
  label: string; value?: string; todayValue?: string; monthlyValue?: string; sub?: string;
  icon: React.ReactNode; accent: 'emerald' | 'teal' | 'blue' | 'rose'; negative?: boolean; onClick?: () => void;
  /** Optional trailing content next to the value — e.g. a <TrendBadge> previous-period indicator. */
  children?: React.ReactNode;
}) {
  const resolvedAccent = negative ? 'rose' : accent;
  const colors = HIGHLIGHT_ACCENTS[resolvedAccent];
  const valueClass = negative ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-white';
  return (
    <div
      onClick={onClick}
      className={`rounded-xl border-2 shadow-sm p-4 flex flex-col gap-2 min-w-0 ${colors.card} ${onClick ? 'cursor-pointer hover:shadow-lg hover:-translate-y-0.5 transition-all duration-150' : 'transition-shadow duration-150'}`}
    >
      <div className="flex items-center gap-2">
        <div className={`w-9 h-9 rounded-xl flex items-center justify-center text-base flex-shrink-0 ${colors.badge}`}>{icon}</div>
        <p className="text-xs font-bold uppercase tracking-wide text-gray-600 dark:text-gray-300 leading-tight">{label}</p>
      </div>
      {todayValue !== undefined && monthlyValue !== undefined ? (
        <div className="flex items-end gap-5 pl-1">
          <div>
            <p className="text-[10px] font-semibold text-gray-500 dark:text-gray-400">Today</p>
            <p className={`text-2xl font-extrabold leading-none ${valueClass}`}>{todayValue}</p>
          </div>
          <div>
            <p className="text-[10px] font-semibold text-gray-500 dark:text-gray-400">Monthly</p>
            <p className={`text-2xl font-extrabold leading-none ${valueClass}`}>{monthlyValue}</p>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 pl-1">
          <p className={`text-2xl font-extrabold leading-none ${valueClass}`}>{value}</p>
          {children}
        </div>
      )}
      {sub && <p className="text-xs text-gray-500 dark:text-gray-400 pl-1">{sub}</p>}
    </div>
  );
}

// ── KPI color rule (Prompt 2) ─────────────────────────────────────────────────
// Single shared rule, applied consistently instead of ad-hoc per-card
// booleans: green = positive profitability, blue/gray = informational,
// amber = warning, red = critical negative only. A profitability KPI only
// ever turns red when the KPI ITSELF is negative for the period — never as
// a reaction to a single contributing event (e.g. one return) unless that
// event alone was enough to push the whole period negative. Thresholds are
// intentionally on the metric's own sign/magnitude, never on an individual
// transaction.
type KpiTone = 'positive' | 'informational' | 'warning' | 'critical';
const KPI_TONE_CLASSES: Record<KpiTone, string> = {
  positive:      'bg-emerald-100 dark:bg-emerald-900/30',
  informational: 'bg-blue-100 dark:bg-blue-900/30',
  warning:       'bg-amber-100 dark:bg-amber-900/30',
  critical:      'bg-red-100 dark:bg-red-900/30',
};
// Profitability metrics (Net Sales, Net Profit, Gross Margin %) apply this
// same rule directly via HighlightKpiCard's `negative` prop: red only when
// the KPI itself is negative for the period, never in reaction to a single
// contributing event.
/** Count/queue metrics (Low Stock, Pending Orders): amber once non-zero, never red on their own. */
function warningCountTone(value: number): KpiTone { return value > 0 ? 'warning' : 'informational'; }
function kpiToneClass(tone: KpiTone): string { return KPI_TONE_CLASSES[tone]; }

// ── Trend badge — previous-period % change indicator ───────────────────────

function TrendBadge({ changePct }: { changePct: number | null }) {
  if (changePct === null) return null;
  const isUp = changePct > 0;
  const isFlat = changePct === 0;
  const color = isFlat
    ? 'text-gray-500 dark:text-gray-400'
    : isUp
      ? 'text-emerald-600 dark:text-emerald-400'
      : 'text-red-600 dark:text-red-400';
  return (
    <span className={`inline-flex items-center gap-0.5 text-[11px] font-semibold ${color}`}>
      {!isFlat && (
        <svg className={`w-3 h-3 ${isUp ? '' : 'rotate-180'}`} fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M10 17a.75.75 0 01-.75-.75V5.612L5.29 9.77a.75.75 0 01-1.08-1.04l5.25-5.5a.75.75 0 011.08 0l5.25 5.5a.75.75 0 11-1.08 1.04l-3.96-4.158V16.25A.75.75 0 0110 17z" clipRule="evenodd" />
        </svg>
      )}
      {Math.abs(changePct).toFixed(1)}%
    </span>
  );
}

// ── Period selector — Today / Week / Month / Year ───────────────────────────

const PERIOD_LABELS: Record<KpiPeriod, string> = { today: 'Today', week: 'Week', month: 'Month', year: 'Year' };

function PeriodSelector({ value, onChange }: { value: KpiPeriod; onChange: (p: KpiPeriod) => void }) {
  return (
    <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
      {(Object.keys(PERIOD_LABELS) as KpiPeriod[]).map(p => (
        <button
          key={p}
          onClick={() => onChange(p)}
          className={`px-2.5 py-1 text-xs font-medium transition-colors ${
            value === p
              ? 'bg-blue-600 text-white'
              : 'bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
          }`}
        >
          {PERIOD_LABELS[p]}
        </button>
      ))}
    </div>
  );
}

// ── Section wrapper ───────────────────────────────────────────────────────────

function Section({ title, icon, children, loading, error, updatedAt, onRefresh }: {
  title: React.ReactNode; icon: React.ReactNode; children: React.ReactNode;
  loading?: boolean; error?: boolean;
  updatedAt?: number; onRefresh?: () => void;
}) {
  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 shadow-sm hover:shadow-md transition-shadow duration-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-800 flex items-center gap-2.5">
        <span className="w-7 h-7 rounded-lg bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 flex items-center justify-center flex-shrink-0">{icon}</span>
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

// ── Filter bar ────────────────────────────────────────────────────────────────

interface Filters { dateFrom: string; dateTo: string; groupBy: GroupBy; branchId: string; }

// ── Build query string ────────────────────────────────────────────────────────

function buildQs(filters: Filters): string {
  const p = new URLSearchParams();
  if (filters.dateFrom) p.set('dateFrom', filters.dateFrom);
  if (filters.dateTo)   p.set('dateTo',   filters.dateTo);
  if (filters.groupBy)  p.set('groupBy',  filters.groupBy);
  if (filters.branchId) p.set('branchId', filters.branchId);
  const s = p.toString();
  return s ? `?${s}` : '';
}

// ── Main DashboardPage ────────────────────────────────────────────────────────

export default function DashboardPage({ userRole, onNavigate }: DashboardPageProps) {
  const canView = ['Manager', 'Admin', 'Finance_Officer', 'Super_Admin'].includes(userRole ?? '');
  const isAllBranches = ['Super_Admin', 'Admin'].includes(userRole ?? '');
  const queryClient = useQueryClient();

  // Pre-populate branchId: Manager gets their own branch; Admin/Super_Admin get all branches (empty = all)
  const getInitialBranchId = () => {
    if (isAllBranches) return ''; // empty = all branches
    const branchId = getCurrentBranchId();
    return branchId ? String(branchId) : '';
  };

  const [filters, setFilters] = useState<Filters>({ dateFrom: '', dateTo: '', groupBy: 'day', branchId: getInitialBranchId() });
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [salesPeriod, setSalesPeriod] = useState<KpiPeriod>('today');
  const [exportOpen, setExportOpen] = useState(false);
  const qs = buildQs(filters);

  // Global refresh — invalidates and refetches all dashboard queries at once
  const handleRefreshAll = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await Promise.all([
        queryClient.refetchQueries({ queryKey: ['report-kpis'], exact: false }),
        queryClient.refetchQueries({ queryKey: ['report-kpis-period'], exact: false }),
        queryClient.refetchQueries({ queryKey: ['report-sales'], exact: false }),
        queryClient.refetchQueries({ queryKey: ['report-payments'], exact: false }),
        queryClient.refetchQueries({ queryKey: ['report-exchanges'], exact: false }),
        queryClient.refetchQueries({ queryKey: ['report-inventory'], exact: false }),
        queryClient.refetchQueries({ queryKey: ['report-customers'], exact: false }),
        queryClient.refetchQueries({ queryKey: ['report-gp-trend'], exact: false }),
        queryClient.refetchQueries({ queryKey: ['report-top-returned'], exact: false }),
        queryClient.refetchQueries({ queryKey: ['report-receivables-aging'], exact: false }),
      ]);
    } finally {
      setIsRefreshing(false);
    }
  }, [queryClient]);

  // Load branches for the branch selector (Admin/Super_Admin only)
  const { data: branchesData } = useQuery<{ items: Array<{ id: number; name: string }> }>({
    queryKey: ['dashboard-branches'],
    queryFn: () => api.get('/branches?pageSize=100'),
    enabled: isAllBranches,
    staleTime: 5 * 60_000,
  });

  // F-026: CSV export function
  const exportReport = async (type: string) => {
    const token = getAccessToken();
    const params = new URLSearchParams();
    if (filters.dateFrom) params.set('dateFrom', filters.dateFrom);
    if (filters.dateTo) params.set('dateTo', filters.dateTo);
    if (filters.branchId) params.set('branchId', filters.branchId);
    params.set('format', 'csv');
    const url = `/api/reports/${type}/export?${params.toString()}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token ?? ''}` } });
    if (!res.ok) { alert('Export failed'); return; }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${type}-report-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const { data: kpis, isLoading: kpiLoading, dataUpdatedAt: kpiUpdatedAt } = useQuery<KpiReport>({
    queryKey: ['report-kpis', filters.branchId],
    queryFn: () => api.get(`/reports/kpis${filters.branchId ? `?branchId=${filters.branchId}` : ''}`),
    enabled: canView,
    staleTime: 0,               // always refetch on mount — profit data must be fresh
    refetchInterval: 30_000,    // auto-refresh every 30s
    refetchOnWindowFocus: true,
  });

  const { data: sales, isLoading: salesLoading, isError: salesError, dataUpdatedAt: salesUpdatedAt, refetch: refetchSales } = useQuery<SalesReport>({
    queryKey: ['report-sales', qs],
    queryFn: () => api.get(`/reports/sales${qs}`),
    enabled: canView,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  const { data: payments, isLoading: payLoading, isError: payError, dataUpdatedAt: payUpdatedAt, refetch: refetchPayments } = useQuery<PaymentReport>({
    queryKey: ['report-payments', qs],
    queryFn: () => api.get(`/reports/payments${qs}`),
    enabled: canView,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  const { data: exchanges, isLoading: excLoading, isError: excError, dataUpdatedAt: excUpdatedAt, refetch: refetchExchanges } = useQuery<ExchangeReport>({
    queryKey: ['report-exchanges', qs],
    queryFn: () => api.get(`/reports/exchanges${qs}`),
    enabled: canView,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  const { data: inventory, isLoading: invLoading, isError: invError, dataUpdatedAt: invUpdatedAt, refetch: refetchInventory } = useQuery<InventoryReport>({
    queryKey: ['report-inventory', qs],
    queryFn: () => api.get(`/reports/inventory${qs}`),
    enabled: canView,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  const { data: customers, isLoading: custLoading, isError: custError, dataUpdatedAt: custUpdatedAt, refetch: refetchCustomers } = useQuery<CustomerReport>({
    queryKey: ['report-customers', qs],
    queryFn: () => api.get(`/reports/customers${qs}`),
    enabled: canView,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  // ── Prompt 2 — Sales Performance period selector ──────────────────────────
  const { data: periodKpis, isLoading: periodLoading } = useQuery<PeriodSalesKpis>({
    queryKey: ['report-kpis-period', salesPeriod, filters.branchId],
    queryFn: () => api.get(`/reports/kpis/period?period=${salesPeriod}${filters.branchId ? `&branchId=${filters.branchId}` : ''}`),
    enabled: canView,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  // ── Prompt 2 — Gross Profit Trend chart ───────────────────────────────────
  const { data: gpTrend, isLoading: gpLoading, isError: gpError, dataUpdatedAt: gpUpdatedAt, refetch: refetchGp } = useQuery<GrossProfitTrendPoint[]>({
    queryKey: ['report-gp-trend', qs],
    queryFn: () => api.get(`/reports/sales/gross-profit-trend${qs}`),
    enabled: canView,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  // ── Prompt 2 — Top Returned Books ─────────────────────────────────────────
  const { data: topReturned, isLoading: topReturnedLoading, isError: topReturnedError, dataUpdatedAt: topReturnedUpdatedAt, refetch: refetchTopReturned } = useQuery<TopReturnedBook[]>({
    queryKey: ['report-top-returned', qs],
    queryFn: () => api.get(`/reports/returns/top${qs}`),
    enabled: canView,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  // ── Prompt 2 — Receivables Aging Summary ──────────────────────────────────
  const { data: aging, isLoading: agingLoading, isError: agingError, dataUpdatedAt: agingUpdatedAt, refetch: refetchAging } = useQuery<{ byBucket: ReceivablesAgingBucket[] }>({
    queryKey: ['report-receivables-aging', filters.branchId],
    queryFn: () => api.get(`/reports/receivables-aging${filters.branchId ? `?branchId=${filters.branchId}` : ''}`),
    enabled: canView,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  if (!canView) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center space-y-2">
          <div className="mx-auto mb-3 text-gray-300 dark:text-gray-600"><svg className="w-12 h-12 text-gray-300 dark:text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg></div>
          <p className="text-gray-500 dark:text-gray-400 text-sm">Dashboard is available to Manager, Admin, and Finance Officer roles.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">

      {/* ── Welcome Banner — sits between the top bar and page content, outside scroll ── */}
      <WelcomeBanner />

    <div className="flex-1 overflow-y-auto">
    <div className="p-4 sm:p-6 space-y-5 max-w-7xl mx-auto pb-10">

      {/* ── Quick Actions ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'New Sale', icon: (<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" /></svg>), page: 'pos',         color: 'from-blue-500 to-blue-600',    desc: 'Open POS terminal' },
          { label: 'New Purchase', icon: (<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>), page: 'procurement', color: 'from-indigo-500 to-indigo-600', desc: 'Create purchase order' },
          { label: 'Add Customer', icon: (<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>), page: 'customers',   color: 'from-purple-500 to-purple-600', desc: 'Register new customer' },
          { label: 'Record Payment', icon: (<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" /></svg>), page: 'payments',    color: 'from-green-500 to-green-600',   desc: 'Record order payment' },
        ].map(action => (
          <button
            key={action.page}
            onClick={() => onNavigate?.(action.page)}
            className={`group relative overflow-hidden rounded-xl bg-gradient-to-br ${action.color} p-4 text-left text-white shadow-sm hover:shadow-md transition-all duration-200 hover:-translate-y-0.5 active:translate-y-0`}
          >
            <div className="absolute -right-3 -top-3 w-16 h-16 rounded-full bg-white/10 group-hover:bg-white/15 transition-colors" />
            <span className="text-2xl block mb-2">{action.icon}</span>
            <p className="text-sm font-semibold leading-tight">{action.label}</p>
            <p className="text-xs text-white/70 mt-0.5">{action.desc}</p>
          </button>
        ))}
      </div>

      {/* ── Toolbar: Filters + Export + Refresh, all on one line ──
          flex-nowrap keeps Export/Refresh/"Updated" pinned in line with
          the Filters controls instead of dropping to a second row —
          the row scrolls horizontally on overflow rather than wrapping. */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 shadow-sm overflow-hidden">
        <div className="px-4 py-3 flex flex-nowrap items-center gap-2 overflow-x-auto">
          <span className="flex-shrink-0 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Filters</span>
          <input type="date" value={filters.dateFrom} onChange={e => setFilters(f => ({ ...f, dateFrom: e.target.value }))}
            className="flex-shrink-0 px-2.5 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition-shadow [color-scheme:light] dark:[color-scheme:dark]" />
          <span className="flex-shrink-0 text-xs text-gray-400">to</span>
          <input type="date" value={filters.dateTo} onChange={e => setFilters(f => ({ ...f, dateTo: e.target.value }))}
            className="flex-shrink-0 px-2.5 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition-shadow [color-scheme:light] dark:[color-scheme:dark]" />
          <select value={filters.groupBy} onChange={e => setFilters(f => ({ ...f, groupBy: e.target.value as GroupBy }))}
            className="flex-shrink-0 px-2.5 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition-shadow">
            <option value="day">Daily</option>
            <option value="week">Weekly</option>
            <option value="month">Monthly</option>
          </select>
          {/* Branch selector — visible to Admin/Super_Admin who can see all branches */}
          {isAllBranches && (
            <select
              value={filters.branchId}
              onChange={e => setFilters(f => ({ ...f, branchId: e.target.value }))}
              className="flex-shrink-0 w-28 sm:w-36 px-2.5 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition-shadow truncate"
            >
              <option value="">All Branches</option>
              {(branchesData?.items ?? []).map(b => (
                <option key={b.id} value={String(b.id)}>{b.name}</option>
              ))}
            </select>
          )}
          <button onClick={() => setFilters({ dateFrom: '', dateTo: '', groupBy: 'day', branchId: getInitialBranchId() })}
            className="flex-shrink-0 px-2.5 py-1.5 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
            Clear
          </button>

          {/* ── Export toggle + Refresh — pinned in line with Filters, never wraps ── */}
          <div className="ml-auto flex-shrink-0 flex items-center gap-2">
            {kpiUpdatedAt > 0 && (
              <span className="flex-shrink-0 text-xs text-gray-400 dark:text-gray-500 whitespace-nowrap hidden 2xl:inline">
                Updated {new Date(kpiUpdatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
            )}
            <button
              onClick={() => setExportOpen(o => !o)}
              aria-expanded={exportOpen}
              className={`flex-shrink-0 flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg border whitespace-nowrap transition-colors ${
                exportOpen
                  ? 'bg-blue-50 dark:bg-blue-950/40 border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300'
                  : 'bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
              }`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" /></svg>
              Export
              <svg className={`w-3 h-3 transition-transform ${exportOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" /></svg>
            </button>
            <button
              onClick={handleRefreshAll}
              disabled={isRefreshing}
              title="Refresh all dashboard data"
              className="flex-shrink-0 flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white shadow-sm whitespace-nowrap transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <svg className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {isRefreshing ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>
        </div>

        {/* ── Export panel — collapsed by default to keep the toolbar compact ── */}
        {exportOpen && (
          <div className="px-4 py-3 border-t border-gray-100 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-800/30 flex flex-wrap gap-2 items-center">
            <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mr-1">Export CSV</span>
            {[
              { type: 'sales', label: 'Sales' },
              { type: 'returns', label: 'Returns' },
              // 'Payments' (a thin totals-only summary) and 'Customers' (a
              // legacy top-customers export unrelated to any Prompt 2 report/
              // KPI) were dropped from this row — Payments Ledger below is the
              // canonical, transaction-level payments export.
              { type: 'payments-ledger', label: 'Payments Ledger' },
              { type: 'inventory', label: 'Inventory' },
              { type: 'inventory-valuation', label: 'Inventory Valuation' },
              { type: 'exchanges', label: 'Exchanges' },
              { type: 'procurement', label: 'Procurement' },
              { type: 'receivables', label: 'Receivables' },
              { type: 'receivables-aging', label: 'Receivables Aging' },
            ].map(({ type, label }) => (
              <button key={type} onClick={() => exportReport(type)}
                className="px-2.5 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-blue-50 dark:hover:bg-blue-950/40 hover:border-blue-300 dark:hover:border-blue-700 hover:text-blue-700 dark:hover:text-blue-300 transition-colors whitespace-nowrap">
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── KPI Cards ──────────────────────────────────────────────────────────
          Dashboard Standardization & Unified Reports Engine — reorganized
          into a 3-tier financial-impact hierarchy: Primary (Profit & Net
          Sales, bold/accent-badged), Secondary (Cash Flow & Liquidity),
          Tertiary (Operational & Inventory Controls). All figures sourced
          from GET /reports/kpis (reportsService.getKpis(), backed by
          FinancialReportService for the Primary row's *Unified fields) — the
          same engine and rows that back the Sales CSV export, so these
          totals reconcile 1:1 with it for the same date range. ── */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 shadow-sm p-4 sm:p-5">
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
                  value={fmtShort(periodKpis?.netSales ?? 0)}
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
                  value={fmtShort(periodKpis?.grossProfit ?? 0)}
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
                  value={fmtShort(periodKpis?.cashCollected ?? kpis.dailyRevenue)}
                  sub="Settled payments · Payments module"
                  icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 9V7a4 4 0 00-8 0v2M5 9h14l1 12H4L5 9z" /></svg>}
                  color={kpiToneClass('positive')}
                  onClick={() => onNavigate?.('payments', { dateFrom: periodKpis?.dateFrom ?? '', dateTo: periodKpis?.dateTo ?? '', ...(filters.branchId ? { branchId: filters.branchId } : {}) })}
                />
                <KpiCard
                  label="Outstanding Receivables"
                  value={fmtShort(kpis.outstandingBalance)}
                  sub="Unpaid credit + exchange differences"
                  icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" /></svg>}
                  color={kpiToneClass(warningCountTone(kpis.outstandingBalance))}
                  onClick={() => onNavigate?.('receivables', { status: 'Pending,PartiallyPaid,Overdue', ...(filters.branchId ? { branchId: filters.branchId } : {}) })}
                />
                <KpiCard
                  label="Overdue Receivables"
                  value={fmtShort(kpis.overdueReceivablesAmount)}
                  sub="Past due date"
                  icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}
                  color={kpiToneClass(kpis.overdueReceivablesAmount > 0 ? 'critical' : 'informational')}
                  onClick={() => onNavigate?.('receivables', { status: 'Overdue', ...(filters.branchId ? { branchId: filters.branchId } : {}) })}
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
                  onClick={() => onNavigate?.('inventory', { lowStockOnly: 'true', ...(filters.branchId ? { branchId: filters.branchId } : {}) })}
                />
                <KpiCard
                  label="Inventory Value"
                  value={fmtShort(kpis.inventoryValue)}
                  sub="Qty on hand × average cost"
                  icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" /></svg>}
                  color={kpiToneClass('informational')}
                  onClick={() => onNavigate?.('inventory', { ...(filters.branchId ? { branchId: filters.branchId } : {}) })}
                />
                <KpiCard
                  label="Pending Customer Orders"
                  value={kpis.pendingOrders.toString()}
                  sub={kpis.pendingOrders > 0 ? 'Awaiting fulfillment' : 'All clear'}
                  icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>}
                  color={kpiToneClass(warningCountTone(kpis.pendingOrders))}
                  onClick={() => onNavigate?.('orders', { status: 'Confirmed,In_Progress,CONFIRMED,PAID', ...(filters.branchId ? { branchId: filters.branchId } : {}) })}
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
              onClick={() => onNavigate?.('inventory', { lowStockOnly: 'true', ...(filters.branchId ? { branchId: filters.branchId } : {}) })}
            >
              <div className="flex items-center gap-2 mb-3">
                <span className="text-amber-600 dark:text-amber-400 flex-shrink-0"><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg></span>
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
                  <p className="text-xs text-amber-600 dark:text-amber-400 pt-1">+{inventory.lowStockItems.length - 4} more — View Inventory View Inventory</p>
                )}
              </div>
            </div>
          )}

          {/* Pending orders */}
          {(kpis?.pendingOrders ?? 0) > 0 && (
            <div
              className="bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-xl p-4 cursor-pointer hover:border-orange-400 dark:hover:border-orange-600 transition-colors"
              onClick={() => onNavigate?.('orders', { status: 'Confirmed,In_Progress,CONFIRMED,PAID', ...(filters.branchId ? { branchId: filters.branchId } : {}) })}
            >
              <div className="flex items-center gap-2 mb-3">
                <span className="text-orange-600 dark:text-orange-400 flex-shrink-0"><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg></span>
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
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 cursor-pointer" onClick={() => onNavigate?.('receivables', { ...(filters.branchId ? { branchId: filters.branchId } : {}) })}>
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
                      <div key={`${item.bookId}-${item.locationId}`} className="flex items-center gap-2 text-xs bg-amber-50 dark:bg-amber-900/20 rounded px-2 py-1">
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

    </div>
    </div>
    </div>
  );
}
