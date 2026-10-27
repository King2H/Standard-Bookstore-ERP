import { useState } from 'react';
import type { StockLevel } from '@bms/shared';
import { useMyProfile } from '../../account/queries.js';
import { canMoveStock } from '../rules.js';
import { StockLevelsTab } from '../components/StockLevelsTab.js';
import { StockInTab } from '../components/StockInTab.js';
import { StockOutTab } from '../components/StockOutTab.js';
import { AdjustTab } from '../components/AdjustTab.js';
import { TransferTab } from '../components/TransferTab.js';
import { HistoryTab } from '../components/HistoryTab.js';
import { LowStockBadge, LowStockTab } from '../components/LowStockTab.js';
import { TransfersTab } from '../../transfers/components/TransfersTab.js';
import { canTransfer } from '../../transfers/rules.js';

type Tab = 'stock' | 'stock-in' | 'stock-out' | 'adjust' | 'move' | 'outgoing' | 'incoming' | 'history' | 'alerts';

// Transfer notes open on their tab from a link or a notification (#170, decision 5a).
const opensOn = (tab: string | undefined): Tab => (tab === 'outgoing' || tab === 'incoming' ? tab : 'stock');

/** Stock per book and location, its changes and its history (#23). */
export default function InventoryPage({ initialContext = {} }: { initialContext?: Record<string, string> }) {
  const { data: me } = useMyProfile();
  const [tab, setTab] = useState<Tab>(opensOn(initialContext.tab));
  const transferId = Number(initialContext.transferId) || null;
  // The row a quick "+ In" or "− Out" was pressed on, chosen on that tab.
  const [chosen, setChosen] = useState<StockLevel | null>(null);
  // Stock changes are offered only to the roles the API lets move stock.
  const moves = canMoveStock(me);
  const tabs = [
    { id: 'stock' as Tab, label: 'Stock Levels', icon: '📦', show: true },
    { id: 'stock-in' as Tab, label: 'Stock In', icon: '⬇️', show: moves },
    { id: 'stock-out' as Tab, label: 'Stock Out', icon: '⬆️', show: moves },
    { id: 'adjust' as Tab, label: 'Adjust', icon: '✏️', show: moves },
    // Within the branch; notes between branches are Outgoing and Incoming (#170, decision 1a).
    { id: 'move' as Tab, label: 'Move', icon: '↔️', show: moves },
    { id: 'outgoing' as Tab, label: 'Outgoing', icon: '🚚', show: canTransfer(me) },
    { id: 'incoming' as Tab, label: 'Incoming', icon: '📥', show: canTransfer(me) },
    { id: 'history' as Tab, label: 'History', icon: '📋', show: true },
    { id: 'alerts' as Tab, label: 'Low Stock', icon: '⚠️', show: true },
  ].filter(t => t.show);
  const open = (next: Tab, row: StockLevel | null = null) => { setChosen(row); setTab(next); };

  return (
    <div className="flex flex-col h-full bg-gray-50 dark:bg-gray-950">
      <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 px-6 flex gap-1 shrink-0">
        {tabs.map(t => (
          <button key={t.id} type="button" onClick={() => open(t.id)} aria-pressed={tab === t.id}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${tab === t.id ? 'border-blue-600 text-blue-600 dark:text-blue-400' : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
            <span>{t.icon}</span>{t.label}
            {t.id === 'alerts' && <LowStockBadge />}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0">
        {tab === 'stock'     && <StockLevelsTab onStockIn={row => open('stock-in', row)} onStockOut={row => open('stock-out', row)} initialLowOnly={initialContext.lowStockOnly === 'true'} />}
        {tab === 'stock-in'  && moves && <StockInTab key={chosen ? `${chosen.bookId}-${chosen.locationId}` : 'none'} initialRow={chosen} />}
        {tab === 'stock-out' && moves && <StockOutTab key={chosen ? `${chosen.bookId}-${chosen.locationId}` : 'none'} initialRow={chosen} />}
        {tab === 'adjust'    && moves && <AdjustTab />}
        {tab === 'move'      && moves && <TransferTab />}
        {tab === 'outgoing'  && canTransfer(me) && <TransfersTab key="outgoing" direction="outgoing" initialTransferId={opensOn(initialContext.tab) === 'outgoing' ? transferId : null} />}
        {tab === 'incoming'  && canTransfer(me) && <TransfersTab key="incoming" direction="incoming" initialTransferId={opensOn(initialContext.tab) === 'incoming' ? transferId : null} />}
        {tab === 'history'   && <HistoryTab />}
        {tab === 'alerts'    && <LowStockTab />}
      </div>
    </div>
  );
}
