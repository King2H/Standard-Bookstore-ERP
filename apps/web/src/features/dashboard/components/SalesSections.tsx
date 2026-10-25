import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatCurrency } from '../../../lib/currency.js';
import { useCurrency } from '../../../lib/useCurrency.js';
import type { ReportParams } from '../api.js';
import { useGrossProfitTrend, useSalesReport } from '../queries.js';
import { shortMoney } from './cards.js';
import { CHART_TOOLTIP_PROPS, Empty, periodLabel, Section, sectionState, thousands } from './charts.js';

const DISCOUNT_TYPES = ['Normal', 'Merchant', 'Special'] as const;

export function SalesTrend({ params }: { params: ReportParams }) {
  const currency = useCurrency();
  const query = useSalesReport(params);
  const sales = query.data;
  return (
    <Section title="Sales Trend" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg>} {...sectionState(query)}>
      {sales && sales.byPeriod.length > 0 ? (
        <>
          {/* Orders only, like the trend line and the branch chart; POS sales
              shown beside them rather than added in. */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <div className="text-center"><p className="text-xs text-gray-500 dark:text-gray-400">Order Sales</p><p className="text-base font-bold text-gray-900 dark:text-white">{shortMoney(sales.summary.totalSales, currency)}</p></div>
            <div className="text-center"><p className="text-xs text-gray-500 dark:text-gray-400">POS Sales</p><p className="text-base font-bold text-gray-900 dark:text-white">{shortMoney(sales.summary.totalPosSales, currency)}</p></div>
            <div className="text-center"><p className="text-xs text-gray-500 dark:text-gray-400">Orders</p><p className="text-base font-bold text-gray-900 dark:text-white">{sales.summary.totalOrders}</p></div>
            <div className="text-center"><p className="text-xs text-gray-500 dark:text-gray-400">Avg Order</p><p className="text-base font-bold text-gray-900 dark:text-white">{shortMoney(sales.summary.averageOrderValue, currency)}</p></div>
          </div>
          {/* Book sales and service income apart (#169), once a sale carried a service. */}
          {sales.summary.serviceIncome > 0 && (
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div className="text-center"><p className="text-xs text-gray-500 dark:text-gray-400">Book Sales</p><p className="text-base font-bold text-gray-900 dark:text-white">{shortMoney(sales.summary.bookSales, currency)}</p></div>
              <div className="text-center"><p className="text-xs text-gray-500 dark:text-gray-400">Service Income</p><p className="text-base font-bold text-gray-900 dark:text-white">{shortMoney(sales.summary.serviceIncome, currency)}</p></div>
            </div>
          )}
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={sales.byPeriod.map(r => ({ ...r, period: periodLabel(r.period, params.groupBy) }))}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="period" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={thousands} />
              <Tooltip formatter={(v: number) => formatCurrency(v, currency)} {...CHART_TOOLTIP_PROPS} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" dataKey="totalSales" name={`Order Sales (${currency})`} stroke="#3b82f6" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="totalOrders" name="Orders" stroke="#10b981" strokeWidth={2} dot={false} yAxisId={0} />
            </LineChart>
          </ResponsiveContainer>
        </>
      ) : <Empty />}
    </Section>
  );
}

export function BranchSales({ params }: { params: ReportParams }) {
  const currency = useCurrency();
  const query = useSalesReport(params);
  const sales = query.data;
  return (
    <Section title="Order Sales by Branch" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>} {...sectionState(query)}>
      {sales && sales.byBranch.length > 0 ? (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={sales.byBranch} layout="vertical">
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={thousands} />
            <YAxis type="category" dataKey="branchName" tick={{ fontSize: 10 }} width={80} />
            <Tooltip formatter={(v: number) => formatCurrency(v, currency)} {...CHART_TOOLTIP_PROPS} />
            <Bar dataKey="totalSales" name={`Order Sales (${currency})`} fill="#3b82f6" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      ) : <Empty />}
    </Section>
  );
}

/** Net sales and profit per day, week or month, as the filters group them (owner decision 3a). */
export function GrossProfitTrendSection({ params }: { params: ReportParams }) {
  const currency = useCurrency();
  const query = useGrossProfitTrend(params);
  const trend = query.data;
  return (
    <Section title="Gross Profit Trend" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>} {...sectionState(query)}>
      {trend && trend.length > 0 ? (
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={trend.map(r => ({ ...r, period: periodLabel(r.period, params.groupBy) }))}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis dataKey="period" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 10 }} tickFormatter={thousands} />
            <Tooltip formatter={(v: number) => formatCurrency(v, currency)} {...CHART_TOOLTIP_PROPS} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line type="monotone" dataKey="netSales" name="Net Sales" stroke="#3b82f6" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="grossProfit" name="Net Profit" stroke="#10b981" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      ) : <Empty />}
    </Section>
  );
}

/**
 * Discounts by the preset each sale line used (owner decision 1a; was: read
 * fields the API never sent, so the section never showed).
 */
export function DiscountSummary({ params }: { params: ReportParams }) {
  const currency = useCurrency();
  const query = useSalesReport(params);
  const summary = query.data?.summary;
  const colors: Record<(typeof DISCOUNT_TYPES)[number], string> = { Normal: 'bg-blue-500', Merchant: 'bg-purple-500', Special: 'bg-amber-500' };
  return (
    <Section title="Discount Summary" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" /></svg>} {...sectionState(query)}>
      {summary ? (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 text-center">
              <p className="text-xs text-gray-500 dark:text-gray-400">Total Discounts</p>
              <p className="text-lg font-bold text-gray-900 dark:text-white">{shortMoney(summary.discounts, currency)}</p>
            </div>
            <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3 text-center">
              <p className="text-xs text-gray-500 dark:text-gray-400">Normal</p>
              <p className="text-lg font-bold text-blue-600 dark:text-blue-400">{shortMoney(summary.discountsByType.Normal, currency)}</p>
            </div>
            <div className="bg-purple-50 dark:bg-purple-900/20 rounded-lg p-3 text-center">
              <p className="text-xs text-gray-500 dark:text-gray-400">Merchant</p>
              <p className="text-lg font-bold text-purple-600 dark:text-purple-400">{shortMoney(summary.discountsByType.Merchant, currency)}</p>
            </div>
            <div className="bg-amber-50 dark:bg-amber-900/20 rounded-lg p-3 text-center">
              <p className="text-xs text-gray-500 dark:text-gray-400">Special</p>
              <p className="text-lg font-bold text-amber-600 dark:text-amber-400">{shortMoney(summary.discountsByType.Special, currency)}</p>
            </div>
          </div>
          {summary.discounts > 0 && (
            <div className="mt-3 space-y-1.5">
              {DISCOUNT_TYPES.map(type => {
                const pct = (summary.discountsByType[type] / summary.discounts) * 100;
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
        </>
      ) : <Empty />}
    </Section>
  );
}
