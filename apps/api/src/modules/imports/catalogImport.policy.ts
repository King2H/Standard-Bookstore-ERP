import { CATALOG_IMPORT_COLUMNS, Money, type UpdateBookRequest } from '@bms/shared';
import { readAmount, readColumns } from './importFile.policy.js';
import { cellText } from '../../lib/csvRead.js';
import { placeholderIsbn, storedIsbn } from '../catalog/catalog.policy.js';
import type { BookRecord } from '../catalog/catalog.types.js';

// The rules of a catalog file (#246): pure, no database. A row names its book
// by ISBN (an ISBN-10 is stored as its ISBN-13), or by SKU for a book without
// one; an empty cell leaves the book's value as it is.

export type CatalogColumn = (typeof CATALOG_IMPORT_COLUMNS)[number];

export interface CatalogRow {
  line: number;
  /** The stored ISBN, or the SKU placeholder a book without one is stored under. */
  key: string;
  isbn: string | undefined;
  sku: string | undefined;
  title: string;
  authors: string[];
  publisher: string | undefined;
  categories: string[];
  format: string | undefined;
  language: string | undefined;
  /** Two decimals, e.g. "250.50". */
  price: string | undefined;
}

/** Where each column is in the file; unknown or missing columns are file errors. */
export function readHeader(header: string[]): { index: Partial<Record<CatalogColumn, number>>; errors: string[] } {
  const { index, errors } = readColumns(header, CATALOG_IMPORT_COLUMNS);
  if (index.Title === undefined) errors.push('The file has no Title column: start from the template');
  if (index.ISBN === undefined && index.SKU === undefined) errors.push('The file has neither an ISBN nor a SKU column: start from the template');
  return { index, errors };
}

/** A list cell: names separated by semicolons. */
function names(cell: string): string[] {
  return cell.split(';').map((n) => n.trim()).filter((n) => n !== '');
}

/** A price as written: two decimals at most (see readAmount). */
export function readPrice(cell: string, decimalComma: boolean): string | null {
  return readAmount(cell, decimalComma, 2);
}

/** One data row: the book it describes, or why it cannot be imported. */
export function readCatalogRow(
  cells: string[],
  index: Partial<Record<CatalogColumn, number>>,
  line: number,
  decimalComma: boolean,
): { row?: CatalogRow; messages: string[] } {
  const cell = (c: CatalogColumn) => (index[c] === undefined ? '' : cellText(cells[index[c]!] ?? ''));
  const messages: string[] = [];

  let isbn: string | undefined;
  // A book without an ISBN is stored, and exported, under SKU-<its SKU>.
  const placeholder = /^SKU-\S+$/.test(cell('ISBN')) ? cell('ISBN') : undefined;
  if (!placeholder) {
    try {
      isbn = storedIsbn(cell('ISBN'));
    } catch {
      messages.push(`ISBN '${cell('ISBN')}' is not a valid ISBN-13 or ISBN-10`);
    }
  }
  const sku = cell('SKU') || placeholder?.slice(4) || undefined;
  if (!cell('ISBN') && !sku) messages.push('A book needs an ISBN or a SKU, so that importing the file again finds it');
  const title = cell('Title');
  if (!title) messages.push('Title is empty');
  else if (title.length > 500) messages.push('Title is longer than 500 characters');

  let price: string | undefined;
  if (cell('Price')) {
    const read = readPrice(cell('Price'), decimalComma);
    if (read === null) messages.push(`Price '${cell('Price')}' is not an amount with at most two decimals`);
    else price = read;
  }
  if (messages.length > 0) return { messages };

  return {
    row: {
      line,
      key: isbn ?? placeholder ?? placeholderIsbn(sku, 0),
      isbn,
      sku,
      title,
      authors: names(cell('Authors')),
      publisher: cell('Publisher') || undefined,
      categories: names(cell('Categories')),
      format: cell('Format') || undefined,
      language: cell('Language') || undefined,
      price,
    },
    messages: [],
  };
}

const sameNames = (a: string[], b: string[]) =>
  a.length === b.length && [...a].map((n) => n.toLowerCase()).sort().join('\n') === [...b].map((n) => n.toLowerCase()).sort().join('\n');

/**
 * What a row changes on its existing book: only the cells given, and only
 * where they differ (names ignoring letter case). Empty when nothing changes.
 */
export function catalogChanges(
  existing: BookRecord,
  existingPublisher: string | null,
  row: CatalogRow,
  resolved: { formatId: number | undefined; publisherId: number | undefined },
): UpdateBookRequest {
  const change: UpdateBookRequest = {};
  if (row.title !== existing.title) change.title = row.title;
  if (row.sku && row.sku !== existing.sku) change.sku = row.sku;
  if (row.authors.length > 0 && !sameNames(row.authors, existing.authors)) change.authors = row.authors;
  if (row.categories.length > 0 && !sameNames(row.categories, existing.categories)) change.categories = row.categories;
  if (row.publisher && row.publisher.toLowerCase() !== (existingPublisher ?? '').toLowerCase()) {
    change.publisher = row.publisher;
    if (resolved.publisherId !== undefined) change.publisherId = resolved.publisherId;
  }
  if (resolved.formatId !== undefined && resolved.formatId !== existing.formatId) change.formatId = resolved.formatId;
  if (row.language && row.language !== existing.language) change.language = row.language;
  if (row.price !== undefined && (existing.defaultPrice === null || !existing.defaultPrice.equals(row.price))) {
    change.defaultPrice = Money.of(row.price).toNumber();
  }
  return change;
}
