import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useCurrency } from '../../../lib/useCurrency.js';
import type { ReportParams } from '../api.js';
import { useCustomerReport, useInventoryReport } from '../queries.js';
import { shortMoney } from './cards.js';
import { CHART_TOOLTIP_PROPS, Empty, periodLabel, Section, sectionState } from './charts.js';

export function InventoryInsights({ params }: { params: ReportParams }) {
  const currency = useCurrency();
  const query = useInventoryReport(params);
  const inventory = query.data;
  return (
    <Section title="Inventory Insights" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" /></svg>} {...sectionState(query)}>
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
              {/* The report counts counter (POS) sales only (owner decision 2a: say so). */}
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">Top Selling Books (POS)</p>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {inventory.topSellingBooks.slice(0, 8).map((b, i) => (
                  <div key={b.bookId} className="flex items-center gap-2 text-xs">
                    <span className="text-gray-400 w-4">{i + 1}.</span>
                    <span className="flex-1 min-w-0 text-gray-700 dark:text-gray-300 truncate">{b.title}</span>
                    <span className="text-gray-500 dark:text-gray-400 whitespace-nowrap">{b.unitsSold} sold</span>
                    <span className="text-green-600 dark:text-green-400 whitespace-nowrap">{shortMoney(b.revenue, currency)}</span>
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
  );
}

export function StockMovement({ params }: { params: ReportParams }) {
  const query = useInventoryReport(params);
  const inventory = query.data;
  return (
    <Section title="Stock Movement" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>} {...sectionState(query)}>
      {inventory && inventory.stockMovement.length > 0 ? (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={inventory.stockMovement.map(r => ({ ...r, period: periodLabel(r.period, params.groupBy) }))}>
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
  );
}

export function CustomerInsights({ params }: { params: ReportParams }) {
  const currency = useCurrency();
  const query = useCustomerReport(params);
  const customers = query.data;
  return (
    <Section title="Customer Insights" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>} {...sectionState(query)}>
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
                    <span className="text-blue-600 dark:text-blue-400 font-medium whitespace-nowrap">{shortMoney(c.totalSpend, currency)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      ) : <Empty />}
    </Section>
  );
}
