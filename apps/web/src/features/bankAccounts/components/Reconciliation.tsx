import { useState } from 'react';
import { Money, type StatementLine } from '@bms/shared';
import Pagination, { DEFAULT_PAGE_SIZE, makePageSizeHandler } from '../../../components/Pagination.js';
import { useToast } from '../../../components/Toast.js';
import { useMyProfile } from '../../account/queries.js';
import { useEntries, useImportStatement, useLines, useMatchLine, useUnmatchLine } from '../queries.js';
import { canReconcile, parseStatement } from '../rules.js';

const INPUT = 'w-full bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-hidden focus:ring-2 focus:ring-blue-500 transition-colors';
const CARD = 'bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden shadow-xs';
const money = (n: number) => Money.of(n).toFixed(2);
const sign = (d: 'in' | 'out') => (d === 'in' ? '↑ IN' : '↓ OUT');

/**
 * The bank's statement lines on one side, the system's open movements on the
 * other; a line is matched to one movement and both are cleared (#21). Both
 * lists page, and a line is offered exactly the open movements of its amount
 * and direction (owner decision 3a; was: only those among the newest 100).
 */
export function Reconciliation({ branchId, accountId }: { branchId: number; accountId: number }) {
  const { showToast } = useToast();
  const { data: me } = useMyProfile();
  const reconcile = canReconcile(me);
  const [statement, setStatement] = useState('');
  const [problem, setProblem] = useState('');
  const [matching, setMatching] = useState<string | null>(null);
  const [show, setShow] = useState<'false' | 'all'>('false');
  const [linePage, setLinePage] = useState(1);
  const [linePageSize, setLinePageSize] = useState(DEFAULT_PAGE_SIZE);
  const [entryPage, setEntryPage] = useState(1);
  const [entryPageSize, setEntryPageSize] = useState(DEFAULT_PAGE_SIZE);
  const { data: lines } = useLines(branchId, accountId, { page: linePage, pageSize: linePageSize, ...(show === 'false' ? { matched: 'false' } : {}) });
  const { data: open } = useEntries(branchId, accountId, { status: 'uncleared', page: entryPage, pageSize: entryPageSize });
  const importing = useImportStatement(branchId, accountId);
  const unmatch = useUnmatchLine(branchId, accountId);
  const fail = (e: Error) => showToast(e.message, 'error');

  function submitImport() {
    const parsed = parseStatement(statement);
    if ('problem' in parsed) { setProblem(parsed.problem); return; }
    setProblem('');
    importing.mutate({ lines: parsed.lines }, {
      onSuccess: (r) => {
        setStatement('');
        showToast(`Imported ${r.imported} line(s), ${r.matched} matched${r.duplicates ? `, ${r.duplicates} already imported` : ''}`);
      },
      onError: fail,
    });
  }

  return (
    <div className="space-y-4">
      {reconcile && (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-3 shadow-xs space-y-2">
          <label htmlFor="statement" className="block text-xs font-medium text-gray-600 dark:text-gray-400">
            Import statement lines: date, amount, in/out, bank reference, description (one per line)
          </label>
          <textarea id="statement" value={statement} onChange={(e) => { setStatement(e.target.value); setProblem(''); }} rows={3}
            aria-invalid={problem ? true : undefined}
            placeholder="2026-10-11, 1500.00, in, FT26284XYZ, Transfer from customer" className={`${INPUT} font-mono text-xs`} />
          {problem && <p role="alert" className="text-xs text-red-500">{problem}</p>}
          <button onClick={submitImport} disabled={!statement.trim() || importing.isPending}
            className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50">Import</button>
        </div>
      )}

      <div className={CARD}>
        <div className="px-4 py-2 flex items-center justify-between border-b border-gray-100 dark:border-gray-800">
          <h3 className="text-xs font-semibold text-gray-600 dark:text-gray-400">Statement lines</h3>
          <select aria-label="Statement lines to show" value={show} onChange={(e) => { setShow(e.target.value as 'false' | 'all'); setLinePage(1); }}
            className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-sm px-1 py-0.5 text-xs text-gray-700 dark:text-gray-300">
            <option value="false">Unmatched</option>
            <option value="all">All</option>
          </select>
        </div>
        <table className="w-full text-sm">
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {(lines?.items ?? []).map((l) => (
              <tr key={l.id}>
                <td className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400">{l.statementDate}</td>
                <td className="px-4 py-2 font-medium text-gray-900 dark:text-white">{money(l.amount)}</td>
                <td className="px-4 py-2 text-xs">{sign(l.direction)}</td>
                <td className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400">{l.reference ?? l.description ?? ''}</td>
                <td className="px-4 py-2 text-xs">
                  {l.entryId !== null ? (
                    <span className="inline-flex items-center gap-2">
                      <span className="px-2 py-0.5 rounded-sm bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-400">Matched</span>
                      {reconcile && (
                        <button onClick={() => unmatch.mutate(l.id, { onSuccess: () => showToast('Unmatched'), onError: fail })}
                          className="text-gray-500 hover:text-red-600">Unmatch</button>
                      )}
                    </span>
                  ) : matching === l.id ? (
                    <MatchPicker branchId={branchId} accountId={accountId} line={l} onDone={() => setMatching(null)} />
                  ) : reconcile ? (
                    <button onClick={() => setMatching(l.id)} className="text-blue-600 dark:text-blue-400 hover:text-blue-800">Match</button>
                  ) : (
                    <span className="text-amber-600">Open</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {(lines?.items ?? []).length === 0 && (
          <p className="text-center text-gray-500 dark:text-gray-400 text-sm py-6">
            {show === 'false' ? 'Every statement line is matched' : 'No statement lines imported'}
          </p>
        )}
        {lines && lines.total > DEFAULT_PAGE_SIZE && (
          <Pagination page={linePage} pageSize={linePageSize} total={lines.total} totalPages={lines.totalPages}
            onPageChange={setLinePage} onPageSizeChange={makePageSizeHandler(setLinePage, setLinePageSize)} itemLabel="line" />
        )}
      </div>

      <div className={CARD}>
        <h3 className="px-4 py-2 text-xs font-semibold text-gray-600 dark:text-gray-400 border-b border-gray-100 dark:border-gray-800">
          Open movements (not yet on a statement)
        </h3>
        <table className="w-full text-sm">
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {(open?.items ?? []).map((e) => (
              <tr key={e.id}>
                <td className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400">{new Date(e.createdAt).toLocaleDateString()}</td>
                <td className="px-4 py-2 font-medium text-gray-900 dark:text-white">{money(e.amount)}</td>
                <td className="px-4 py-2 text-xs">{sign(e.direction)}</td>
                <td className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400">{e.notes ?? e.sourceType}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {(open?.items ?? []).length === 0 && <p className="text-center text-gray-500 dark:text-gray-400 text-sm py-6">Every movement is matched</p>}
        {open && open.total > DEFAULT_PAGE_SIZE && (
          <Pagination page={entryPage} pageSize={entryPageSize} total={open.total} totalPages={open.totalPages}
            onPageChange={setEntryPage} onPageSizeChange={makePageSizeHandler(setEntryPage, setEntryPageSize)} itemLabel="movement" />
        )}
      </div>
    </div>
  );
}

/** The open movements a statement line can be matched to: its amount and direction, asked of the API. */
function MatchPicker({ branchId, accountId, line, onDone }: { branchId: number; accountId: number; line: StatementLine; onDone: () => void }) {
  const { showToast } = useToast();
  const { data, isLoading } = useEntries(branchId, accountId, {
    status: 'uncleared', amount: Money.of(line.amount).toFixed(2), direction: line.direction, pageSize: 100,
  });
  const match = useMatchLine(branchId, accountId);
  const candidates = data?.items ?? [];
  return (
    <span className="inline-flex items-center gap-1">
      <select aria-label="Movement to match" defaultValue="" disabled={isLoading || match.isPending}
        onChange={(e) => e.target.value && match.mutate({ lineId: line.id, entryId: e.target.value }, {
          onSuccess: () => { showToast('Matched'); onDone(); },
          onError: (err: Error) => showToast(err.message, 'error'),
        })}
        className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-sm px-1 py-0.5 text-xs">
        <option value="">{isLoading ? 'Loading…' : candidates.length ? 'Choose a movement…' : 'No open movement fits'}</option>
        {candidates.map((e) => (
          <option key={e.id} value={e.id}>{new Date(e.createdAt).toLocaleDateString()} · {e.notes ?? e.sourceType}</option>
        ))}
      </select>
      <button onClick={onDone} aria-label="Cancel matching" className="text-gray-400 hover:text-gray-600 px-1">✕</button>
    </span>
  );
}
