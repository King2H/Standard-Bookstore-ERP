import { useState } from 'react';
import { NewReturn } from '../components/NewReturn.js';
import { ReturnsHistory } from '../components/ReturnsHistory.js';

type Tab = 'new' | 'list';

/** Books brought back from a counter sale: a new return, and the branch's returns. */
export default function ReturnsPage() {
  const [tab, setTab] = useState<Tab>('new');

  return (
    <div className="flex flex-col h-full">
      <div className="flex gap-1 px-4 pt-3 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shrink-0">
        {(['new', 'list'] as Tab[]).map((t) => (
          <button key={t} id={`returns-tab-${t}`} onClick={() => setTab(t)} className={`px-4 py-2 text-sm font-medium transition-colors ${tab === t ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
            {t === 'new' ? '↩ New Return' : '📋 Returns History'}
          </button>
        ))}
      </div>

      {tab === 'new' && <NewReturn />}
      {tab === 'list' && <ReturnsHistory />}
    </div>
  );
}
