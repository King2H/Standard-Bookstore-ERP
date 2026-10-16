import { useState } from 'react';
import { ReferenceTab } from '../../catalogReference/components/ReferenceTab.js';
import { BooksTab } from '../components/BooksTab.js';

type Tab = 'books' | 'authors' | 'categories' | 'publishers';

const TABS: Array<{ id: Tab; label: string; icon: string }> = [
  { id: 'books', label: 'Books', icon: '📖' },
  { id: 'authors', label: 'Authors', icon: '✍️' },
  { id: 'categories', label: 'Categories', icon: '🏷️' },
  { id: 'publishers', label: 'Publishers', icon: '🏢' },
];

/** The catalog: books, and the authors, categories and publishers they link to. */
export default function CatalogPage() {
  const [tab, setTab] = useState<Tab>('books');
  return (
    <div className="flex flex-col h-full bg-gray-50 dark:bg-gray-950">
      <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 px-6 flex gap-1 shrink-0">
        {TABS.map(t => (
          <button key={t.id} type="button" onClick={() => setTab(t.id)} aria-pressed={tab === t.id}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${tab === t.id ? 'border-blue-600 text-blue-600 dark:text-blue-400' : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
            <span>{t.icon}</span>{t.label}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0">
        {tab === 'books' ? <BooksTab /> : <ReferenceTab kind={tab} />}
      </div>
    </div>
  );
}
