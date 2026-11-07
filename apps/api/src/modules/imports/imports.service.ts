import { CATALOG_IMPORT_COLUMNS, Money, type ImportReport, type ImportRequest, type ImportResult, type ImportRowError } from '@bms/shared';
import { kysely } from '../../db/kysely.js';
import { withTransaction, type Queryable } from '../../db/tx.js';
import { buildCsv, type CsvColumnDef } from '../../lib/csvBuilder.js';
import { readCsv } from '../../lib/csvRead.js';
import { BusinessError } from '../../lib/errors.js';
import { insertAuditEntry } from '../audit/audit.repository.js';
import { allBooks, booksByIsbn } from '../catalog/catalog.repository.js';
import { createBookIn, updateBookIn } from '../catalog/catalog.service.js';
import type { Actor, BookRecord } from '../catalog/catalog.types.js';
import { insertPublisher, lookups } from '../catalogReference/catalogReference.repository.js';
import { catalogChanges, readCatalogRow, readHeader, type CatalogRow } from './catalogImport.policy.js';
import * as repo from './imports.repository.js';

/**
 * Bulk import and export (#246, owner decisions 1a–4a): a file is checked
 * first, and saved in one transaction, all of it or only its valid rows.
 * Each book is created or changed as on its own screen, audited, and the
 * import itself is audited once.
 */

const MAX_ERRORS_LISTED = 500;

interface CatalogPlan {
  report: ImportReport;
  rows: Array<{ row: CatalogRow; existing?: BookRecord }>;
  publishers: Map<string, repo.NamedRecord>;
  formats: Map<string, number>;
}

/** Reads and checks a catalog file against the catalog as it is. */
async function planCatalog(q: Queryable, csv: string): Promise<CatalogPlan> {
  const file = readCsv(csv);
  const errors: ImportRowError[] = [];
  const header = readHeader(file.header);
  const report = (rows: number, valid: number, counts = { toCreate: 0, toUpdate: 0, unchanged: 0 }, newNames = { authors: [] as string[], categories: [] as string[], publishers: [] as string[] }): ImportReport => ({
    kind: 'catalog', rows, valid, ...counts,
    errors: errors.slice(0, MAX_ERRORS_LISTED), moreErrors: Math.max(0, errors.length - MAX_ERRORS_LISTED), newNames,
  });
  if (header.errors.length > 0) {
    errors.push({ line: 1, messages: header.errors });
    return { report: report(file.rows.length, 0), rows: [], publishers: new Map(), formats: new Map() };
  }

  const read: CatalogRow[] = [];
  const firstLine = new Map<string, number>();
  for (const { line, cells } of file.rows) {
    const { row, messages } = readCatalogRow(cells, header.index, line, file.delimiter === ';');
    if (row && firstLine.has(row.key)) messages.push(`The same book as line ${firstLine.get(row.key)}`);
    if (!row || messages.length > 0) { errors.push({ line, messages }); continue; }
    firstLine.set(row.key, line);
    read.push(row);
  }

  const formatList = await lookups(q, 'book_formats');
  const formats = new Map<string, number>();
  for (const f of formatList) { formats.set(f.code.toLowerCase(), f.id); formats.set(f.label.toLowerCase(), f.id); }
  const existing = new Map((await booksByIsbn(q, read.map((r) => r.key))).map((b) => [b.isbn, b]));
  const allAuthors = [...new Set(read.flatMap((r) => r.authors.map((n) => n.toLowerCase())))];
  const allCategories = [...new Set(read.flatMap((r) => r.categories.map((n) => n.toLowerCase())))];
  const authors = await repo.namesByNormalized(q, 'authors', allAuthors);
  const categories = await repo.namesByNormalized(q, 'categories', allCategories);
  const publishers = await repo.publishers(q);
  const publisherName = (id: number | null) => [...publishers.values()].find((p) => p.id === id)?.name ?? null;

  const newNames = { authors: [] as string[], categories: [] as string[], publishers: [] as string[] };
  const isNew = (list: string[], name: string) => !list.some((n) => n.toLowerCase() === name.toLowerCase());
  const valid: CatalogPlan['rows'] = [];
  const counts = { toCreate: 0, toUpdate: 0, unchanged: 0 };
  for (const row of read) {
    const book = existing.get(row.key);
    const messages: string[] = [];
    const linked = (kind: string, found: Map<string, repo.NamedRecord>, list: string[], already: string[], newList: string[]) => {
      for (const name of list) {
        const record = found.get(name.toLowerCase());
        if (!record) { if (isNew(newList, name)) newList.push(name); continue; }
        if (record.status !== 'ACTIVE' && !already.some((a) => a.toLowerCase() === name.toLowerCase())) {
          messages.push(`${kind} '${record.name}' is not active (${record.status}): activate it first, or name another`);
        }
      }
    };
    linked('Author', authors, row.authors, book?.authors ?? [], newNames.authors);
    linked('Category', categories, row.categories, book?.categories ?? [], newNames.categories);
    if (row.publisher) {
      const p = publishers.get(row.publisher.toLowerCase());
      if (!p) { if (isNew(newNames.publishers, row.publisher)) newNames.publishers.push(row.publisher); }
      else if (p.status !== 'ACTIVE' && p.id !== book?.publisherId) messages.push(`Publisher '${p.name}' is not active (${p.status}): activate it first, or name another`);
    }
    let formatId: number | undefined;
    if (row.format) {
      formatId = formats.get(row.format.toLowerCase());
      if (formatId === undefined) messages.push(`Format '${row.format}' is not one of the shop's formats: ${formatList.map((f) => f.label).join(', ')}`);
    }
    if (messages.length > 0) { errors.push({ line: row.line, messages }); continue; }

    valid.push({ row, existing: book });
    if (!book) counts.toCreate += 1;
    else {
      const change = catalogChanges(book, book.publisherId ? publisherName(book.publisherId) : book.publisher, row,
        { formatId, publisherId: row.publisher ? publishers.get(row.publisher.toLowerCase())?.id : undefined });
      if (Object.keys(change).length > 0) counts.toUpdate += 1; else counts.unchanged += 1;
    }
  }
  errors.sort((a, b) => a.line - b.line);
  return { report: report(file.rows.length, valid.length, counts, newNames), rows: valid, publishers, formats };
}

