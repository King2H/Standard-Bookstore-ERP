import { useEffect, useState } from 'react';
import { UnpaidSourceTypeSchema, type UnpaidItem } from '@bms/shared';
import { DEFAULT_PAGE_SIZE } from '../../../components/Pagination.js';
import { useToast } from '../../../components/Toast.js';
import { listUnpaid } from '../api.js';
import { CollectPayment } from '../components/CollectPayment.js';
import { PaymentHistory } from '../components/PaymentHistory.js';
import { PendingList } from '../components/PendingList.js';
import { useUnpaid } from '../queries.js';

type Tab = 'pending' | 'collect' | 'history';

const isDay = (v: string | undefined): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);

const TAB = 'px-4 py-2 text-sm font-medium transition-colors';
const IDLE = 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200';

/**
 * Payments: what customers owe, collecting it, and the payments taken. Orders,
 * Sales History and Receivables open Collect for one debt with `orderId` and
 * `sourceType` (an order, POS sale or receivable id, with 'order', 'pos' or
 * 'exchange_difference'). The Dashboard opens History on a period with
 * `tab: 'history'`, `dateFrom` and `dateTo`.
 */
export default function PaymentsPage({ initialContext = {} }: { initialContext?: Record<string, string> }) {
  const { showToast } = useToast();
  const { dateFrom, dateTo } = initialContext;
  const linkedRange = initialContext.tab === 'history' && isDay(dateFrom) && isDay(dateTo) ? { dateFrom, dateTo } : undefined;
  const [tab, setTab] = useState<Tab>(initialContext.tab === 'history' ? 'history' : 'pending');
  const [selected, setSelected] = useState<UnpaidItem | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const unpaid = useUnpaid({ page, pageSize }, tab === 'pending');

  function collect(item: UnpaidItem) {
    setSelected(item);
    setTab('collect');
  }

  function close() {
    setSelected(null);
    setTab('pending');
  }

  const { orderId, sourceType } = initialContext;
  useEffect(() => {
    const source = UnpaidSourceTypeSchema.safeParse(sourceType);
    if (!orderId || !source.success) return;
    let cancelled = false;
    listUnpaid({ entityId: orderId, sourceType: source.data, pageSize: 1 }).then(
      (res) => {
        if (cancelled) return;
        if (res.items[0]) collect(res.items[0]);
        else showToast('That item has no outstanding balance to collect (it may already be paid).', 'info');
      },
      () => { if (!cancelled) showToast('Could not load that item for payment collection.', 'error'); },
    );
    return () => { cancelled = true; };
  }, [orderId, sourceType]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex gap-1 px-4 pt-3 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shrink-0">
        <button onClick={() => setTab('pending')} className={`${TAB} flex items-center gap-2 ${tab === 'pending' ? 'border-b-2 border-blue-600 text-blue-600' : IDLE}`}>
          ⏳ Pending Payments
          {unpaid.data && unpaid.data.total > 0 && (
            <span className="px-1.5 py-0.5 bg-red-500 text-white text-xs rounded-full leading-none font-semibold">{unpaid.data.total}</span>
          )}
        </button>
        {selected && (
          <button onClick={() => setTab('collect')} className={`${TAB} ${tab === 'collect' ? 'border-b-2 border-green-600 text-green-600' : IDLE}`}>
            💰 Collect — {selected.orderNumber}
          </button>
        )}
        <button onClick={() => setTab('history')} className={`${TAB} ${tab === 'history' ? 'border-b-2 border-blue-600 text-blue-600' : IDLE}`}>
          📋 Payment History
        </button>
      </div>

      {tab === 'pending' && (
        <PendingList data={unpaid.data} isLoading={unpaid.isLoading} page={page} pageSize={pageSize}
          setPage={setPage} setPageSize={setPageSize} onCollect={collect} />
      )}
      {tab === 'collect' && selected && <CollectPayment key={`${selected.sourceType}:${selected.id}`} item={selected} onDone={close} onCancel={close} />}
      {tab === 'history' && <PaymentHistory initialRange={linkedRange} />}
    </div>
  );
}
