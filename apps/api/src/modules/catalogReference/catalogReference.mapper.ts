import type { Author, BookLookup, Category, LifecycleStatus, Publisher } from '@bms/shared';
import type { AuthorRecord, CategoryRecord, LookupRecord, PublisherRecord } from './catalogReference.types.js';

/** The columns catalogReference.repository selects. */
interface LifecycleRow {
  id: number;
  name: string;
  status: string;
  archived_at: Date | null;
  created_at: Date;
  book_count?: number;
}

export interface AuthorRow extends LifecycleRow {
  normalized_name: string;
}

export interface CategoryRow extends LifecycleRow {
  normalized_name: string;
  parent_id: number | null;
  parent_name?: string | null;
}

export type PublisherRow = LifecycleRow;

function lifecycle(row: LifecycleRow) {
  return {
    id: row.id,
    name: row.name,
    status: row.status as LifecycleStatus,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    ...(row.book_count !== undefined && { bookCount: Number(row.book_count) }),
  };
}

export function toAuthorRecord(row: AuthorRow): AuthorRecord {
  return { ...lifecycle(row), normalizedName: row.normalized_name };
}

export function toCategoryRecord(row: CategoryRow): CategoryRecord {
  return {
    ...lifecycle(row),
    normalizedName: row.normalized_name,
    parentId: row.parent_id,
    ...(row.parent_name !== undefined && { parentName: row.parent_name }),
  };
}

export function toPublisherRecord(row: PublisherRow): PublisherRecord {
  return lifecycle(row);
}

function dates(r: { archivedAt: Date | null; createdAt: Date }) {
  return { archivedAt: r.archivedAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString() };
}

export function toAuthorResponse(r: AuthorRecord): Author {
  return { ...r, ...dates(r) };
}

export function toCategoryResponse(r: CategoryRecord): Category {
  return { ...r, ...dates(r) };
}

export function toPublisherResponse(r: PublisherRecord): Publisher {
  return { ...r, ...dates(r) };
}

export function toLookupResponse(r: LookupRecord): BookLookup {
  return r;
}
