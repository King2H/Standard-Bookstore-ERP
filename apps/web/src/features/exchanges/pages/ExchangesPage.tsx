import { useState } from 'react';
import { useMyProfile } from '../../account/queries.js';
import { ExchangeList } from '../components/ExchangeList.js';
import { QuickExchange } from '../components/QuickExchange.js';
import { canExchange } from '../rules.js';

type Tab = 'new' | 'list';

/**
 * Exchanges at the counter: a Quick Exchange, and the branch's exchanges.
 * The list opens first; the Quick Exchange tab is shown first.
 */
export default function ExchangesPage() {
  const { data: me } = useMyProfile();
  const [tab, setTab] = useState<Tab>('list');

  return (
    <div className="flex flex-col h-full">
      <div className="flex gap-1 px-4 pt-3 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shrink-0">
        {([
          { key: 'new', label: '⚡ Quick Exchange' },
          { key: 'list', label: '🔁 Exchanges' },
        ] as { key: Tab; label: string }[]).map(({ key, label }) => (
          <button key={key} id={`exchanges-tab-${key}`} onClick={() => setTab(key)} className={`px-4 py-2 text-sm font-medium transition-colors ${tab === key ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'list' && <ExchangeList />}
      {tab === 'new' && canExchange(me) && <QuickExchange onDone={() => setTab('list')} />}
    </div>
  );
}
