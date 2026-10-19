import { useState } from 'react';
import NewOrderLegacy from '../../../pages/NewOrderLegacy.js';
import { OrderList } from '../components/OrderList.js';

type Tab = 'list' | 'new';

/**
 * Orders: the branch's orders, and a new order. The list opens first; the
 * Dashboard opens it for a status or a date range.
 */
export default function OrdersPage({ userRole, userPermissions, initialContext = {}, onNavigate }: {
  userRole?: string;
  userPermissions?: string[];
  initialContext?: Record<string, string>;
  onNavigate?: (page: string, context?: Record<string, string>) => void;
}) {
  const [tab, setTab] = useState<Tab>('list');

  return (
    <div className="flex flex-col h-full">
      <div className="flex gap-1 px-4 pt-3 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shrink-0">
        {(['new', 'list'] as Tab[]).map((t) => (
          <button key={t} id={`orders-tab-${t}`} onClick={() => setTab(t)} className={`px-4 py-2 text-sm font-medium transition-colors ${tab === t ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
            {t === 'list' ? '📋 Orders' : '+ New Order'}
          </button>
        ))}
      </div>

      {tab === 'list' && <OrderList initialContext={initialContext} onNavigate={onNavigate} />}
      {tab === 'new' && <NewOrderLegacy userRole={userRole} userPermissions={userPermissions} onCreated={() => setTab('list')} />}
    </div>
  );
}
