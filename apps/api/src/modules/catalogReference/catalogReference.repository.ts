import { sql } from 'kysely';
import type { LifecycleStatus } from '@bms/shared';
import type { Queryable } from '../../db/tx.js';
import {
  toAuthorRecord,
  toCategoryRecord,
  toPublisherRecord,
  type AuthorRow,
  type CategoryRow,
  type PublisherRow,
} from './catalogReference.mapper.js';
import type {
  AuthorRecord,
  CategoryRecord,
  LookupRecord,
  PublisherRecord,
  ReferenceFilter,
  ReferenceKind,
} from './catalogReference.types.js';

// Reference data is shared by every branch, so these queries take no branch
// scope. Tenant scope arrives with tenancy (#13).

type Page = { limit: number; offset: number };

const TABLE = { author: 'authors', category: 'categories', publisher: 'publishers' } as const;

// What links a book to each kind; a record in use cannot be deleted.
const BOOK_LINKS = {
  author: sql<string>`(SELECT COUNT(*) FROM book_authors WHERE author_id = ${sql.ref('t.id')})`,
  category: sql<string>`(SELECT COUNT(*) FROM book_categories WHERE category_id = ${sql.ref('t.id')})`,
  publisher: sql<string>`(SELECT COUNT(*) FROM books WHERE publisher_id = ${sql.ref('t.id')})`,
};

function startsWith(q: string): string {
  return `${q.trim().toLowerCase()}%`;
}

// ── Authors ───────────────────────────────────────────────────────────────────

export async function listAuthors(q: Queryable, filter: ReferenceFilter, page: Page): Promise<{ items: AuthorRecord[]; total: number }> {
  let query = q.selectFrom('authors as t');
  if (filter.q) query = query.where('t.normalized_name', 'like', startsWith(filter.q));
  if (filter.statuses) query = query.where('t.status', 'in', filter.statuses);

  const [rows, count] = await Promise.all([
    query
      .select(['t.id', 't.name', 't.normalized_name', 't.status', 't.archived_at', 't.created_at'])
      .select(sql<number>`${BOOK_LINKS.author}::int`.as('book_count'))
      .orderBy('t.name')
      .limit(page.limit)
      .offset(page.offset)
      .execute(),
    query.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow(),
  ]);
  return { items: rows.map((r) => toAuthorRecord(r as AuthorRow)), total: Number(count.count) };
}

export async function insertAuthor(q: Queryable, name: string, normalizedName: string): Promise<AuthorRecord> {
  const row = await q
    .insertInto('authors')
    .values({ name, normalized_name: normalizedName })
    .returning(['id', 'name', 'normalized_name', 'status', 'archived_at', 'created_at'])
    .executeTakeFirstOrThrow();
  return toAuthorRecord(row as AuthorRow);
}

/** Undefined when the author does not exist. */
export async function updateAuthor(
  q: Queryable,
  id: number,
  change: { name: string; normalizedName: string; updatedBy: number },
): Promise<AuthorRecord | undefined> {
  const row = await q
    .updateTable('authors')
    .set({ name: change.name, normalized_name: change.normalizedName, updated_by: change.updatedBy, updated_at: sql`now()` })
    .where('id', '=', id)
    .returning(['id', 'name', 'normalized_name', 'status', 'archived_at', 'created_at'])
    .executeTakeFirst();
  return row && toAuthorRecord(row as AuthorRow);
}

// ── Categories ────────────────────────────────────────────────────────────────

const CATEGORY_COLUMNS = ['id', 'name', 'normalized_name', 'parent_id', 'status', 'archived_at', 'created_at'] as const;

export async function listCategories(
  q: Queryable,
  filter: ReferenceFilter,
  page: Page,
): Promise<{ items: CategoryRecord[]; total: number }> {
  let query = q.selectFrom('categories as t');
  if (filter.q) query = query.where('t.normalized_name', 'like', startsWith(filter.q));
  if (filter.statuses) query = query.where('t.status', 'in', filter.statuses);

  const [rows, count] = await Promise.all([
    query
      .leftJoin('categories as p', 'p.id', 't.parent_id')
      .select(['t.id', 't.name', 't.normalized_name', 't.parent_id', 't.status', 't.archived_at', 't.created_at'])
      .select(['p.name as parent_name', sql<number>`${BOOK_LINKS.category}::int`.as('book_count')])
      .orderBy('t.name')
      .limit(page.limit)
      .offset(page.offset)
      .execute(),
    query.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow(),
  ]);
  return { items: rows.map((r) => toCategoryRecord(r as CategoryRow)), total: Number(count.count) };
}

export async function insertCategory(
  q: Queryable,
  category: { name: string; normalizedName: string; parentId: number | null },
): Promise<CategoryRecord> {
  const row = await q
    .insertInto('categories')
    .values({ name: category.name, normalized_name: category.normalizedName, parent_id: category.parentId })
    .returning(CATEGORY_COLUMNS)
    .executeTakeFirstOrThrow();
  return toCategoryRecord(row as CategoryRow);
}

