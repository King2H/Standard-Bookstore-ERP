import { useState } from 'react';
import { Money, type Book } from '@bms/shared';
import { useToast } from '../../../components/Toast.js';
import { useQuickRegisterBook } from '../queries.js';

const INPUT = 'w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-green-500';

/**
 * Registers a book brought in that the shop has never had, as a catalog entry
 * only: it adds no stock. The exchange then values and receives it like any
 * other trade-in.
 */
export function QuickRegisterDialog({ initialTitle, onRegistered, onCancel }: {
  initialTitle: string;
  onRegistered: (book: Book) => void;
  onCancel: () => void;
}) {
  const { showToast } = useToast();
  const register = useQuickRegisterBook();
  const [isbn, setIsbn] = useState('');
  const [title, setTitle] = useState(initialTitle);
  const [author, setAuthor] = useState('');
  const [price, setPrice] = useState('');

  function submit() {
    if (!title.trim()) { showToast('Title is required', 'error'); return; }
    if (price.trim() !== '' && !/^\d+(\.\d{1,2})?$/.test(price.trim())) { showToast('Enter the price in whole cents', 'error'); return; }
    register.mutate({
      isbn: isbn.trim() || undefined,
      title: title.trim(),
      author: author.trim() || undefined,
      defaultPrice: price.trim() ? Money.of(price.trim()).toNumber() : undefined,
    }, {
      onSuccess: (book) => {
        showToast(`"${book.title}" registered in the catalog`, 'success');
        onRegistered(book);
      },
      onError: (e: Error) => showToast(e.message, 'error'),
    });
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onCancel}>
      <div role="dialog" aria-labelledby="quick-register-title" className="bg-white dark:bg-gray-900 rounded-xl shadow-xl w-full max-w-sm p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
        <h3 id="quick-register-title" className="text-sm font-semibold text-gray-900 dark:text-white">Quick Catalog Register</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400">Registers this book in the Catalog so it can be searched and exchanged — it does not add any stock by itself.</p>
        <div className="space-y-2">
          <div>
            <label htmlFor="qr-isbn" className="text-xs text-gray-500 dark:text-gray-400">ISBN / Barcode</label>
            <input id="qr-isbn" value={isbn} onChange={(e) => setIsbn(e.target.value)} placeholder="Optional" className={INPUT} />
          </div>
          <div>
            <label htmlFor="qr-title" className="text-xs text-gray-500 dark:text-gray-400">Title <span className="text-red-500">*</span></label>
            <input id="qr-title" value={title} onChange={(e) => setTitle(e.target.value)} className={INPUT} />
          </div>
          <div>
            <label htmlFor="qr-author" className="text-xs text-gray-500 dark:text-gray-400">Author</label>
            <input id="qr-author" value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="Optional" className={INPUT} />
          </div>
          <div>
            <label htmlFor="qr-price" className="text-xs text-gray-500 dark:text-gray-400">Base List Price</label>
            <input id="qr-price" type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="Optional" className={INPUT} />
          </div>
        </div>
        <div className="flex gap-2 pt-1">
          <button onClick={onCancel} className="flex-1 py-2 text-sm rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">Cancel</button>
          <button
            onClick={submit}
            disabled={register.isPending || !title.trim()}
            className="flex-1 py-2 text-sm rounded-lg bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-semibold transition-colors"
          >
            {register.isPending ? 'Registering...' : 'Register & Add'}
          </button>
        </div>
      </div>
    </div>
  );
}
