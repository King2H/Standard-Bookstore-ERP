import { useState, type ChangeEvent } from 'react';
import type { ImportReport, ImportResult } from '@bms/shared';
import { useToast } from '../../../components/Toast.js';
import { useMyProfile } from '../../account/queries.js';
import { downloadExport, downloadTemplate, type ImportKind } from '../api.js';
import { useCheckFile, useImportFile } from '../queries.js';
import { canImport } from '../rules.js';

/**
 * Import / Export (#246, owner decisions 1a–4a): the lists a shop starts
 * with, from CSV files, in the order they depend on each other. Each file is
 * checked first: every invalid row by its line, nothing saved until the file
 * is clean, or only its valid rows when asked.
 */

interface Kind {
  kind: ImportKind;
  step: number;
  title: string;
  about: string;
  exports: boolean;
}

const KINDS: Kind[] = [
  { kind: 'catalog', step: 1, title: 'Catalog', exports: true,
    about: 'Books by ISBN (or SKU for a book without one), with authors, publisher, categories, format, language and price. A file imported again changes only what differs.' },
  { kind: 'opening-stock', step: 2, title: 'Opening stock', exports: true,
    about: 'The first stock of each book at a location of this branch, at what one copy cost. A book with stock history there is corrected by a stock count instead. Cost 0 is taken and listed for Revalue.' },
  { kind: 'customers', step: 3, title: 'Customers', exports: true,
    about: 'Customers, found again by code, phone or email. A new customer gets a code; one from another install keeps its own. The export holds phones and emails in clear: it is recorded in the audit log.' },
  { kind: 'customer-balances', step: 4, title: 'Customer balances', exports: false,
    about: 'What each customer owed (with its due date), their store credit and loyalty points when the shop started. Only before the first sale, and once.' },
  { kind: 'supplier-balances', step: 5, title: 'Supplier balances', exports: false,
    about: 'What the shop owed each supplier when it started, as an opening-balance purchase order paid like any other. A supplier not yet known is added. Only before the first sale, and once.' },
];

const BUTTON = 'px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800';
const PRIMARY = 'px-3 py-1.5 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50';
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function Report({ report }: { report: ImportReport }) {
  const invalid = report.errors.length + report.moreErrors;
  const names: Array<[string, string[]]> = [
    ['New authors', report.newNames.authors], ['New categories', report.newNames.categories],
    ['New publishers', report.newNames.publishers], ['New suppliers', report.newNames.suppliers],
  ];
  return (
    <div className="mt-3 space-y-2 text-sm">
      <p className="text-gray-700 dark:text-gray-300">
        {plural(report.rows, 'row')}: {report.valid} valid, {invalid} with a problem. The valid ones would create {report.toCreate},
        change {report.toUpdate} and leave {report.unchanged} as they are.
      </p>
      {names.filter(([, list]) => list.length > 0).map(([label, list]) => (
        <p key={label} className="text-xs text-gray-600 dark:text-gray-400">{label}: {list.join(', ')}</p>
      ))}
      {report.notices.length > 0 && (
        <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 p-2">
          <p className="text-xs font-semibold text-amber-800 dark:text-amber-300">To look at after the import</p>
          <ul className="text-xs text-amber-800 dark:text-amber-300">
            {report.notices.map((n) => <li key={n.line}>Line {n.line}: {n.messages.join('; ')}</li>)}
          </ul>
        </div>
      )}
      {invalid > 0 && (
        <div className="rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 p-2 max-h-72 overflow-auto">
          <table className="text-xs text-red-800 dark:text-red-300">
            <tbody>
              {report.errors.map((e) => (
                <tr key={e.line}>
                  <th scope="row" className="pr-3 align-top text-left font-semibold whitespace-nowrap">Line {e.line}</th>
                  <td>{e.messages.map((m) => <div key={m}>{m}</div>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {report.moreErrors > 0 && <p className="text-xs text-red-800 dark:text-red-300 mt-1">And {plural(report.moreErrors, 'more row')} with a problem.</p>}
        </div>
      )}
    </div>
  );
}

function ImportCard({ kind }: { kind: Kind }) {
  const { showToast } = useToast();
  const check = useCheckFile(kind.kind);
  const save = useImportFile(kind.kind);
  const [file, setFile] = useState<{ name: string; csv: string } | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const failed = (e: Error) => showToast(e.message, 'error');

  async function chosen(event: ChangeEvent<HTMLInputElement>) {
    const picked = event.target.files?.[0];
    event.target.value = '';
    if (!picked) return;
    const csv = await picked.text();
    setFile({ name: picked.name, csv });
    setReport(null);
    setResult(null);
    check.mutate({ csv, fileName: picked.name, onlyValid: false }, { onSuccess: setReport, onError: failed });
  }

  function importNow(onlyValid: boolean) {
    if (!file) return;
    save.mutate({ csv: file.csv, fileName: file.name, onlyValid }, {
      onSuccess: (saved) => {
        setResult(saved);
        setReport(null);
        showToast(`${kind.title}: ${saved.created} created, ${saved.updated} updated`, 'success');
      },
      onError: failed,
    });
  }

  const invalid = report ? report.errors.length + report.moreErrors : 0;
  return (
    <section className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex-1 min-w-64">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">{kind.step}. {kind.title}</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{kind.about}</p>
        </div>
        <div className="flex gap-2">
          <button type="button" className={BUTTON} onClick={() => downloadTemplate(kind.kind).catch(failed)}>Template</button>
          {kind.exports && <button type="button" className={BUTTON} onClick={() => downloadExport(kind.kind).catch(failed)}>Export</button>}
        </div>
      </div>
      <div className="mt-3">
        <input type="file" accept=".csv,text/csv" aria-label={`${kind.title} file`} onChange={chosen} disabled={check.isPending || save.isPending}
          className="text-xs text-gray-700 dark:text-gray-300 file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border-0 file:bg-gray-100 dark:file:bg-gray-800 file:text-xs file:font-medium" />
        {check.isPending && <p className="text-xs text-gray-500 mt-2">Checking {file?.name}…</p>}
      </div>
      {report && <Report report={report} />}
      {report && report.valid > 0 && (
        <div className="mt-3 flex gap-2">
          {invalid === 0
            ? <button type="button" className={PRIMARY} disabled={save.isPending} onClick={() => importNow(false)}>Import {plural(report.valid, 'row')}</button>
            : <button type="button" className={PRIMARY} disabled={save.isPending} onClick={() => importNow(true)}>Import the {plural(report.valid, 'valid row')}</button>}
        </div>
      )}
      {save.isPending && <p className="text-xs text-gray-500 mt-2">Importing {file?.name}: a large file takes a minute.</p>}
      {result && (
        <p className="mt-3 text-sm text-green-700 dark:text-green-400">
          Saved: {result.created} created, {result.updated} updated, {plural(result.skipped, 'row')} left out.
        </p>
      )}
    </section>
  );
}

export default function ImportExportPage() {
  const { data: me } = useMyProfile();
  const kinds = KINDS.filter((k) => canImport(me, k.kind));
  return (
    <div className="p-6 max-w-4xl space-y-4">
      <div>
        <h1 className="text-xl font-bold text-gray-900 dark:text-white">Import / Export</h1>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
          Bring in the lists the shop starts with, from CSV files, in this order. Start from a template; in Excel, save as “CSV UTF-8”.
        </p>
      </div>
      {kinds.map((k) => <ImportCard key={k.kind} kind={k} />)}
    </div>
  );
}
