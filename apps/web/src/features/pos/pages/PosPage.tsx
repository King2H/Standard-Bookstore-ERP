import { useState } from 'react';
import PosTerminalLegacy from '../../../pages/PosTerminalLegacy.js';
import { SalesHistory } from '../components/SalesHistory.js';

type Tab = 'pos' | 'history';

const KBD = 'px-1 py-0.5 rounded-sm bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 text-xs';

/**
 * The counter: the POS terminal and the branch's Sales History. The
 * Dashboard's Today's Sales opens the history for its dates.
 */
export default function PosPage({ userRole, userPermissions, initialContext = {}, onNavigate }: {
  userRole?: string;
  userPermissions?: string[];
  initialContext?: Record<string, string>;
  onNavigate?: (page: string, context?: Record<string, string>) => void;
}) {
  const [tab, setTab] = useState<Tab>(initialContext.dateFrom || initialContext.dateTo ? 'history' : 'pos');

  const tabBar = (
    <div className="flex items-center gap-1 px-4 pt-1.5 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shrink-0">
      {(['pos', 'history'] as Tab[]).map((t) => (
        <button
          key={t}
          id={`pos-tab-${t}`}
          onClick={() => setTab(t)}
          className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === t
              ? 'border-blue-600 text-blue-600 dark:text-blue-400 dark:border-blue-400'
              : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
          }`}
        >
          {t === 'pos' ? '🛒 POS Terminal' : '📋 Sales History'}
        </button>
      ))}
      <div className="ml-auto flex items-center gap-2 pb-1 text-xs text-gray-400 dark:text-gray-600 font-mono">
        <span><kbd className={KBD}>F8</kbd> Books</span>
        <span><kbd className={KBD}>F9</kbd> Customer</span>
        <span><kbd className={KBD}>Ctrl+↵</kbd> Checkout</span>
      </div>
    </div>
  );

  return (
    <PosTerminalLegacy
      userRole={userRole}
      userPermissions={userPermissions}
      tabBar={tabBar}
      view={tab}
      history={<SalesHistory initialDateFrom={initialContext.dateFrom} initialDateTo={initialContext.dateTo} onNavigate={onNavigate} />}
    />
  );
}
