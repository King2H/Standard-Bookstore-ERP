import { Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { AgingBucket } from '@bms/shared';
import { formatCurrency } from '../../../lib/currency.js';
import { useCurrency } from '../../../lib/useCurrency.js';
import type { ReportParams } from '../api.js';
import { useExchangeReport, usePaymentReport, useReceivablesAging, useTopReturnedBooks } from '../queries.js';
import { shortMoney } from './cards.js';
import { CHART_TOOLTIP_PROPS, Empty, methodName, periodLabel, PIE_COLORS, Section, sectionState, thousands } from './charts.js';

const BUCKET_COLORS: Record<AgingBucket, string> = {
  Current: 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300',
  '1-30':  'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300',
  '31-60': 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300',
  '61-90': 'bg-orange-50 dark:bg-orange-900/20 text-orange-700 dark:text-orange-300',
  '90+':   'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300',
};

export function PaymentMethods({ params }: { params: ReportParams }) {
  const currency = useCurrency();
  const query = usePaymentReport(params);
  const payments = query.data;
  return (
    <Section title="Payment Methods" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" /></svg>} {...sectionState(query)}>
      {payments && payments.byMethod.length > 0 ? (
        <>
          <div className="grid grid-cols-2 gap-2 mb-3 text-center">
            <div><p className="text-xs text-gray-500 dark:text-gray-400">Collected</p><p className="text-sm font-bold text-green-600 dark:text-green-400">{shortMoney(payments.summary.totalCollected, currency)}</p></div>
            <div><p className="text-xs text-gray-500 dark:text-gray-400">Refunded</p><p className="text-sm font-bold text-amber-600 dark:text-amber-400">{shortMoney(payments.summary.totalRefunded, currency)}</p></div>
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
                {payments.byMethod.map((m, i) => <Cell key={m.method} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
              </Pie>
              <Tooltip formatter={(v: number) => formatCurrency(v, currency)} {...CHART_TOOLTIP_PROPS} />
              <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, paddingTop: 4 }} formatter={methodName} />
            </PieChart>
          </ResponsiveContainer>
        </>
      ) : <Empty />}
    </Section>
  );
}

export function PaymentTrend({ params }: { params: ReportParams }) {
  const currency = useCurrency();
  const query = usePaymentReport(params);
  const payments = query.data;
  return (
    <Section title="Payment Trend" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>} {...sectionState(query)}>
      {payments && payments.byPeriod.length > 0 ? (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={payments.byPeriod.map(r => ({ ...r, period: periodLabel(r.period, params.groupBy) }))}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis dataKey="period" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 10 }} tickFormatter={thousands} />
            <Tooltip formatter={(v: number) => formatCurrency(v, currency)} {...CHART_TOOLTIP_PROPS} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="collected" name="Collected" fill="#3b82f6" radius={[4, 4, 0, 0]} />
            <Bar dataKey="refunded"  name="Refunded"  fill="#f59e0b" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      ) : <Empty />}
    </Section>
  );
}

export function ExchangeActivity({ params }: { params: ReportParams }) {
  const currency = useCurrency();
  const query = useExchangeReport(params);
  const exchanges = query.data;
  return (
    <Section title="Exchange Activity" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" /></svg>} {...sectionState(query)}>
      {exchanges ? (
        <>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 text-center">
              <p className="text-xs text-gray-500 dark:text-gray-400">Total Exchanges</p>
              <p className="text-xl font-bold text-gray-900 dark:text-white">{exchanges.summary.totalExchanges}</p>
            </div>
            <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 text-center">
              <p className="text-xs text-gray-500 dark:text-gray-400">Net Impact</p>
              <p className={`text-xl font-bold ${exchanges.summary.netExchangeImpact >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>{shortMoney(Math.abs(exchanges.summary.netExchangeImpact), currency)}</p>
            </div>
            <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3 text-center">
              <p className="text-xs text-gray-500 dark:text-gray-400">Incoming Value</p>
              <p className="text-sm font-bold text-blue-600 dark:text-blue-400">{shortMoney(exchanges.summary.totalIncomingValue, currency)}</p>
            </div>
            <div className="bg-purple-50 dark:bg-purple-900/20 rounded-lg p-3 text-center">
              <p className="text-xs text-gray-500 dark:text-gray-400">Outgoing Value</p>
              <p className="text-sm font-bold text-purple-600 dark:text-purple-400">{shortMoney(exchanges.summary.totalOutgoingValue, currency)}</p>
            </div>
          </div>
          {exchanges.bySettlementType.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">Settlement Distribution</p>
              {exchanges.bySettlementType.map(s => (
                <div key={s.settlementType} className="flex items-center gap-2">
                  <span className="text-xs text-gray-600 dark:text-gray-400 w-28 truncate">{s.settlementType.replace(/_/g, ' ')}</span>
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
  );
}

export function TopReturnedBooks({ params }: { params: ReportParams }) {
  const currency = useCurrency();
  const query = useTopReturnedBooks(params);
  const books = query.data;
  return (
    <Section title="Top Returned Books" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v0M3 10l6-6M3 10l6 6" /></svg>} {...sectionState(query)}>
      {books && books.length > 0 ? (
        <div className="space-y-1 max-h-56 overflow-y-auto">
          {books.slice(0, 8).map((b, i) => (
            <div key={b.bookId} className="flex items-center gap-2 text-xs">
              <span className="text-gray-400 w-4">{i + 1}.</span>
              <span className="flex-1 min-w-0 text-gray-700 dark:text-gray-300 truncate">{b.title}</span>
              <span className="text-gray-500 dark:text-gray-400 whitespace-nowrap">{b.unitsReturned} returned</span>
              <span className="text-red-600 dark:text-red-400 whitespace-nowrap">{shortMoney(b.refundValue, currency)}</span>
            </div>
          ))}
        </div>
      ) : <Empty />}
    </Section>
  );
}

/** Open balances now, by days past due; the dates do not apply, only the branch. */
export function AgingSummary({ branchId, onNavigate }: {
  branchId?: number;
  onNavigate?: (page: string, context?: Record<string, string>) => void;
}) {
  const currency = useCurrency();
  const query = useReceivablesAging(branchId);
  const aging = query.data;
  return (
    <Section title="Receivables Aging Summary" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>} {...sectionState(query)}>
      {aging && aging.byBucket.some(b => b.count > 0) ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 cursor-pointer" onClick={() => onNavigate?.('receivables')}>
          {aging.byBucket.map(b => (
            <div key={b.bucket} className={`rounded-lg p-3 text-center ${BUCKET_COLORS[b.bucket]}`}>
              <p className="text-xs font-medium">{b.bucket === 'Current' ? 'Current' : `${b.bucket} days`}</p>
              <p className="text-base font-bold">{shortMoney(b.totalOutstanding, currency)}</p>
              <p className="text-[10px] opacity-75">{b.count} invoice{b.count !== 1 ? 's' : ''}</p>
            </div>
          ))}
        </div>
      ) : <Empty />}
    </Section>
  );
}
