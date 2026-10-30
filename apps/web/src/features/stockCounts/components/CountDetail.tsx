import { useState } from 'react';
import type { StockCountLine } from '@bms/shared';
import { ActionDialog } from '../../../components/ActionDialog.js';
import { formatCurrency } from '../../../lib/currency.js';
import { useCurrency } from '../../../lib/useCurrency.js';
import { useMyProfile } from '../../account/queries.js';
import { Messages } from '../../inventory/components/stockChange.js';
import { useCancelStockCount, useEnterStockCounts, usePostStockCount, useRecountStockCount, useStockCount, useSubmitStockCount } from '../queries.js';
import { canCount, canReview, isCount } from '../rules.js';
import { BookFinder } from './BookFinder.js';
import { CountSheet } from './CountSheet.js';
import { StatusBadge } from './StatusBadge.js';

const CELL = 'px-3 py-2 text-right';
const BUTTON = 'px-4 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50';
const PRIMARY = 'px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50';

const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');

/**
 * One count (#172): counters enter quantities blind and submit (2a); an
 * Admin or Manager sees expected, difference and value, sends books back,
 * counts never-counted books as 0, posts or cancels (3a); a posted count
 * shows what it changed (5a).
 */
export function CountDetail({ id, onBack, onOpenHistory }: { id: number; onBack: () => void; onOpenHistory: () => void }) {
  const { data: c, isLoading, error } = useStockCount(id);
  const { data: me } = useMyProfile();
  const currency = useCurrency();
  // Quantities typed and not yet saved, by book; books found that are not on the count.
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [extras, setExtras] = useState<Array<{ bookId: number; title: string; isbn: string | null }>>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [zero, setZero] = useState<number[]>([]);
  const [confirm, setConfirm] = useState<'post' | 'cancel' | null>(null);
  const [printing, setPrinting] = useState(false);
  const [message, setMessage] = useState('');
  const enter = useEnterStockCounts();
  const submit = useSubmitStockCount();
  const recount = useRecountStockCount();
  const post = usePostStockCount();
  const cancel = useCancelStockCount();

  if (isLoading) return <div className="p-6 text-sm text-gray-400">Loading…</div>;
  if (!c) return <div className="p-6 text-sm text-red-600">{(error as Error | null)?.message ?? 'Stock count not found'}</div>;

  const money = (n: number) => formatCurrency(n, currency);
  // The API hides expected quantities from counters while counting (blind).
  const blind = c.totals === null;
  const counting = c.status === 'counting' && canCount(me);
  const reviewing = c.status === 'submitted' && canReview(me);
  const open = c.status === 'counting' || c.status === 'submitted';
  const onCount = new Set(c.lines.map((l) => l.bookId));
  const rows: Array<Pick<StockCountLine, 'bookId' | 'bookTitle' | 'isbn'> & { line?: StockCountLine }> = [
    ...c.lines.map((l) => ({ bookId: l.bookId, bookTitle: l.bookTitle, isbn: l.isbn, line: l })),
    ...extras.filter((e) => !onCount.has(e.bookId)).map((e) => ({ bookId: e.bookId, bookTitle: e.title, isbn: e.isbn })),
  ];
  const changed = Object.entries(drafts)
    .filter(([bookId, v]) => v !== '' && Number(v) !== c.lines.find((l) => l.bookId === Number(bookId))?.countedQuantity)
    .map(([bookId, v]) => ({ bookId: Number(bookId), quantity: Number(v) }));
  const invalid = Object.values(drafts).some((v) => v !== '' && !isCount(v));
  const failed = (err: unknown) => setMessage((err as Error).message);
  const done = () => { setMessage(''); setConfirm(null); };

  function save() {
    enter.mutate({ id: c!.id, body: { items: changed } }, {
      onSuccess: () => { setDrafts({}); setExtras([]); setMessage(''); },
      onError: failed,
    });
  }

  return (
    <div className="p-6 overflow-auto h-full">
      <div className="max-w-5xl mx-auto space-y-5">
        <button type="button" onClick={onBack} className="text-sm text-blue-600 dark:text-blue-400 hover:underline">← Back</button>

        <div className="flex flex-wrap items-start gap-3">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white"><span className="font-mono">{c.countNumber}</span> · {c.locationName}</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {c.scope === 'full' ? 'Every book at the location' : 'Chosen books'} · opened by {c.createdByName} on {new Date(c.createdAt).toLocaleString()}
              {c.postedAt && ` · posted by ${c.postedByName} on ${new Date(c.postedAt).toLocaleString()}`}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">{c.countedLines} of {c.lineCount} books counted</p>
            {c.notes && <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">{c.notes}</p>}
            {c.cancelReason && <p className="text-sm text-red-600 dark:text-red-400 mt-1">Cancelled: {c.cancelReason}</p>}
          </div>
          <StatusBadge status={c.status} />
        </div>

        {c.totals && (
          <p className="text-sm text-gray-700 dark:text-gray-200">
            Over {c.totals.overQuantity} ({money(c.totals.overValue)}) · Short {c.totals.shortQuantity} ({money(c.totals.shortValue)})
          </p>
        )}
        <Messages error={message} success="" />

        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800/50 text-xs text-gray-500 dark:text-gray-400 uppercase">
              <tr>
                {reviewing && <th className="px-3 py-2 w-8"><span className="sr-only">Select</span></th>}
                <th className="px-3 py-2 text-left">Book</th>
                <th className="px-3 py-2 text-left">ISBN</th>
                {!blind && <th className={CELL}>Expected</th>}
                <th className={CELL}>Counted</th>
                {!blind && <th className={CELL}>Difference</th>}
                {!blind && <th className={CELL}>Value</th>}
                {c.status === 'posted' && <th className={CELL}>Posted</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {rows.length === 0 && <tr><td colSpan={8} className="px-3 py-6 text-center text-gray-400">No books on this count yet.</td></tr>}
              {rows.map(({ bookId, bookTitle, isbn, line }) => {
                const value = drafts[bookId] ?? (line?.countedQuantity ?? '').toString();
                return (
                  <tr key={bookId} className={line?.recountRequested ? 'bg-amber-50 dark:bg-amber-900/20' : undefined}>
                    {reviewing && (
                      <td className="px-3 py-2">
                        {line && line.countedQuantity !== null && (
                          <input type="checkbox" aria-label={`Select ${bookTitle}`} checked={selected.includes(bookId)}
                            onChange={(e) => setSelected((s) => (e.target.checked ? [...s, bookId] : s.filter((b) => b !== bookId)))} />
                        )}
                      </td>
                    )}
                    <td className="px-3 py-2 text-gray-900 dark:text-white">
                      {bookTitle}
                      {line?.recountRequested && <span className="ml-2 text-xs text-amber-700 dark:text-amber-300">Recount</span>}
                      {line && line.previousCounts.length > 0 && <span className="ml-2 text-xs text-gray-400">earlier: {line.previousCounts.join(', ')}</span>}
                    </td>
                    <td className="px-3 py-2 text-gray-500 dark:text-gray-400">{isbn ?? ''}</td>
                    {!blind && <td className={CELL}>{line?.expectedQuantity ?? line?.frozenQuantity ?? '—'}</td>}
                    <td className={CELL}>
                      {counting ? (
                        <input type="text" inputMode="numeric" aria-label={`Counted ${bookTitle}`} value={value}
                          onChange={(e) => setDrafts((d) => ({ ...d, [bookId]: e.target.value.trim() }))}
                          className={`w-20 px-2 py-1 text-sm text-right border rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white ${value !== '' && !isCount(value) ? 'border-red-500' : 'border-gray-300 dark:border-gray-600'}`} />
                      ) : reviewing && line && line.countedQuantity === null ? (
                        <label className="inline-flex items-center gap-1 text-xs text-gray-500">
                          <input type="checkbox" aria-label={`Count ${bookTitle} as 0`} checked={zero.includes(bookId)}
                            onChange={(e) => setZero((z) => (e.target.checked ? [...z, bookId] : z.filter((b) => b !== bookId)))} />
                          as 0
                        </label>
                      ) : (line?.countedQuantity ?? '—')}
                    </td>
                    {!blind && <td className={CELL}>{line?.difference == null ? '—' : signed(line.difference)}</td>}
                    {!blind && <td className={CELL}>{line?.differenceValue == null ? '—' : money(line.differenceValue)}</td>}
                    {c.status === 'posted' && (
                      <td className={CELL}>
                        {line?.postedDelta == null ? 'Not counted' : line.postedDelta === 0 ? 'No change' : `${signed(line.postedDelta)} at ${money(line.postedUnitCost ?? 0)}`}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {counting && (
          <div className="max-w-md">
            <BookFinder locationId={c.locationId} exclude={rows.map((r) => r.bookId)}
              onAdd={(b) => setExtras((e) => [...e, b])} />
          </div>
        )}

        <div className="flex flex-wrap gap-2 justify-end">
          {c.status === 'counting' && <button type="button" onClick={() => setPrinting(true)} className={BUTTON}>🖨 Print count sheet</button>}
          {c.status === 'posted' && <button type="button" onClick={onOpenHistory} className={BUTTON}>Open in History</button>}
          {open && canReview(me) && <button type="button" onClick={() => setConfirm('cancel')} className={BUTTON}>Cancel count</button>}
          {counting && (
            <>
              <button type="button" disabled={changed.length === 0 || invalid || enter.isPending} onClick={save} className={BUTTON}>Save counts</button>
              <button type="button" disabled={changed.length > 0 || submit.isPending} title={changed.length > 0 ? 'Save the counts first' : undefined}
                onClick={() => submit.mutate(c.id, { onSuccess: done, onError: failed })} className={PRIMARY}>Submit count</button>
            </>
          )}
          {reviewing && (
            <>
              <button type="button" disabled={selected.length === 0 || recount.isPending}
                onClick={() => recount.mutate({ id: c.id, bookIds: selected }, { onSuccess: () => { setSelected([]); done(); }, onError: failed })}
                className={BUTTON}>Recount selected</button>
              <button type="button" onClick={() => setConfirm('post')} className={PRIMARY}>Post count</button>
            </>
          )}
        </div>
      </div>

      {confirm === 'post' && (
        <ActionDialog title={`Post ${c.countNumber}`} confirmLabel="Post" busy={post.isPending}
          message={`One adjustment per difference at the average cost.${c.lineCount - c.countedLines - zero.length > 0 ? ` ${c.lineCount - c.countedLines - zero.length} book(s) never counted stay as they are.` : ''}`}
          onConfirm={() => post.mutate({ id: c.id, zeroBookIds: zero }, { onSuccess: () => { setZero([]); done(); }, onError: (e) => { failed(e); setConfirm(null); } })}
          onCancel={() => setConfirm(null)} />
      )}
      {confirm === 'cancel' && (
        <ActionDialog title={`Cancel ${c.countNumber}`} confirmLabel="Cancel count" tone="red" busy={cancel.isPending}
          message="Stock stays as it is; the count is kept, cancelled." reason={{ label: 'Reason', max: 500 }}
          onConfirm={(reason) => cancel.mutate({ id: c.id, reason: reason ?? '' }, { onSuccess: done, onError: (e) => { failed(e); setConfirm(null); } })}
          onCancel={() => setConfirm(null)} />
      )}
      {printing && <CountSheet count={c} onClose={() => setPrinting(false)} />}
    </div>
  );
}
