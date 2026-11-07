import { OPENING_STOCK_IMPORT_COLUMNS } from '@bms/shared';
import { bookKey, cellsOf, readAmount, readColumns, readCount } from './importFile.policy.js';

// The rules of an opening stock file (#246): pure, no database. Opening stock
// is the first stock of a book at a location; a book with stock history there
// is corrected by a stock count, so a file imported again adds nothing.

export type StockColumn = (typeof OPENING_STOCK_IMPORT_COLUMNS)[number];

export interface StockRow {
  line: number;
  key: string;
  location: string;
  quantity: number;
  /** Four decimals, e.g. "45.5000"; undefined when the cell is empty. */
  unitCost: string | undefined;
  reorderPoint: number | undefined;
}

export interface ExistingLevel {
  quantity: number;
  reorderPoint: number;
  /** Any movement recorded for the book at the location. */
  hasHistory: boolean;
}

export function readStockHeader(header: string[]) {
  const { index, errors } = readColumns(header, OPENING_STOCK_IMPORT_COLUMNS);
  for (const column of ['ISBN', 'Location', 'Quantity'] as const) {
    if (index[column] === undefined) errors.push(`The file has no ${column} column: start from the template`);
  }
  return { index, errors };
}

export function readStockRow(cells: string[], index: Partial<Record<StockColumn, number>>, line: number, decimalComma: boolean): { row?: StockRow; messages: string[] } {
  const cell = cellsOf(cells, index);
  const messages: string[] = [];
  const book = bookKey(cell('ISBN'));
  if (book.message) messages.push(book.message);
  else if (!book.key) messages.push('ISBN is empty');
  if (!cell('Location')) messages.push('Location is empty');
  const quantity = readCount(cell('Quantity'));
  if (quantity === null) messages.push(`Quantity '${cell('Quantity')}' is not a whole number of 0 or more`);
  let unitCost: string | undefined;
  if (cell('Unit Cost')) {
    const read = readAmount(cell('Unit Cost'), decimalComma, 4);
    if (read === null) messages.push(`Unit Cost '${cell('Unit Cost')}' is not an amount with at most four decimals`);
    else unitCost = read;
  }
  let reorderPoint: number | undefined;
  if (cell('Reorder Point')) {
    const read = readCount(cell('Reorder Point'));
    if (read === null) messages.push(`Reorder Point '${cell('Reorder Point')}' is not a whole number of 0 or more`);
    else reorderPoint = read;
  }
  if (messages.length > 0) return { messages };
  return { row: { line, key: book.key!, location: cell('Location'), quantity: quantity!, unitCost, reorderPoint }, messages };
}

/**
 * What a row does at its book and location: opening stock where there is no
 * history yet; nothing to the quantity where there is and it matches; an
 * error where it differs. The reorder point may change either way.
 */
export function stockDecision(existing: ExistingLevel | undefined, row: StockRow): { action?: 'create' | 'update' | 'unchanged'; stock: boolean; reorder: boolean; message?: string } {
  const reorder = row.reorderPoint !== undefined && row.reorderPoint !== (existing?.reorderPoint ?? null);
  if (existing?.hasHistory) {
    if (row.quantity !== existing.quantity) {
      return { stock: false, reorder, message: `This book already has stock here (${existing.quantity}): correct it with a stock count, not an opening stock` };
    }
    return { action: reorder ? 'update' : 'unchanged', stock: false, reorder };
  }
  if (row.quantity > 0) {
    if (row.unitCost === undefined) return { stock: false, reorder, message: 'Unit Cost is empty: opening stock needs what one copy cost (0 if unknown, then Revalue)' };
    return { action: 'create', stock: true, reorder };
  }
  return { action: reorder ? 'update' : 'unchanged', stock: false, reorder };
}
