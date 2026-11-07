import { Money, type ImportKind, type ImportReport, type ImportRowError } from '@bms/shared';
import { cellText } from '../../lib/csvRead.js';
import { storedIsbn } from '../catalog/catalog.policy.js';

// Rules every import file shares (#246): pure, no database.

const MAX_ERRORS_LISTED = 500;

/** Where each known column is; unknown and repeated columns are file errors. */
export function readColumns<C extends string>(header: string[], columns: readonly C[]): { index: Partial<Record<C, number>>; errors: string[] } {
  const index: Partial<Record<C, number>> = {};
  const errors: string[] = [];
  header.forEach((name, i) => {
    const column = columns.find((c) => c.toLowerCase() === name.toLowerCase());
    if (!column) errors.push(`Unknown column '${name}': the columns are ${columns.join(', ')}`);
    else if (index[column] !== undefined) errors.push(`Column '${column}' appears twice`);
    else index[column] = i;
  });
  return { index, errors };
}

/** A row's cells by column name, as written (see cellText). */
export function cellsOf<C extends string>(cells: string[], index: Partial<Record<C, number>>): (column: C) => string {
  return (column) => (index[column] === undefined ? '' : cellText(cells[index[column]!] ?? ''));
}

/**
 * The ISBN a book is stored under, from an ISBN cell: an ISBN-13, an ISBN-10
 * as its ISBN-13, or SKU-<sku> for a book without one (as exported).
 */
export function bookKey(cell: string): { key?: string; isbn?: string; placeholder?: string; message?: string } {
  if (/^SKU-\S+$/.test(cell)) return { key: cell, placeholder: cell };
  try {
    const isbn = storedIsbn(cell);
    return isbn ? { key: isbn, isbn } : {};
  } catch {
    return { message: `ISBN '${cell}' is not a valid ISBN-13 or ISBN-10` };
  }
}

/** An amount as written: digits, a decimal point (or a comma in a semicolon file), at most `decimals` decimals. */
export function readAmount(cell: string, decimalComma: boolean, decimals = 2): string | null {
  const text = decimalComma ? cell.replace(',', '.') : cell;
  if (!new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`).test(text)) return null;
  return Money.of(text).toFixed(decimals);
}

/** A whole number of 0 or more. */
export function readCount(cell: string): number | null {
  return /^\d{1,9}$/.test(cell) ? Number(cell) : null;
}

/** The report of a checked file: errors by line, the first 500 listed. */
export function reportOf(
  kind: ImportKind,
  rows: number,
  valid: number,
  counts: { toCreate: number; toUpdate: number; unchanged: number },
  errors: ImportRowError[],
  notices: ImportRowError[] = [],
  newNames: ImportReport['newNames'] = { authors: [], categories: [], publishers: [] },
): ImportReport {
  const sorted = [...errors].sort((a, b) => a.line - b.line);
  return {
    kind, rows, valid, ...counts,
    errors: sorted.slice(0, MAX_ERRORS_LISTED), moreErrors: Math.max(0, sorted.length - MAX_ERRORS_LISTED),
    notices: notices.slice(0, MAX_ERRORS_LISTED), newNames,
  };
}
