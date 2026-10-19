import { Money, type UnpaidItem, type UnpaidListResponse } from '@bms/shared';
import Pagination, { makePageSizeHandler } from '../../../components/Pagination.js';
import { useCurrency } from '../../../lib/useCurrency.js';
import { useMyProfile } from '../../account/queries.js';
import { canTakePayment, rowKey } from '../rules.js';

const money = (n: number) => Money.of(n).toFixed();

export const PAY_STATUS_COLORS: Record<string, string> = {
  unpaid: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
  partial: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
  paid: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  refunded: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
};

/**
 * What customers of the branch still owe: credit orders, POS credit sales and
 * exchange differences. The page holds the list, as its tab shows the count.
 */
export function PendingList({ data, isLoading, page, pageSize, setPage, setPageSize, onCollect }: {
  data: UnpaidListResponse | undefined;
  isLoading: boolean;
  page: number;
  pageSize: number;
  setPage: (page: number) => void;
  setPageSize: (pageSize: number) => void;
  onCollect: (item: UnpaidItem) => void;
}) {
  const currency = useCurrency();
  const { data: me } = useMyProfile();

  return (
    <div className="flex-1 overflow-auto p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Orders &amp; Credit Sales Awaiting Payment</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Select an order or POS credit sale to collect payment or record a partial payment.</p>
        </div>
        <span className="text-xs text-gray-400">{data?.total ?? 0} pending</span>
      </div>

      {isLoading ? (
        <div className="p-8 text-center text-gray-400">Loading...</div>
      ) : !data?.items.length ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <span className="text-5xl mb-3">✅</span>
          <p className="text-gray-500 dark:text-gray-400 font-medium">No pending payments</p>
          <p className="text-xs text-gray-400 mt-1">All orders are fully paid.</p>
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-x-auto">
          <table className="w-full text-sm min-w-[700px]">
            <thead className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
              <tr>
                {['Ref #', 'Customer', 'Channel', 'Total', 'Paid', 'Outstanding', 'Status', 'Date', 'Action'].map((h) => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {data.items.map((item) => (
                <tr key={rowKey(item)} className="hover:bg-blue-50/50 dark:hover:bg-blue-950/20 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs text-gray-700 dark:text-gray-300 whitespace-nowrap">
                    {item.orderNumber}
                    {item.sourceType === 'pos' && (
                      <span className="ml-1.5 px-1.5 py-0.5 bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300 text-[10px] rounded-sm font-semibold">POS Credit</span>
                    )}
                    {item.sourceType === 'exchange_difference' && (
                      <span className="ml-1.5 px-1.5 py-0.5 bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300 text-[10px] rounded-sm font-semibold">Exchange</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-600 dark:text-gray-400">
                    {item.customerName ? (
                      <div>
                        <p className="font-medium text-gray-900 dark:text-white">{item.customerName}</p>
                        <p className="text-gray-400">{item.customerCode}</p>
                      </div>
                    ) : <span className="text-gray-400 italic">Walk-in</span>}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400 capitalize">{item.channel.replace('_', ' ')}</td>
                  <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-white whitespace-nowrap">{currency} {money(item.total)}</td>
                  <td className="px-4 py-3 text-sm text-green-600 dark:text-green-400 whitespace-nowrap">{currency} {money(item.totalPaid)}</td>
                  <td className="px-4 py-3 text-sm font-bold text-red-600 dark:text-red-400 whitespace-nowrap">{currency} {money(item.outstanding)}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${PAY_STATUS_COLORS[item.paymentStatus] ?? ''}`}>{item.paymentStatus}</span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-400 whitespace-nowrap">{new Date(item.createdAt).toLocaleDateString()}</td>
                  <td className="px-4 py-3">
                    {canTakePayment(me) && (
                      <button onClick={() => onCollect(item)}
                        className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded-lg transition-colors whitespace-nowrap">
                        💰 Collect
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.items.length > 0 && (
        <Pagination
          page={page} pageSize={pageSize} total={data.total} totalPages={data.totalPages}
          onPageChange={setPage} onPageSizeChange={makePageSizeHandler(setPage, setPageSize)}
          itemLabel="pending payment"
        />
      )}
    </div>
  );
}