export async function checkCatalog(req: ImportRequest): Promise<ImportReport> {
  return (await planCatalog(kysely, req.csv)).report;
}

export async function importCatalog(actor: Actor, req: ImportRequest): Promise<ImportResult> {
  return withTransaction({}, async (tx) => {
    const plan = await planCatalog(tx, req.csv);
    const invalid = plan.report.errors.length + plan.report.moreErrors;
    if (invalid > 0 && !req.onlyValid) {
      throw new BusinessError('IMPORT_HAS_ERRORS', `${invalid} row(s) of the file cannot be imported: nothing was saved`, { report: plan.report });
    }
    const meta = { import: req.fileName ?? 'catalog' };
    for (const name of plan.report.newNames.publishers) {
      const created = await insertPublisher(tx, name);
      plan.publishers.set(name.toLowerCase(), { id: created.id, name: created.name, status: created.status });
      await insertAuditEntry(tx, { staffId: actor.staffId, staffRole: actor.role, branchId: actor.branchId, action: 'CREATE', entityType: 'publisher', entityId: created.id, meta: { name, ...meta } });
    }
    const publisherName = (id: number | null) => [...plan.publishers.values()].find((p) => p.id === id)?.name ?? null;
    let created = 0;
    let updated = 0;
    for (const { row, existing } of plan.rows) {
      const formatId = row.format ? plan.formats.get(row.format.toLowerCase()) : undefined;
      const publisherId = row.publisher ? plan.publishers.get(row.publisher.toLowerCase())?.id : undefined;
      if (!existing) {
        await createBookIn(tx, actor, {
          isbn: row.isbn ?? '', sku: row.sku, title: row.title, authors: row.authors, categories: row.categories,
          publisher: row.publisher, publisherId, formatId, language: row.language,
          defaultPrice: row.price === undefined ? undefined : Money.of(row.price).toNumber(),
        }, meta);
        created += 1;
        continue;
      }
      const change = catalogChanges(existing, existing.publisherId ? publisherName(existing.publisherId) : existing.publisher, row, { formatId, publisherId });
      if (Object.keys(change).length === 0) continue;
      await updateBookIn(tx, actor, existing.id, change, meta);
      updated += 1;
    }
    const result: ImportResult = { ...plan.report, created, updated, skipped: invalid };
    await insertAuditEntry(tx, {
      staffId: actor.staffId, staffRole: actor.role, branchId: actor.branchId, action: 'IMPORT', entityType: 'data_import', entityId: 'catalog',
      meta: { kind: 'catalog', fileName: req.fileName ?? null, rows: plan.report.rows, created, updated, skipped: invalid },
    });
    return result;
  });
}

const CATALOG_CSV: CsvColumnDef[] = CATALOG_IMPORT_COLUMNS.map((c) => ({ key: c, header: c, type: 'string' }));

/** The catalog as a file the import reads back unchanged. */
export async function exportCatalog(): Promise<string> {
  const books = await allBooks(kysely);
  const publishers = await repo.publishers(kysely);
  const nameOf = new Map([...publishers.values()].map((p) => [p.id, p.name]));
  return buildCsv(books.map((b) => ({
    ISBN: b.isbn, SKU: b.sku ?? '', Title: b.title, Authors: b.authors.join('; '),
    Publisher: (b.publisherId ? nameOf.get(b.publisherId) : null) ?? b.publisher ?? '', Categories: b.categories.join('; '),
    Format: b.formatLabel ?? '', Language: b.language ?? '', Price: b.defaultPrice?.toFixed(2) ?? '',
  })), CATALOG_CSV);
}

/** The columns, and one example row to replace. */
export function catalogTemplate(): string {
  return buildCsv([{
    ISBN: '9780306406157', SKU: '', Title: 'Example title', Authors: 'First Author; Second Author', Publisher: 'Example Press',
    Categories: 'Fiction', Format: 'Softcover', Language: 'Amharic', Price: '250.00',
  }], CATALOG_CSV);
}
