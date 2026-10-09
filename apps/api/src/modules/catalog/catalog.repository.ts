import { sql, type RawBuilder } from 'kysely';
import { Money, type LifecycleStatus } from '@bms/shared';
import type { Queryable } from '../../db/tx.js';
import { toBookRecord, type BookRow } from './catalog.mapper.js';
import type {
  BookEditRecord,
  BookFields,
  BookFilter,
  BookRecord,
  BranchPriceRecord,
  BookEdit,
  LinkedName,
} from './catalog.types.js';

// Books are shared by every branch, so these queries take no branch scope;
// a branch id only picks which branch price to show. Tenant scope arrives
// with tenancy (#13).

type Page = { limit: number; offset: number };

/** One book with its format, edition, authors, categories, tags and the price in `branchId`. */
function selectBooks(branchId: number | null): RawBuilder<unknown> {
  return sql`
    SELECT
      b.id, b.isbn, b.sku, b.title, b.genre, b.publisher, b.publisher_id,
      b.edition, b.language, b.format, b.description, b.cover_image_url,
      b.default_price, b.trade_value, b.is_active, b.status, b.archived_at, b.created_at,
      b.format_id, bf.code AS format_code, bf.label AS format_label,
      b.edition_id, be.code AS edition_code, be.label AS edition_label,
      COALESCE((SELECT ARRAY_AGG(a.name ORDER BY a.name, a.id) FROM book_authors ba
                JOIN authors a ON a.id = ba.author_id WHERE ba.book_id = b.id), '{}') AS authors,
      COALESCE((SELECT ARRAY_AGG(a.id ORDER BY a.name, a.id) FROM book_authors ba
                JOIN authors a ON a.id = ba.author_id WHERE ba.book_id = b.id), '{}') AS author_ids,
      COALESCE((SELECT ARRAY_AGG(c.name ORDER BY c.name, c.id) FROM book_categories bc
                JOIN categories c ON c.id = bc.category_id WHERE bc.book_id = b.id), '{}') AS categories,
      COALESCE((SELECT ARRAY_AGG(c.id ORDER BY c.name, c.id) FROM book_categories bc
                JOIN categories c ON c.id = bc.category_id WHERE bc.book_id = b.id), '{}') AS category_ids,
      COALESCE((SELECT ARRAY_AGG(bt.tag ORDER BY bt.tag) FROM book_tags bt WHERE bt.book_id = b.id), '{}') AS tags,
      bbp.price AS branch_price
    FROM books b
    LEFT JOIN book_formats bf ON bf.id = b.format_id
    LEFT JOIN book_editions be ON be.id = b.edition_id
    LEFT JOIN book_branch_prices bbp ON bbp.book_id = b.id AND bbp.branch_id = ${branchId}
      AND bbp.format_id = 0 AND bbp.edition_id = 0`;
}

function contains(value: string): string {
  return `%${value.trim()}%`;
}

function conditionsOf(filter: BookFilter): RawBuilder<unknown> {
  const parts: RawBuilder<unknown>[] = [];
  if (filter.q) {
    const term = contains(filter.q);
    const any = [
      sql`lower(b.title) LIKE lower(${term})`,
      sql`b.isbn LIKE ${term}`,
      sql`lower(COALESCE(b.sku, '')) LIKE lower(${term})`,
      sql`lower(COALESCE(b.publisher, '')) LIKE lower(${term})`,
      sql`lower(COALESCE(b.description, '')) LIKE lower(${term})`,
      sql`EXISTS (SELECT 1 FROM book_authors ba_q JOIN authors a_q ON a_q.id = ba_q.author_id
                  WHERE ba_q.book_id = b.id AND lower(a_q.name) LIKE lower(${term}))`,
    ];
    if (filter.qIsbns?.length) any.push(sql`b.isbn = ANY(${filter.qIsbns})`);
    parts.push(sql`(${sql.join(any, sql` OR `)})`);
  }
  if (filter.isbns?.length) parts.push(sql`b.isbn = ANY(${filter.isbns})`);
  if (filter.sku) parts.push(sql`lower(b.sku) LIKE lower(${contains(filter.sku)})`);
  if (filter.author) {
    parts.push(sql`EXISTS (SELECT 1 FROM book_authors ba2 JOIN authors a2 ON a2.id = ba2.author_id
                           WHERE ba2.book_id = b.id AND lower(a2.name) LIKE lower(${contains(filter.author)}))`);
  }
  if (filter.genre) parts.push(sql`lower(b.genre) = lower(${filter.genre})`);
  if (filter.category) {
    parts.push(sql`EXISTS (SELECT 1 FROM book_categories bc2 JOIN categories c2 ON c2.id = bc2.category_id
                           WHERE bc2.book_id = b.id AND lower(c2.name) = lower(${filter.category}))`);
  }
  if (filter.tag) {
    parts.push(sql`EXISTS (SELECT 1 FROM book_tags bt2 WHERE bt2.book_id = b.id AND lower(bt2.tag) = lower(${filter.tag}))`);
  }
  if (filter.statuses) parts.push(sql`b.status = ANY(${filter.statuses})`);
  else if (filter.isActive !== undefined) parts.push(sql`b.is_active = ${filter.isActive}`);
  return parts.length ? sql`WHERE ${sql.join(parts, sql` AND `)}` : sql``;
}

