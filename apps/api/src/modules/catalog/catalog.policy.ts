import type { LifecycleStatus } from '@bms/shared';
import { BusinessError, ConflictError, ValidationError } from '../../lib/errors.js';
import type { BookEdit, LinkedName } from './catalog.types.js';

/** Pure rules of the book catalog (A5). */

// Books follow the same lifecycle rules as authors, categories and
// publishers (owner decision, #21).
export { nextStatus } from '../catalogReference/catalogReference.policy.js';

export function statusesFor(status: 'active' | 'inactive' | 'archived' | 'all'): LifecycleStatus[] | undefined {
  if (status === 'all') return undefined;
  if (status === 'inactive') return ['INACTIVE'];
  if (status === 'archived') return ['ARCHIVED'];
  return ['ACTIVE'];
}

/** `?is_active=`: active books only when omitted, both for "all". */
export function isActiveFilter(value: 'true' | 'false' | 'all' | undefined): boolean | undefined {
  if (value === undefined) return true;
  if (value === 'all') return undefined;
  return value === 'true';
}

function digitsOf(isbn: string): string {
  return isbn.replace(/[-\s]/g, '').toUpperCase();
}

function isValidIsbn13(digits: string): boolean {
  if (!/^\d{13}$/.test(digits)) return false;
  const sum = [...digits].reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return sum % 10 === 0;
}

function isValidIsbn10(digits: string): boolean {
  if (!/^\d{9}[\dX]$/.test(digits)) return false;
  const sum = [...digits].reduce((acc, d, i) => acc + (d === 'X' ? 10 : Number(d)) * (10 - i), 0);
  return sum % 11 === 0;
}

/** The ISBN-13 of an ISBN-10: 978, its first nine digits, and a new check digit. */
function isbn13Of(isbn10: string): string {
  const core = `978${isbn10.slice(0, 9)}`;
  const sum = [...core].reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return `${core}${(10 - (sum % 10)) % 10}`;
}

/**
 * The ISBN a book is stored under: an ISBN-13 as given, an ISBN-10 as its
 * ISBN-13, so the same book cannot be entered twice under both numbers
 * (owner decision, #21). Undefined for a blank ISBN.
 */
export function storedIsbn(raw: string | undefined): string | undefined {
  const digits = digitsOf(raw ?? '');
  if (!digits) return undefined;
  if (isValidIsbn13(digits)) return digits;
  if (isValidIsbn10(digits)) return isbn13Of(digits);
  throw new ValidationError('Invalid ISBN: not a valid ISBN-13 or ISBN-10 check digit', { field: 'isbn' });
}

/** The ISBNs a scanned or typed number should find: itself, and the ISBN-13 of an ISBN-10. */
export function isbnSearchForms(raw: string): string[] {
  const digits = digitsOf(raw);
  return isValidIsbn10(digits) ? [digits, isbn13Of(digits)] : [digits];
}

/** What a book without an ISBN is stored under, so the column stays unique. */
export function placeholderIsbn(sku: string | undefined, now: number): string {
  const fromSku = (sku ?? '').trim().replace(/\s/g, '-');
  return `SKU-${fromSku || now}`;
}

/** An author or category matched by name must be active to be linked to a book. */
export function checkSelectable(kind: 'Author' | 'Category' | 'Publisher', records: LinkedName[]): void {
  const blocked = records.filter((r) => r.status !== 'ACTIVE');
  if (blocked.length === 0) return;
  const names = blocked.map((r) => `${r.name} (${r.status})`).join(', ');
  throw new BusinessError(`${kind.toUpperCase()}_NOT_SELECTABLE`, `${kind} not selectable while INACTIVE or ARCHIVED: ${names}`);
}

const TRACKED: Array<[key: string, column: string]> = [
  ['title', 'title'],
  ['genre', 'genre'],
  ['publisher', 'publisher'],
  ['edition', 'edition'],
  ['language', 'language'],
  ['format', 'format'],
  ['description', 'description'],
  ['coverImageUrl', 'cover_image_url'],
  ['defaultPrice', 'default_price'],
  ['tradeValue', 'trade_value'],
];

function shown(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && 'toFixed' in value) return String(Number((value as { toFixed: () => string }).toFixed()));
  return String(value);
}

/** The bibliographic fields an update changes, for the book's edit history. */
export function editsOf(existing: Record<string, unknown>, change: Record<string, unknown>): BookEdit[] {
  return TRACKED.filter(([key]) => key in change)
    .map(([key, column]) => ({ field: column, oldValue: shown(existing[key]), newValue: shown(change[key]) }))
    .filter((e) => e.oldValue !== e.newValue);
}

/** Only a book nothing refers to may be deleted; archive the others. */
export function checkDeletable(usage: Record<string, number>): void {
  if (Object.values(usage).some((n) => n > 0)) {
    throw new ConflictError('BOOK_IN_USE', 'Book has historical references and cannot be deleted — archive it instead', usage);
  }
}
