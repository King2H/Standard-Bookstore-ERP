import { Money, type Book, type BookEdit, type LifecycleStatus } from '@bms/shared';
import type { BookEditRecord, BookRecord } from './catalog.types.js';

/** The columns catalog.repository selects for a book. */
export interface BookRow {
  id: number;
  isbn: string;
  sku: string | null;
  title: string;
  genre: string | null;
  publisher: string | null;
  publisher_id: number | null;
  edition: string | null;
  language: string | null;
  format: string | null;
  description: string | null;
  cover_image_url: string | null;
  default_price: string | null;
  trade_value: string | null;
  is_active: boolean;
  status: string;
  archived_at: Date | null;
  created_at: Date;
  format_id: number | null;
  format_code: string | null;
  format_label: string | null;
  edition_id: number | null;
  edition_code: string | null;
  edition_label: string | null;
  authors: string[];
  author_ids: number[];
  categories: string[];
  category_ids: number[];
  tags: string[];
  branch_price: string | null;
}

const money = (v: string | null) => (v === null ? null : Money.of(v));

export function toBookRecord(row: BookRow): BookRecord {
  return {
    id: row.id,
    isbn: row.isbn,
    sku: row.sku,
    title: row.title,
    authors: row.authors,
    authorIds: row.author_ids,
    genre: row.genre,
    publisher: row.publisher,
    publisherId: row.publisher_id,
    formatId: row.format_id,
    formatCode: row.format_code,
    formatLabel: row.format_label,
    editionId: row.edition_id,
    editionCode: row.edition_code,
    editionLabel: row.edition_label,
    edition: row.edition,
    language: row.language,
    format: row.format,
    description: row.description,
    coverImageUrl: row.cover_image_url,
    defaultPrice: money(row.default_price),
    tradeValue: money(row.trade_value),
    isActive: row.is_active,
    status: row.status as LifecycleStatus,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    categories: row.categories,
    categoryIds: row.category_ids,
    tags: row.tags,
    branchPrice: money(row.branch_price),
  };
}

export function toBookResponse(r: BookRecord): Book {
  return {
    ...r,
    defaultPrice: r.defaultPrice?.toNumber() ?? null,
    tradeValue: r.tradeValue?.toNumber() ?? null,
    branchPrice: r.branchPrice?.toNumber() ?? null,
    stockQuantity: null,
    archivedAt: r.archivedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

export function toBookEditResponse(r: BookEditRecord): BookEdit {
  return { ...r, changedAt: r.changedAt.toISOString() };
}
