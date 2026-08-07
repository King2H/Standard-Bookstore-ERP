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
  procurementExpense: number;
  grossProfit: number;
  dailyNetProfit: number;
  monthlyNetProfit: number;
}
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
  summary: { totalBooks: number; totalStockUnits: number; lowStockItems: number; outOfStockItems: number };
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

type GroupBy = 'day' | 'week' | 'month';

// ── KPI Card ──────────────────────────────────────────────────────────────────

function KpiCard({ label, value, sub, icon, color, onClick }: { label: string; value: string; sub?: string; icon: React.ReactNode; color: string; onClick?: () => void }) {
  return (
    <div
      onClick={onClick}
      className={`bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-3 flex flex-col gap-2 min-w-0 ${onClick ? 'cursor-pointer hover:border-blue-300 dark:hover:border-blue-700 hover:shadow-sm transition-all duration-150' : ''}`}
    >
      <div className="flex items-center gap-2">
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-base flex-shrink-0 ${color}`}>{icon}</div>
        <p className="text-xs text-gray-500 dark:text-gray-400 font-medium leading-tight">{label}</p>
      </div>
      <p className="text-xl font-bold text-gray-900 dark:text-white leading-none pl-1">{value}</p>
      {sub && <p className="text-xs text-gray-400 dark:text-gray-500 pl-1">{sub}</p>}
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
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-800 flex items-center gap-2">
        <span className="text-base">{icon}</span>
        <h2 className="text-sm font-semibold text-gray-900 dark:text-white">{title}</h2>
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
  const qs = buildQs(filters);

  // Global refresh — invalidates and refetches all dashboard queries at once
  const handleRefreshAll = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await Promise.all([
        queryClient.refetchQueries({ queryKey: ['report-kpis'], exact: false }),
        queryClient.refetchQueries({ queryKey: ['report-sales'], exact: false }),
        queryClient.refetchQueries({ queryKey: ['report-payments'], exact: false }),
        queryClient.refetchQueries({ queryKey: ['report-exchanges'], exact: false }),
        queryClient.refetchQueries({ queryKey: ['report-inventory'], exact: false }),
        queryClient.refetchQueries({ queryKey: ['report-customers'], exact: false }),
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
    <div className="p-4 space-y-4 max-w-7xl mx-auto pb-8">

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

      {/* ── Filters + Refresh row ── */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 px-4 py-3 flex flex-wrap gap-3 items-center">
        <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Filters</span>
        <input type="date" value={filters.dateFrom} onChange={e => setFilters(f => ({ ...f, dateFrom: e.target.value }))}
          className="px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500" />
        <span className="text-xs text-gray-400">to</span>
        <input type="date" value={filters.dateTo} onChange={e => setFilters(f => ({ ...f, dateTo: e.target.value }))}
          className="px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500" />
        <select value={filters.groupBy} onChange={e => setFilters(f => ({ ...f, groupBy: e.target.value as GroupBy }))}
          className="px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500">
          <option value="day">Daily</option>
          <option value="week">Weekly</option>
          <option value="month">Monthly</option>
        </select>
        {/* Branch selector — visible to Admin/Super_Admin who can see all branches */}
        {isAllBranches && (
          <select
            value={filters.branchId}
            onChange={e => setFilters(f => ({ ...f, branchId: e.target.value }))}
            className="px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="">All Branches</option>
            {(branchesData?.items ?? []).map(b => (
              <option key={b.id} value={String(b.id)}>{b.name}</option>
            ))}
          </select>
        )}
        <button onClick={() => setFilters({ dateFrom: '', dateTo: '', groupBy: 'day', branchId: getInitialBranchId() })}
          className="px-2 py-1 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
          Clear
        </button>

        {/* ── Refresh button — always visible ── */}
        <div className="ml-auto flex items-center gap-2">
          {kpiUpdatedAt > 0 && (
            <span className="text-xs text-gray-400 dark:text-gray-500 hidden sm:inline">
              Updated {new Date(kpiUpdatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          )}
          <button
            onClick={handleRefreshAll}
            disabled={isRefreshing}
            title="Refresh all dashboard data"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <svg className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {isRefreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* ── Export row ── */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 px-4 py-3 flex flex-wrap gap-3 items-center">
        <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Export CSV</span>
        <div className="w-px h-4 bg-gray-200 dark:bg-gray-700" />
        {[
          { type: 'sales', label: 'Sales' },
          { type: 'payments', label: 'Payments' },
          { type: 'inventory', label: 'Inventory' },
          { type: 'customers', label: 'Customers' },
          { type: 'exchanges', label: 'Exchanges' },
          { type: 'procurement', label: 'Procurement' },
          { type: 'receivables', label: 'Receivables' },
        ].map(({ type, label }) => (
          <button key={type} onClick={() => exportReport(type)}
            className="px-2.5 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors whitespace-nowrap">
            {label}
          </button>
        ))}
      </div>

      {/* ── KPI Cards ── */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-sm font-semibold text-gray-900 dark:text-white">Live Overview</span>
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
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {kpiLoading ? (
            Array.from({ length: 10 }).map((_, i) => (
              <div key={i} className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3 h-20 animate-pulse" />
            ))
          ) : kpis ? (
            <>
              {/* Row 1 — Revenue & Profit */}
              <KpiCard
                label="Monthly Sales"
                value={fmtShort(kpis.monthlySales)}
                sub="All channels · this month"
                icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>}
                color="bg-blue-100 dark:bg-blue-900/30"
                onClick={() => {
                  const now = new Date();
                  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
                  const today = now.toISOString().slice(0, 10);
                  onNavigate?.('orders', { dateFrom: monthStart, dateTo: today, ...(filters.branchId ? { branchId: filters.branchId } : {}) });
                }}
              />
              <KpiCard
                label="Today's Sales"
                value={fmtShort(kpis.dailySales)}
                sub="Orders + POS + Exchanges"
                icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z" /></svg>}
                color="bg-indigo-100 dark:bg-indigo-900/30"
                onClick={() => {
                  const today = new Date().toISOString().slice(0, 10);
                  onNavigate?.('pos', { dateFrom: today, dateTo: today, ...(filters.branchId ? { branchId: filters.branchId } : {}) });
                }}
              />
              <KpiCard
                label="Gross Profit"
                value={fmtShort(kpis.grossProfit)}
                sub="Fulfilled revenue − cost"
                icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg>}
                color={kpis.grossProfit >= 0 ? 'bg-emerald-100 dark:bg-emerald-900/30' : 'bg-red-100 dark:bg-red-900/30'}
              />
              <KpiCard
                label="Today's Net Profit"
                value={fmtShort(kpis.dailyNetProfit)}
                sub="Today · after cost & returns"
                icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}
                color={kpis.dailyNetProfit >= 0 ? 'bg-green-100 dark:bg-green-900/30' : 'bg-red-100 dark:bg-red-900/30'}
              />
              <KpiCard
                label="Monthly Net Profit"
                value={fmtShort(kpis.monthlyNetProfit)}
                sub="This month · after cost & returns"
                icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z" /></svg>}
                color={kpis.monthlyNetProfit >= 0 ? 'bg-teal-100 dark:bg-teal-900/30' : 'bg-red-100 dark:bg-red-900/30'}
              />

              {/* Row 2 — Credit & Operational */}
              <KpiCard
                label="Outstanding Credit"
                value={fmtShort(kpis.outstandingBalance)}
                sub="Unpaid receivables"
                icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" /></svg>}
                color={kpis.outstandingBalance > 0 ? 'bg-rose-100 dark:bg-rose-900/30' : 'bg-gray-100 dark:bg-gray-800'}
                onClick={() => onNavigate?.('receivables', { status: 'Pending,PartiallyPaid,Overdue', ...(filters.branchId ? { branchId: filters.branchId } : {}) })}
              />
              <KpiCard
                label="Discount Total"
                value={fmtShort(kpis.totalDiscounts)}
                sub="Fulfilled orders · all types"
                icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M17 17h.01M7 17L17 7M6 3h12a3 3 0 013 3v12a3 3 0 01-3 3H6a3 3 0 01-3-3V6a3 3 0 013-3z" /></svg>}
                color="bg-orange-100 dark:bg-orange-900/30"
              />
              <KpiCard
                label="Procurement Expense"
                value={fmtShort(kpis.procurementExpense)}
                sub="Received POs · this month"
                icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>}
                color="bg-violet-100 dark:bg-violet-900/30"
                onClick={() => {
                  const now = new Date();
                  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
                  const today = now.toISOString().slice(0, 10);
                  onNavigate?.('procurement', { dateFrom: monthStart, dateTo: today, ...(filters.branchId ? { branchId: filters.branchId } : {}) });
                }}
              />
              <KpiCard
                label="Pending Orders"
                value={kpis.pendingOrders.toString()}
                sub={kpis.pendingOrders > 0 ? 'Awaiting action' : 'All clear'}
                icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>}
                color={kpis.pendingOrders > 0 ? 'bg-amber-100 dark:bg-amber-900/30' : 'bg-gray-100 dark:bg-gray-800'}
                onClick={() => onNavigate?.('orders', { status: 'Confirmed,In_Progress,CONFIRMED,PAID', ...(filters.branchId ? { branchId: filters.branchId } : {}) })}
              />
              <KpiCard
                label="Low Stock"
                value={kpis.lowStockAlerts.toString()}
                sub={kpis.lowStockAlerts > 0 ? 'Needs attention' : 'All good'}
                icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>}
                color={kpis.lowStockAlerts > 0 ? 'bg-amber-100 dark:bg-amber-900/30' : 'bg-gray-100 dark:bg-gray-800'}
                onClick={() => onNavigate?.('inventory', { lowStockOnly: 'true', ...(filters.branchId ? { branchId: filters.branchId } : {}) })}
              />
            </>
          ) : null}
        </div>
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
                    <span className="flex-1 text-gray-700 dark:text-gray-300 truncate">{item.title}</span>
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
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

        {/* Sales trend (2/3 width) */}
        <div className="lg:col-span-2">
          <Section title="Sales Trend" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg>} loading={salesLoading} error={salesError} updatedAt={salesUpdatedAt} onRefresh={() => refetchSales()}>
            {sales?.byPeriod && sales.byPeriod.length > 0 ? (
              <>
                <div className="grid grid-cols-3 gap-3 mb-4">
                  <div className="text-center"><p className="text-xs text-gray-500 dark:text-gray-400">Total Sales</p><p className="text-base font-bold text-gray-900 dark:text-white">{fmtShort(sales.summary.totalSales)}</p></div>
                  <div className="text-center"><p className="text-xs text-gray-500 dark:text-gray-400">Orders</p><p className="text-base font-bold text-gray-900 dark:text-white">{sales.summary.totalOrders}</p></div>
                  <div className="text-center"><p className="text-xs text-gray-500 dark:text-gray-400">Avg Order</p><p className="text-base font-bold text-gray-900 dark:text-white">{fmtShort(sales.summary.averageOrderValue)}</p></div>
                </div>
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={sales.byPeriod.map(r => ({ ...r, period: fmtPeriod(r.period) }))}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis dataKey="period" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `${(v/1000).toFixed(0)}K`} />
                    <Tooltip formatter={(v: number) => fmt(v)} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line type="monotone" dataKey="totalSales" name="Sales (ETB)" stroke="#3b82f6" strokeWidth={2} dot={false} />
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
                  <Tooltip formatter={(v: number) => fmt(v)} />
                  <Legend
                    iconType="circle"
                    iconSize={8}
                    wrapperStyle={{ fontSize: 11, paddingTop: 4 }}
                    formatter={(value: string) => {
                      const clean = value.replace('_', ' ');
                      if (clean === 'store credit' || clean === 'mobile' || clean === 'store_credit') {
                        return 'Telebirr';
                      }
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
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* Sales by branch */}
        <Section title="Sales by Branch" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>} loading={salesLoading} error={salesError} updatedAt={salesUpdatedAt} onRefresh={() => refetchSales()}>
          {sales?.byBranch && sales.byBranch.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={sales.byBranch} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={v => `${(v/1000).toFixed(0)}K`} />
                <YAxis type="category" dataKey="branchName" tick={{ fontSize: 10 }} width={80} />
                <Tooltip formatter={(v: number) => fmt(v)} />
                <Bar dataKey="totalSales" name="Sales (ETB)" fill="#3b82f6" radius={[0, 4, 4, 0]} />
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

      {/* ── Row 3: Inventory + Customer insights ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* Inventory panel */}
        <Section title="Inventory Insights" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" /></svg>} loading={invLoading} error={invError} updatedAt={invUpdatedAt} onRefresh={() => refetchInventory()}>
          {inventory ? (
            <>
              <div className="grid grid-cols-4 gap-2 mb-4">
                {[
                  { label: 'Books', value: inventory.summary.totalBooks, color: 'text-gray-900 dark:text-white' },
                  { label: 'Units', value: inventory.summary.totalStockUnits, color: 'text-gray-900 dark:text-white' },
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
                        <span className="flex-1 text-gray-700 dark:text-gray-300 truncate">{b.title}</span>
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
                        <span className="flex-1 text-gray-700 dark:text-gray-300 truncate">{item.title}</span>
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
                        <span className="flex-1 text-gray-700 dark:text-gray-300 truncate">{c.fullName}</span>
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
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* Stock movement */}
        <Section title="Stock Movement" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>} loading={invLoading} error={invError} updatedAt={invUpdatedAt} onRefresh={() => refetchInventory()}>
          {inventory?.stockMovement && inventory.stockMovement.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={inventory.stockMovement.map(r => ({ ...r, period: fmtPeriod(r.period) }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="period" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip />
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
                <Tooltip formatter={(v: number) => fmt(v)} />
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
