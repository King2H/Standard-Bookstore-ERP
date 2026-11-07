import { Money, OPENING_STOCK_IMPORT_COLUMNS, type ImportReport, type ImportRequest, type ImportResult, type ImportRowError } from '@bms/shared';
import { kysely } from '../../db/kysely.js';
import { withTransaction, type Queryable } from '../../db/tx.js';
import { buildCsv, type CsvColumnDef } from '../../lib/csvBuilder.js';
import { readCsv } from '../../lib/csvRead.js';
import { BusinessError } from '../../lib/errors.js';
import { insertAuditEntry } from '../audit/audit.repository.js';
import type { Actor } from '../catalog/catalog.types.js';
import { setReorderPointWith, stockInWith } from '../inventory/inventory.service.js';
import { listByBranch } from '../location/location.repository.js';
import { reportOf } from './importFile.policy.js';
import { readStockHeader, readStockRow, stockDecision, type StockRow } from './openingStockImport.policy.js';
import * as repo from './imports.repository.js';

/**
 * The opening stock import (#246): each book's first stock at a location of
 * the session's branch, at its unit cost, booked as opening stock; checked
 * first, saved in one transaction. Who may import names the locations they
 * may use (`usable`, undefined for every one).
 */

export interface StockScope {
  branchId: number;
  usable: number[] | undefined;
}

interface PlannedRow {
  row: StockRow;
  bookId: number;
  locationId: number;
  stock: boolean;
  reorder: boolean;
}

async function planStock(q: Queryable, csv: string, scope: StockScope): Promise<{ report: ImportReport; rows: PlannedRow[] }> {
  const file = readCsv(csv);
  const errors: ImportRowError[] = [];
  const notices: ImportRowError[] = [];
  const header = readStockHeader(file.header);
  if (header.errors.length > 0) {
    errors.push({ line: 1, messages: header.errors });
    return { report: reportOf('opening-stock', file.rows.length, 0, { toCreate: 0, toUpdate: 0, unchanged: 0 }, errors), rows: [] };
  }

  const read: StockRow[] = [];
  for (const { line, cells } of file.rows) {
    const { row, messages } = readStockRow(cells, header.index, line, file.delimiter === ';');
    if (row) read.push(row); else errors.push({ line, messages });
  }
  const books = await repo.booksByKey(q, [...new Set(read.map((r) => r.key))]);
  const locations = new Map((await listByBranch(q, scope.branchId)).map((l) => [l.name.toLowerCase(), l.id]));
  const levels = await repo.stockLevels(q, [...books.values()].map((b) => b.id), [...locations.values()]);
  const levelOf = (bookId: number, locationId: number) => levels.find((l) => l.bookId === bookId && l.locationId === locationId);

  const seen = new Map<string, number>();
  const rows: PlannedRow[] = [];
  const counts = { toCreate: 0, toUpdate: 0, unchanged: 0 };
  for (const row of read) {
    const messages: string[] = [];
    const book = books.get(row.key);
    const locationId = locations.get(row.location.toLowerCase());
    if (!book) messages.push(`No book with ISBN ${row.key}: import the catalog first`);
    if (locationId === undefined) messages.push(`No location '${row.location}' in this branch`);
    else if (scope.usable && !scope.usable.includes(locationId)) messages.push(`Location '${row.location}' is not one of your locations`);
    if (book && locationId !== undefined) {
      const pair = `${book.id}:${locationId}`;
      if (seen.has(pair)) messages.push(`The same book and location as line ${seen.get(pair)}`);
      else seen.set(pair, row.line);
    }
    if (messages.length > 0) { errors.push({ line: row.line, messages }); continue; }

    const decision = stockDecision(levelOf(book!.id, locationId!), row);
    if (decision.message) { errors.push({ line: row.line, messages: [decision.message] }); continue; }
    rows.push({ row, bookId: book!.id, locationId: locationId!, stock: decision.stock, reorder: decision.reorder });
    if (decision.action === 'create') counts.toCreate += 1;
    else if (decision.action === 'update') counts.toUpdate += 1;
    else counts.unchanged += 1;
    if (decision.stock && Money.of(row.unitCost!).isZero()) {
      notices.push({ line: row.line, messages: [`Opening stock at cost 0: set its cost with Inventory > Revalue once known`] });
    }
  }
  return { report: reportOf('opening-stock', file.rows.length, rows.length, counts, errors, notices), rows };
}

export async function checkStock(req: ImportRequest, scope: StockScope): Promise<ImportReport> {
  return (await planStock(kysely, req.csv, scope)).report;
}

export async function importStock(actor: Actor, req: ImportRequest, scope: StockScope): Promise<ImportResult> {
  return withTransaction({}, async (tx) => {
    const plan = await planStock(tx, req.csv, scope);
    const invalid = plan.report.errors.length + plan.report.moreErrors;
    if (invalid > 0 && !req.onlyValid) {
      throw new BusinessError('IMPORT_HAS_ERRORS', `${invalid} row(s) of the file cannot be imported: nothing was saved`, { report: plan.report });
    }
    const notes = `Opening stock (import${req.fileName ? `: ${req.fileName}` : ''})`;
    let created = 0;
    let updated = 0;
    for (const { row, bookId, locationId, stock, reorder } of plan.rows) {
      if (stock) {
        await stockInWith(tx, actor, {
          bookId, locationId, quantity: row.quantity, referenceType: 'initial_stock', notes, unitCost: Money.of(row.unitCost!).toNumber(4),
          // Opening stock whose cost is not known comes in at 0, listed for Revalue (decision 4a).
          costMayBeZero: true,
        });
      }
      if (reorder) await setReorderPointWith(tx, actor, { bookId, locationId, reorderPoint: row.reorderPoint! }, true);
      if (stock) created += 1; else if (reorder) updated += 1;
    }
    await insertAuditEntry(tx, {
      staffId: actor.staffId, staffRole: actor.role, branchId: actor.branchId, action: 'IMPORT', entityType: 'data_import', entityId: 'opening-stock',
      meta: { kind: 'opening-stock', fileName: req.fileName ?? null, rows: plan.report.rows, created, updated, skipped: invalid },
    });
    return { ...plan.report, created, updated, skipped: invalid };
  });
}

const STOCK_CSV: CsvColumnDef[] = OPENING_STOCK_IMPORT_COLUMNS.map((c) => ({ key: c, header: c, type: 'string' }));

/** Four decimals at most, two at least: 45.50, 12.3456. */
function costText(cost: string): string {
  return Money.of(cost).toFixed(4).replace(/0{1,2}$/, '');
}

/** The branch's stock lines as a file the import reads back unchanged; the cost only for who may see it. */
export async function exportStock(branchId: number, showCost: boolean): Promise<string> {
  const rows = await repo.branchStock(kysely, branchId);
  return buildCsv(rows.map((r) => ({
    ISBN: r.isbn, Title: r.title, Location: r.location, Quantity: String(r.quantity),
    'Unit Cost': showCost ? costText(r.averageCost) : '', 'Reorder Point': String(r.reorderPoint),
  })), STOCK_CSV);
}

export function stockTemplate(): string {
  return buildCsv([{ ISBN: '9780306406157', Title: 'Example title (not read)', Location: 'Main Store', Quantity: '10', 'Unit Cost': '180.00', 'Reorder Point': '3' }], STOCK_CSV);
}
