import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import WelcomeBanner from '../components/WelcomeBanner.js';
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { api, getAccessToken, getCurrentBranchId } from '../lib/api.js';

type Role = string;
interface DashboardPageProps { userRole?: Role; onNavigate?: (page: string) => void; }

// ── API types ─────────────────────────────────────────────────────────────────

interface KpiReport {
  dailyRevenue: number; monthlyRevenue: number; averageOrderValue: number;
  totalActiveCustomers: number; lowStockAlerts: number; pendingOrders: number; totalExchangesToday: number;
}
interface SalesReport {
  summary: { totalSales: number; totalOrders: number; averageOrderValue: number; totalPosSales: number; totalPosTransactions: number };
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

function KpiCard({ label, value, sub, icon, color, onClick }: { label: string; value: string; sub?: string; icon: string; color: string; onClick?: () => void }) {
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

function Section({ title, icon, children, loading, error }: { title: string; icon: string; children: React.ReactNode; loading?: boolean; error?: boolean }) {
  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-800 flex items-center gap-2">
        <span className="text-base">{icon}</span>
        <h2 className="text-sm font-semibold text-gray-900 dark:text-white">{title}</h2>
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
  const canView = ['Manager', 'Admin', 'Finance_Officer'].includes(userRole ?? '');

  // F-025: Pre-populate branchId for Manager role from JWT
  const getInitialBranchId = () => {
    if (userRole !== 'Manager') return '';
    const branchId = getCurrentBranchId();
    return branchId ? String(branchId) : '';
  };

  const [filters, setFilters] = useState<Filters>({ dateFrom: '', dateTo: '', groupBy: 'day', branchId: getInitialBranchId() });
  const qs = buildQs(filters);

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

  const { data: kpis, isLoading: kpiLoading, dataUpdatedAt } = useQuery<KpiReport>({
    queryKey: ['report-kpis', filters.branchId],
    queryFn: () => api.get(`/reports/kpis${filters.branchId ? `?branchId=${filters.branchId}` : ''}`),
    enabled: canView,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  const { data: sales, isLoading: salesLoading, isError: salesError } = useQuery<SalesReport>({
    queryKey: ['report-sales', qs],
    queryFn: () => api.get(`/reports/sales${qs}`),
    enabled: canView,
    staleTime: 60_000,
  });

  const { data: payments, isLoading: payLoading, isError: payError } = useQuery<PaymentReport>({
    queryKey: ['report-payments', qs],
    queryFn: () => api.get(`/reports/payments${qs}`),
    enabled: canView,
    staleTime: 60_000,
  });

  const { data: exchanges, isLoading: excLoading, isError: excError } = useQuery<ExchangeReport>({
    queryKey: ['report-exchanges', qs],
    queryFn: () => api.get(`/reports/exchanges${qs}`),
    enabled: canView,
    staleTime: 60_000,
  });

  const { data: inventory, isLoading: invLoading, isError: invError } = useQuery<InventoryReport>({
    queryKey: ['report-inventory', qs],
    queryFn: () => api.get(`/reports/inventory${qs}`),
    enabled: canView,
    staleTime: 60_000,
  });

  const { data: customers, isLoading: custLoading, isError: custError } = useQuery<CustomerReport>({
    queryKey: ['report-customers', qs],
    queryFn: () => api.get(`/reports/customers${qs}`),
    enabled: canView,
    staleTime: 60_000,
  });

  if (!canView) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center space-y-2">
          <p className="text-4xl">🔒</p>
          <p className="text-gray-500 dark:text-gray-400 text-sm">Dashboard is available to Manager and Admin roles only.</p>
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
          { label: 'New Sale',        icon: '🛒', page: 'pos',         color: 'from-blue-500 to-blue-600',    desc: 'Open POS terminal' },
          { label: 'New Purchase',    icon: '📋', page: 'procurement', color: 'from-indigo-500 to-indigo-600', desc: 'Create purchase order' },
          { label: 'Add Customer',    icon: '👤', page: 'customers',   color: 'from-purple-500 to-purple-600', desc: 'Register new customer' },
          { label: 'Record Payment',  icon: '💳', page: 'payments',    color: 'from-green-500 to-green-600',   desc: 'Record order payment' },
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

      {/* ── Filters row ── */}
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
        <button onClick={() => setFilters({ dateFrom: '', dateTo: '', groupBy: 'day', branchId: getInitialBranchId() })}
          className="px-2 py-1 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
          Clear
        </button>
      </div>

      {/* ── Export row ── */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 px-4 py-3 flex flex-wrap gap-3 items-center">
        <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Export CSV</span>
        <div className="w-px h-4 bg-gray-200 dark:bg-gray-700" />
        {[
          { type: 'sales',     label: '📊 Sales' },
          { type: 'payments',  label: '💳 Payments' },
          { type: 'inventory', label: '📦 Inventory' },
          { type: 'customers', label: '👤 Customers' },
          { type: 'exchanges', label: '🔁 Exchanges' },
        ].map(({ type, label }) => (
          <button key={type} onClick={() => exportReport(type)}
            className="px-2.5 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors whitespace-nowrap">
            {label}
          </button>
        ))}
      </div>

      {/* ── KPI Cards ── */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-gray-900 dark:text-white">Live Overview</span>
            <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse inline-block" />
              Live · 30s
            </span>
          </div>
          {dataUpdatedAt > 0 && (
            <span className="text-xs text-gray-400 dark:text-gray-500">
              Updated {new Date(dataUpdatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          {kpiLoading ? (
            Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3 h-20 animate-pulse" />
            ))
          ) : kpis ? (
            <>
              <KpiCard label="Today's Revenue"  value={fmtShort(kpis.dailyRevenue)}         icon="💰" color="bg-green-100 dark:bg-green-900/30"   onClick={() => onNavigate?.('payments')} />
              <KpiCard label="Monthly Revenue"  value={fmtShort(kpis.monthlyRevenue)}        icon="📈" color="bg-blue-100 dark:bg-blue-900/30"    onClick={() => onNavigate?.('payments')} />
              <KpiCard label="Avg Order Value"  value={fmtShort(kpis.averageOrderValue)}     icon="🧾" color="bg-indigo-100 dark:bg-indigo-900/30" onClick={() => onNavigate?.('orders')} />
              <KpiCard label="Active Customers" value={kpis.totalActiveCustomers.toString()} icon="👤" color="bg-purple-100 dark:bg-purple-900/30"  onClick={() => onNavigate?.('customers')} />
              <KpiCard label="Low Stock"        value={kpis.lowStockAlerts.toString()}       icon="⚠️" color="bg-amber-100 dark:bg-amber-900/30"   sub={kpis.lowStockAlerts > 0 ? 'Needs attention' : 'All good'} onClick={() => onNavigate?.('inventory')} />
              <KpiCard label="Pending Orders"   value={kpis.pendingOrders.toString()}        icon="📋" color="bg-orange-100 dark:bg-orange-900/30"  onClick={() => onNavigate?.('orders')} />
              <KpiCard label="Exchanges Today"  value={kpis.totalExchangesToday.toString()}  icon="🔁" color="bg-teal-100 dark:bg-teal-900/30"     onClick={() => onNavigate?.('exchanges')} />
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
              onClick={() => onNavigate?.('inventory')}
            >
              <div className="flex items-center gap-2 mb-3">
                <span className="text-base">⚠️</span>
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
                  <p className="text-xs text-amber-600 dark:text-amber-400 pt-1">+{inventory.lowStockItems.length - 4} more → View Inventory</p>
                )}
              </div>
            </div>
          )}

          {/* Pending orders */}
          {(kpis?.pendingOrders ?? 0) > 0 && (
            <div
              className="bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-xl p-4 cursor-pointer hover:border-orange-400 dark:hover:border-orange-600 transition-colors"
              onClick={() => onNavigate?.('orders')}
            >
              <div className="flex items-center gap-2 mb-3">
                <span className="text-base">📋</span>
                <h3 className="text-sm font-semibold text-orange-800 dark:text-orange-300">Pending Orders</h3>
                <span className="ml-auto text-xs font-medium bg-orange-200 dark:bg-orange-800 text-orange-800 dark:text-orange-200 px-2 py-0.5 rounded-full">
                  {kpis?.pendingOrders}
                </span>
              </div>
              <p className="text-xs text-gray-600 dark:text-gray-400">
                {kpis?.pendingOrders} order{(kpis?.pendingOrders ?? 0) !== 1 ? 's' : ''} awaiting confirmation or fulfillment.
              </p>
              <p className="text-xs text-orange-600 dark:text-orange-400 mt-2 font-medium">→ Go to Orders</p>
            </div>
          )}
        </div>
      )}

      {/* ── Row 1: Sales trend + Payment methods ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

        {/* Sales trend (2/3 width) */}
        <div className="lg:col-span-2">
          <Section title="Sales Trend" icon="📈" loading={salesLoading} error={salesError}>
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
        <Section title="Payment Methods" icon="💳" loading={payLoading} error={payError}>
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
                    formatter={(value: string) => value.replace('_', ' ')}
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
        <Section title="Sales by Branch" icon="🏪" loading={salesLoading} error={salesError}>
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
        <Section title="Exchange Activity" icon="🔁" loading={excLoading} error={excError}>
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
        <Section title="Inventory Insights" icon="📦" loading={invLoading} error={invError}>
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
                  <p className="text-xs font-medium text-amber-600 dark:text-amber-400 mb-2">⚠️ Low Stock Alerts</p>
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
        <Section title="Customer Insights" icon="👤" loading={custLoading} error={custError}>
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
        <Section title="Stock Movement" icon="📊" loading={invLoading} error={invError}>
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
        <Section title="Payment Trend" icon="💰" loading={payLoading} error={payError}>
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

    </div>
    </div>
    </div>
  );
}