const SORT = {
  title: sql.ref('b.title'),
  isbn: sql.ref('b.isbn'),
  created_at: sql.ref('b.created_at'),
  default_price: sql.ref('b.default_price'),
};

export async function listBooks(
  q: Queryable,
  filter: BookFilter,
  branchId: number | null,
  page: Page,
): Promise<{ items: BookRecord[]; total: number }> {
  const where = conditionsOf(filter);
  const order = sql`ORDER BY ${SORT[filter.sortBy ?? 'title']} ${sql.raw(filter.sortDir === 'desc' ? 'DESC' : 'ASC')}, b.id`;
  const [rows, count] = await Promise.all([
    sql<BookRow>`${selectBooks(branchId)} ${where} ${order} LIMIT ${page.limit} OFFSET ${page.offset}`.execute(q),
    sql<{ count: string }>`SELECT COUNT(*) AS count FROM books b ${where}`.execute(q),
  ]);
  return { items: rows.rows.map(toBookRecord), total: Number(count.rows[0].count) };
}

export async function findBook(q: Queryable, id: number, branchId: number | null): Promise<BookRecord | undefined> {
  const { rows } = await sql<BookRow>`${selectBooks(branchId)} WHERE b.id = ${id}`.execute(q);
  return rows[0] && toBookRecord(rows[0]);
}

// ── Writes ────────────────────────────────────────────────────────────────────

function columnsOf(fields: BookFields) {
  const set = <T>(value: T | undefined) => value;
  return Object.fromEntries(
    Object.entries({
      isbn: set(fields.isbn),
      sku: set(fields.sku),
      title: set(fields.title),
      genre: set(fields.genre),
      publisher: set(fields.publisher),
      publisher_id: set(fields.publisherId),
      format_id: set(fields.formatId),
      edition_id: set(fields.editionId),
      edition: set(fields.edition),
      language: set(fields.language),
      format: set(fields.format),
      description: set(fields.description),
      cover_image_url: set(fields.coverImageUrl),
      default_price: fields.defaultPrice === undefined || fields.defaultPrice === null ? fields.defaultPrice : String(fields.defaultPrice),
      trade_value: fields.tradeValue === undefined || fields.tradeValue === null ? fields.tradeValue : String(fields.tradeValue),
    }).filter(([, v]) => v !== undefined),
  );
}

