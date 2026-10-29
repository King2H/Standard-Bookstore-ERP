import { useState } from 'react';
import { Terminal } from '../components/Terminal.js';
import { SalesHistory } from '../components/SalesHistory.js';
import { CashTab, REQUIRED_NOTICE } from '../../cashSessions/components/CashTab.js';
import { useCurrentCashSession } from '../../cashSessions/queries.js';

type Tab = 'pos' | 'history' | 'cash';

const KBD = 'px-1 py-0.5 rounded-sm bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 text-xs';
const LABELS: Record<Tab, string> = { pos: '🛒 POS Terminal', history: '📋 Sales History', cash: '💵 Cash Drawer' };

/**
 * The counter: the POS terminal, the branch's Sales History and the
 * cashier's cash session (#171, decision 1a). The Dashboard's Today's Sales
 * opens the history for its dates.
 */
export default function PosPage({ userRole, userPermissions, initialContext = {}, onNavigate }: {
  userRole?: string;
  userPermissions?: string[];
  initialContext?: Record<string, string>;
  onNavigate?: (page: string, context?: Record<string, string>) => void;
}) {
  const [tab, setTab] = useState<Tab>(initialContext.dateFrom || initialContext.dateTo ? 'history' : 'pos');
  const { data: cash, refetch } = useCurrentCashSession();
  const [refused, setRefused] = useState(false);
  const hasSession = !!cash?.session;
  // Shown on the terminal while cash needs a session the cashier has not opened (decision 5a).
  const needsSession = !hasSession && (cash?.required === true || refused);

  const tabBar = (
    <div className="shrink-0">
      <div className="flex items-center gap-1 px-4 pt-1.5 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
        {(['pos', 'history', 'cash'] as Tab[]).map((t) => (
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
            {LABELS[t]}
          </button>
        ))}
        {cash && (
          <span className={`ml-2 text-xs px-2 py-0.5 rounded-full ${hasSession ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'}`}>
            {hasSession ? 'Cash session open' : 'No cash session'}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2 pb-1 text-xs text-gray-400 dark:text-gray-600 font-mono">
          <span><kbd className={KBD}>F8</kbd> Books</span>
          <span><kbd className={KBD}>F9</kbd> Customer</span>
          <span><kbd className={KBD}>Ctrl+↵</kbd> Checkout</span>
        </div>
      </div>
      {tab === 'pos' && needsSession && (
        <div className="flex items-center gap-3 px-4 py-2 text-sm bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 border-b border-amber-200 dark:border-amber-900">
          <span>{REQUIRED_NOTICE} Other methods can still be taken.</span>
          <button type="button" onClick={() => { setRefused(false); setTab('cash'); }} className="ml-auto px-3 py-1 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium">
            Open cash session
          </button>
        </div>
      )}
    </div>
  );

  return (
    <Terminal
      userRole={userRole}
      userPermissions={userPermissions}
      tabBar={tabBar}
      view={tab}
      history={<SalesHistory initialDateFrom={initialContext.dateFrom} initialDateTo={initialContext.dateTo} onNavigate={onNavigate} />}
      cash={<CashTab />}
      onCashSessionRequired={() => { setRefused(true); void refetch(); }}
    />
  );
}
