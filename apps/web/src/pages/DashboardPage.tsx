import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { api } from '../lib/api.js';

type Role = string;
interface DashboardPageProps { userRole?: Role; }

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

function KpiCard({ label, value, sub, icon, color }: { label: string; value: string; sub?: string; icon: string; color: string }) {
  return (
    <div className={`bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 flex items-start gap-3`}>
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center text-lg flex-shrink-0 ${color}`}>{icon}</div>
      <div className="min-w-0">
        <p className="text-xs text-gray-500 dark:text-gray-400 font-medium truncate">{label}</p>
        <p className="text-lg font-bold text-gray-900 dark:text-white leading-tight truncate">{value}</p>
        {sub && <p className="text-xs text-gray-400 dark:text-gray-500 truncate">{sub}</p>}
      </div>
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

function FilterBar({ filters, onChange }: { filters: Filters; onChange: (f: Filters) => void }) {
  return (
    <div className="flex flex-wrap gap-2 items-center bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 px-4 py-3">
      <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Filters:</span>
      <input type="date" value={filters.dateFrom} onChange={e => onChange({ ...filters, dateFrom: e.target.value })}
        className="px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500" />
      <span className="text-xs text-gray-400">to</span>
      <input type="date" value={filters.dateTo} onChange={e => onChange({ ...filters, dateTo: e.target.value })}
        className="px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500" />
      <select value={filters.groupBy} onChange={e => onChange({ ...filters, groupBy: e.target.value as GroupBy })}
        className="px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500">
        <option value="day">Daily</option>
        <option value="week">Weekly</option>
        <option value="month">Monthly</option>
      </select>
      <button onClick={() => onChange({ dateFrom: '', dateTo: '', groupBy: 'day', branchId: '' })}
        className="px-2 py-1 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
        Clear
      </button>
    </div>
  );
}

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

export default function DashboardPage({ userRole }: DashboardPageProps) {
  const canView = ['Manager', 'Admin'].includes(userRole ?? '');

  const [filters, setFilters] = useState<Filters>({ dateFrom: '', dateTo: '', groupBy: 'day', branchId: '' });
  const qs = buildQs(filters);

  const { data: kpis, isLoading: kpiLoading } = useQuery<KpiReport>({
    queryKey: ['report-kpis', filters.branchId],
    queryFn: () => api.get(`/reports/kpis${filters.branchId ? `?branchId=${filters.branchId}` : ''}`),
    enabled: canView,
    staleTime: 60_000,
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
    <div className="p-4 space-y-4 max-w-7xl mx-auto">

      {/* ── Filter bar ── */}
      <FilterBar filters={filters} onChange={setFilters} />

      {/* ── KPI Cards ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7 gap-3">
        {kpiLoading ? (
          Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 h-20 animate-pulse" />
          ))
        ) : kpis ? (
          <>
            <KpiCard label="Today's Revenue"    value={fmtShort(kpis.dailyRevenue)}         icon="💰" color="bg-green-100 dark:bg-green-900/30" />
            <KpiCard label="Monthly Revenue"    value={fmtShort(kpis.monthlyRevenue)}        icon="📈" color="bg-blue-100 dark:bg-blue-900/30" />
            <KpiCard label="Avg Order Value"    value={fmtShort(kpis.averageOrderValue)}     icon="🧾" color="bg-indigo-100 dark:bg-indigo-900/30" />
            <KpiCard label="Active Customers"   value={kpis.totalActiveCustomers.toString()} icon="👤" color="bg-purple-100 dark:bg-purple-900/30" />
            <KpiCard label="Low Stock Alerts"   value={kpis.lowStockAlerts.toString()}       icon="⚠️" color="bg-amber-100 dark:bg-amber-900/30" sub={kpis.lowStockAlerts > 0 ? 'Needs attention' : 'All good'} />
            <KpiCard label="Pending Orders"     value={kpis.pendingOrders.toString()}        icon="📋" color="bg-orange-100 dark:bg-orange-900/30" />
            <KpiCard label="Exchanges Today"    value={kpis.totalExchangesToday.toString()}  icon="🔁" color="bg-teal-100 dark:bg-teal-900/30" />
          </>
        ) : null}
      </div>

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
              <ResponsiveContainer width="100%" height={160}>
                <PieChart>
                  <Pie data={payments.byMethod} dataKey="total" nameKey="method" cx="50%" cy="50%" outerRadius={60} label={({ method, percent }) => `${method} ${(percent * 100).toFixed(0)}%`} labelLine={false}>
                    {payments.byMethod.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                  </Pie>
                  <Tooltip formatter={(v: number) => fmt(v)} />
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
  );
}