export async function insertBook(q: Queryable, fields: BookFields & { isbn: string; title: string }): Promise<number> {
  const row = await q
    .insertInto('books')
    .values({ ...columnsOf(fields), isbn: fields.isbn, title: fields.title, is_active: true })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function updateBook(q: Queryable, id: number, fields: BookFields, updatedBy: number): Promise<void> {
  await q
    .updateTable('books')
    .set({ ...columnsOf(fields), updated_by: updatedBy, updated_at: sql`now()` })
    .where('id', '=', id)
    .execute();
}

/** Rebuilds the search vector from the book's current authors (the trigger runs on UPDATE). */
export async function refreshSearch(q: Queryable, id: number): Promise<void> {
  await sql`UPDATE books SET title = title WHERE id = ${id}`.execute(q);
}

/** Authors or categories by id, with their status. */
export async function linkedById(q: Queryable, table: 'authors' | 'categories' | 'publishers', ids: number[]): Promise<LinkedName[]> {
  if (ids.length === 0) return [];
  const rows = await q.selectFrom(table).select(['id', 'name', 'status']).where('id', 'in', ids).execute();
  return rows.map((r) => ({ id: r.id, name: r.name, status: r.status as LifecycleStatus }));
}

/**
 * The author or category of each name, matched ignoring letter case; a name
 * not found yet is created. An existing record keeps its own spelling.
 */
export async function findOrCreateByName(q: Queryable, table: 'authors' | 'categories', names: string[]): Promise<LinkedName[]> {
  const found: LinkedName[] = [];
  for (const raw of names) {
    const name = raw.trim();
    const normalized = name.toLowerCase();
    if (!normalized) continue;
    await q
      .insertInto(table)
      .values({ name, normalized_name: normalized })
      .onConflict((oc) => oc.column('normalized_name').doNothing())
      .execute();
    const row = await q
      .selectFrom(table)
      .select(['id', 'name', 'status'])
      .where('normalized_name', '=', normalized)
      .executeTakeFirstOrThrow();
    if (!found.some((f) => f.id === row.id)) found.push({ id: row.id, name: row.name, status: row.status as LifecycleStatus });
  }
  return found;
}

export async function replaceAuthors(q: Queryable, bookId: number, authorIds: number[]): Promise<void> {
  await q.deleteFrom('book_authors').where('book_id', '=', bookId).execute();
  if (authorIds.length === 0) return;
  await q
    .insertInto('book_authors')
    .values(authorIds.map((authorId, i) => ({ book_id: bookId, author_id: authorId, sort_order: i })))
    .onConflict((oc) => oc.doNothing())
    .execute();
}

export async function replaceCategories(q: Queryable, bookId: number, categoryIds: number[]): Promise<void> {
  await q.deleteFrom('book_categories').where('book_id', '=', bookId).execute();
  if (categoryIds.length === 0) return;
  await q
    .insertInto('book_categories')
    .values(categoryIds.map((categoryId) => ({ book_id: bookId, category_id: categoryId })))
    .onConflict((oc) => oc.doNothing())
    .execute();
}

export async function replaceTags(q: Queryable, bookId: number, tags: string[]): Promise<void> {
  await q.deleteFrom('book_tags').where('book_id', '=', bookId).execute();
  const clean = [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
  if (clean.length === 0) return;
  await q.insertInto('book_tags').values(clean.map((tag) => ({ book_id: bookId, tag }))).execute();
}

export async function insertEdits(q: Queryable, bookId: number, edits: BookEdit[], changedBy: number): Promise<void> {
  if (edits.length === 0) return;
  await q
    .insertInto('book_edit_history')
    .values(edits.map((e) => ({ book_id: bookId, field_name: e.field, old_value: e.oldValue, new_value: e.newValue, changed_by: changedBy })))
    .execute();
}

// ── Lifecycle and delete ──────────────────────────────────────────────────────

/** Locks the book and returns its status; undefined when it does not exist. */
export async function lockStatus(q: Queryable, id: number): Promise<LifecycleStatus | undefined> {
  const row = await q.selectFrom('books').select('status').where('id', '=', id).forUpdate().executeTakeFirst();
  return row?.status as LifecycleStatus | undefined;
}

/** is_active follows the status: operational checks in POS, orders and procurement read it. */
export async function setStatus(q: Queryable, id: number, status: LifecycleStatus, staffId: number): Promise<void> {
  const archived = status === 'ARCHIVED';
  await q
    .updateTable('books')
    .set({
      status,
      is_active: status === 'ACTIVE',
      archived_at: archived ? sql`now()` : null,
      archived_by: archived ? staffId : null,
      updated_at: sql`now()`,
      updated_by: staffId,
    })
    .where('id', '=', id)
    .execute();
}

/** What refers to the book, by kind (the usage endpoint's fields). */
export async function usage(q: Queryable, id: number): Promise<Record<string, number>> {
  const { rows } = await sql<Record<string, string>>`
    SELECT
      (SELECT COUNT(*) FROM inventory WHERE book_id = ${id} AND quantity > 0) AS inventory,
      (SELECT COUNT(*) FROM transaction_line_items WHERE book_id = ${id}) AS sales,
      (SELECT COUNT(DISTINCT order_id) FROM order_line_items WHERE book_id = ${id}) AS orders,
      (SELECT COUNT(*) FROM return_line_items WHERE book_id = ${id}) AS returns,
      (SELECT COUNT(DISTINCT exchange_id) FROM (
         SELECT exchange_id, book_id FROM exchange_incoming_items
         UNION ALL
         SELECT exchange_id, book_id FROM exchange_outgoing_items
       ) x WHERE book_id = ${id}) AS exchanges,
      (SELECT COUNT(DISTINCT po_id) FROM po_line_items WHERE book_id = ${id}) AS "purchaseOrders"`.execute(q);
  return Object.fromEntries(Object.entries(rows[0]).map(([k, v]) => [k, Number(v)]));
}

export async function stockMovementCount(q: Queryable, id: number): Promise<number> {
  const row = await q
    .selectFrom('inventory_history')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('book_id', '=', id)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

export async function remove(q: Queryable, id: number): Promise<void> {
  await q.deleteFrom('books').where('id', '=', id).execute();
}

// ── Prices, history, suggestions ──────────────────────────────────────────────

export async function setBranchPrice(q: Queryable, bookId: number, branchId: number, price: Money): Promise<void> {
  await q
    .insertInto('book_branch_prices')
    .values({ book_id: bookId, branch_id: branchId, price: price.toFixed(2), format_id: 0, edition_id: 0 })
    .onConflict((oc) => oc.columns(['book_id', 'branch_id', 'format_id', 'edition_id']).doUpdateSet({ price: price.toFixed(2) }))
    .execute();
}

export async function branchPrices(q: Queryable, bookId: number): Promise<BranchPriceRecord[]> {
  const rows = await q
    .selectFrom('book_branch_prices as bbp')
    .innerJoin('branches as br', 'br.id', 'bbp.branch_id')
    .select(['bbp.branch_id', 'br.name', 'bbp.price'])
    .where('bbp.book_id', '=', bookId)
    .orderBy('br.name')
    .execute();
  return rows.map((r) => ({ branchId: r.branch_id, branchName: r.name, price: Money.of(r.price) }));
}

export async function editHistory(q: Queryable, bookId: number, page: Page): Promise<{ items: BookEditRecord[]; total: number }> {
  const [rows, count] = await Promise.all([
    q
      .selectFrom('book_edit_history as beh')
      .leftJoin('staff as s', 's.id', 'beh.changed_by')
      .select(['beh.id', 'beh.book_id', 'beh.field_name', 'beh.old_value', 'beh.new_value', 'beh.changed_by', 'beh.changed_at', 's.username'])
      .where('beh.book_id', '=', bookId)
      .orderBy('beh.changed_at', 'desc')
      .orderBy('beh.id', 'desc')
      .limit(page.limit)
      .offset(page.offset)
      .execute(),
    q
      .selectFrom('book_edit_history')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('book_id', '=', bookId)
      .executeTakeFirstOrThrow(),
  ]);
  return {
    items: rows.map((r) => ({
      id: String(r.id),
      bookId: r.book_id,
      fieldName: r.field_name,
      oldValue: r.old_value,
      newValue: r.new_value,
      changedBy: r.changed_by,
      changedByUsername: r.username,
      changedAt: r.changed_at,
    })),
    total: Number(count.count),
  };
}

/** Active names starting with `prefix`, for the book form. */
export async function suggest(q: Queryable, table: 'authors' | 'categories', prefix: string, limit: number): Promise<string[]> {
  const rows = await q
    .selectFrom(table)
    .select('name')
    .where('normalized_name', 'like', `${prefix.trim().toLowerCase()}%`)
    .where('status', '=', 'ACTIVE')
    .orderBy('name')
    .limit(limit)
    .execute();
  return rows.map((r) => r.name);
}