/** Changes only the fields given. Undefined when the category does not exist. */
export async function updateCategory(
  q: Queryable,
  id: number,
  change: { name?: string; normalizedName?: string; parentId?: number | null; updatedBy: number },
): Promise<CategoryRecord | undefined> {
  const row = await q
    .updateTable('categories')
    .set({
      ...(change.name !== undefined && { name: change.name, normalized_name: change.normalizedName }),
      ...(change.parentId !== undefined && { parent_id: change.parentId }),
      updated_by: change.updatedBy,
      updated_at: sql`now()`,
    })
    .where('id', '=', id)
    .returning(CATEGORY_COLUMNS)
    .executeTakeFirst();
  return row && toCategoryRecord(row as CategoryRow);
}

/** The category and its ancestors, nearest first; empty when it does not exist. */
export async function categoryChain(q: Queryable, id: number): Promise<number[]> {
  const { rows } = await sql<{ id: number }>`
    WITH RECURSIVE chain(id, parent_id, depth) AS (
      SELECT id, parent_id, 0 FROM categories WHERE id = ${id}
      UNION ALL
      SELECT c.id, c.parent_id, chain.depth + 1
      FROM categories c JOIN chain ON c.id = chain.parent_id
      WHERE chain.depth < 100
    )
    SELECT id FROM chain ORDER BY depth`.execute(q);
  return rows.map((r) => r.id);
}

// ── Publishers ────────────────────────────────────────────────────────────────

const PUBLISHER_COLUMNS = ['id', 'name', 'status', 'archived_at', 'created_at'] as const;

export async function listPublishers(
  q: Queryable,
  filter: ReferenceFilter,
  page: Page,
): Promise<{ items: PublisherRecord[]; total: number }> {
  let query = q.selectFrom('publishers as t');
  if (filter.q) query = query.where(sql`lower(t.name)`, 'like', startsWith(filter.q));
  if (filter.statuses) query = query.where('t.status', 'in', filter.statuses);

  const [rows, count] = await Promise.all([
    query
      .select(['t.id', 't.name', 't.status', 't.archived_at', 't.created_at'])
      .select(sql<number>`${BOOK_LINKS.publisher}::int`.as('book_count'))
      .orderBy('t.name')
      .limit(page.limit)
      .offset(page.offset)
      .execute(),
    query.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow(),
  ]);
  return { items: rows.map((r) => toPublisherRecord(r as PublisherRow)), total: Number(count.count) };
}

export async function insertPublisher(q: Queryable, name: string): Promise<PublisherRecord> {
  const row = await q.insertInto('publishers').values({ name }).returning(PUBLISHER_COLUMNS).executeTakeFirstOrThrow();
  return toPublisherRecord(row as PublisherRow);
}

/** Undefined when the publisher does not exist. */
export async function updatePublisher(
  q: Queryable,
  id: number,
  change: { name: string; updatedBy: number },
): Promise<PublisherRecord | undefined> {
  const row = await q
    .updateTable('publishers')
    .set({ name: change.name, updated_by: change.updatedBy, updated_at: sql`now()` })
    .where('id', '=', id)
    .returning(PUBLISHER_COLUMNS)
    .executeTakeFirst();
  return row && toPublisherRecord(row as PublisherRow);
}

// ── Any kind ──────────────────────────────────────────────────────────────────

/** Locks the record and returns its status; undefined when it does not exist. */
export async function lockStatus(q: Queryable, kind: ReferenceKind, id: number): Promise<LifecycleStatus | undefined> {
  const { rows } = await sql<{ status: LifecycleStatus }>`
    SELECT status FROM ${sql.table(TABLE[kind])} WHERE id = ${id} FOR UPDATE`.execute(q);
  return rows[0]?.status;
}

export async function setStatus(q: Queryable, kind: ReferenceKind, id: number, status: LifecycleStatus, staffId: number): Promise<void> {
  const archived = status === 'ARCHIVED';
  await sql`
    UPDATE ${sql.table(TABLE[kind])}
    SET status = ${status},
        archived_at = ${archived ? sql`now()` : null},
        archived_by = ${archived ? staffId : null},
        updated_at = now(),
        updated_by = ${staffId}
    WHERE id = ${id}`.execute(q);
}

/** How many books use the record; undefined when it does not exist. */
export async function bookUsage(q: Queryable, kind: ReferenceKind, id: number): Promise<number | undefined> {
  const { rows } = await sql<{ books: string }>`
    SELECT ${BOOK_LINKS[kind]} AS books FROM ${sql.table(TABLE[kind])} AS t WHERE t.id = ${id}`.execute(q);
  return rows[0] && Number(rows[0].books);
}

/** False when the record does not exist. */
export async function remove(q: Queryable, kind: ReferenceKind, id: number): Promise<boolean> {
  const result = await sql`DELETE FROM ${sql.table(TABLE[kind])} WHERE id = ${id}`.execute(q);
  return Number(result.numAffectedRows ?? 0) > 0;
}

// ── Formats and editions ──────────────────────────────────────────────────────

export async function lookups(q: Queryable, table: 'book_formats' | 'book_editions'): Promise<LookupRecord[]> {
  const rows = await q.selectFrom(table).select(['id', 'code', 'label', 'sort_order']).orderBy('sort_order').execute();
  return rows.map((r) => ({ id: r.id, code: r.code, label: r.label, sortOrder: r.sort_order }));
}
