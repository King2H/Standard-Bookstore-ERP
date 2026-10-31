import { useState } from 'react';
import { NewOrder } from '../components/NewOrder.js';
import { OrderList } from '../components/OrderList.js';

type Tab = 'list' | 'new';

/**
 * Orders: the branch's orders, and a new order or a draft being edited. The
 * list opens first; the Dashboard opens it for a status or a date range.
 */
export default function OrdersPage({ initialContext = {}, onNavigate }: {
  initialContext?: Record<string, string>;
  onNavigate?: (page: string, context?: Record<string, string>) => void;
}) {
  const [tab, setTab] = useState<Tab>('list');
  // The draft the form edits (#174), or none for a new order.
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <div className="flex flex-col h-full">
      <div className="flex gap-1 px-4 pt-3 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shrink-0">
        {(['new', 'list'] as Tab[]).map((t) => (
          <button key={t} id={`orders-tab-${t}`} onClick={() => { setTab(t); setEditing(null); }} className={`px-4 py-2 text-sm font-medium transition-colors ${tab === t ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
            {t === 'list' ? '📋 Orders' : '+ New Order'}
          </button>
        ))}
      </div>

      {tab === 'list' && <OrderList initialContext={initialContext} onNavigate={onNavigate} onEdit={(o) => { setEditing(o.id); setTab('new'); }} />}
      {tab === 'new' && <NewOrder key={editing ?? 'new'} draftId={editing} onDone={() => { setEditing(null); setTab('list'); }} />}
    </div>
  );
}
