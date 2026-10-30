import { useState } from 'react';
import { Money } from '@bms/shared';
import { useToast } from '../../../components/Toast.js';
import { exportSupplierLedger } from '../api.js';
import { useSupplierLedger } from '../queries.js';
import { amount } from './shared.js';

const TYPE_COLORS: Record<string, string> = {
  PO: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  GOODS_RECEIPT: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  PAYMENT: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  PAYMENT_REVERSAL: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
  CREDIT_NOTE: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
  SUPPLIER_REFUND: 'bg-teal-100 text-teal-700 dark:bg-teal-900 dark:text-teal-300',
};

const DATE = 'border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500';

/**
 * A ledger day as the database dated it (YYYY-MM-DD), shown on that day in
 * every timezone (was: read as UTC midnight, so the day before west of UTC).
 */
const ledgerDay = (day: string) => new Date(`${day}T00:00:00`).toLocaleDateString();

/** What the store owes a supplier, entry by entry, newest first. */
export function SupplierLedger({ supplierId, supplierName, onBack }: { supplierId: number; supplierName: string; onBack: () => void }) {
  const { showToast } = useToast();
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const params = { dateFrom: dateFrom || undefined, dateTo: dateTo || undefined };
  const { data, isLoading, dataUpdatedAt, refetch, isFetching } = useSupplierLedger(supplierId, params);

  // The API sends entries oldest first, for the running balance; a statement reads newest first.
  const entries = [...(data?.entries ?? [])].reverse();

  async function exportCsv() {
    const filename = `supplier-ledger-${supplierId}-${new Date().toISOString().slice(0, 10)}.csv`;
    // A failed export says so (was: nothing happened).
    await exportSupplierLedger(supplierId, params, filename).catch((e: Error) => showToast(e.message || 'Export failed', 'error'));
  }

  return (
    <div className="p-6 space-y-4 max-w-4xl mx-auto">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">← Back</button>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Supplier Ledger — {supplierName}</h2>
        <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse inline-block" />
          Live · 30s
        </span>
        {dataUpdatedAt > 0 && (
          <span className="text-xs text-gray-400 dark:text-gray-500">
            · Updated {new Date(dataUpdatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </span>
        )}
        <button onClick={() => refetch()} disabled={isFetching} title="Refresh now"
          className="ml-auto flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-950/40 disabled:opacity-40 transition-colors">
          <svg className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          {isFetching ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="ledger-from" className="block text-xs text-gray-500 dark:text-gray-400 mb-1">From</label>
          <input id="ledger-from" type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className={DATE} />
        </div>
        <div>
          <label htmlFor="ledger-to" className="block text-xs text-gray-500 dark:text-gray-400 mb-1">To</label>
          <input id="ledger-to" type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className={DATE} />
        </div>
        <button onClick={exportCsv} className="px-3 py-2 text-xs font-medium border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
          Export CSV
        </button>
        <div className="ml-auto text-right">
          <div className="text-xs text-gray-500 dark:text-gray-400">Current Balance Owed</div>
          <div className="text-lg font-semibold text-gray-900 dark:text-white">{amount(data?.currentBalance ?? 0)}</div>
        </div>
      </div>

      {entries.length > 0 && (
        <p className="text-xs text-gray-400 dark:text-gray-500">{entries.length} {entries.length === 1 ? 'entry' : 'entries'} · newest first</p>
      )}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-gray-400">Loading...</div>
        ) : entries.length === 0 ? (
          <div className="p-8 text-center text-gray-400">No ledger activity for this supplier.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
              <tr>{['Date', 'Type', 'Reference', 'Description', 'Amount', 'Balance'].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">{h}</th>
              ))}</tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {entries.map((e, i) => {
                const value = Money.of(e.amount);
                return (
                  <tr key={i} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400 whitespace-nowrap">{ledgerDay(e.date)}</td>
                    <td className="px-4 py-3"><span className={`text-xs font-medium px-2 py-0.5 rounded-full ${TYPE_COLORS[e.type] ?? 'bg-gray-100 text-gray-700'}`}>{e.type.replace(/_/g, ' ')}</span></td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-400">{e.reference}</td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{e.description}</td>
                    <td className={`px-4 py-3 font-medium ${value.greaterThan(0) ? 'text-green-600 dark:text-green-400' : value.isNegative() ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}`}>
                      {value.greaterThan(0) ? '+' : ''}{amount(value)}
                    </td>
                    <td className="px-4 py-3 font-semibold text-gray-900 dark:text-white">{amount(e.balance)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
