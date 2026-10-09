import { Money, type CreateBookRequest, type QuickRegisterBookRequest, type UpdateBookRequest } from '@bms/shared';
import { kysely } from '../../db/kysely.js';
import { isUniqueViolation } from '../../db/errors.js';
import { withTransaction, type Queryable } from '../../db/tx.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import { insertAuditEntry } from '../audit/audit.repository.js';
import { bookAvailability } from '../inventory/inventory.service.js';
import * as policy from './catalog.policy.js';
import * as books from './catalog.repository.js';
import type { Actor, BookEditRecord, BookFields, BookFilter, BookRecord, BranchPriceRecord, LinkedName, Paging } from './catalog.types.js';
import type { LifecycleAction } from '../catalogReference/catalogReference.types.js';

/**
 * Use cases of the book catalog (A4): one function each, owning its
 * transaction. Books are shared by every branch; each branch may set its own
 * price.
 */

type Paged<T> = { items: T[]; total: number; page: number; pageSize: number; totalPages: number };

function window(paging: Paging) {
  return { limit: paging.pageSize, offset: (paging.page - 1) * paging.pageSize };
}

function audit(q: Queryable, actor: Actor, action: string, entityType: string, id: number, meta: Record<string, unknown>, branchId = actor.branchId) {
  return insertAuditEntry(q, {
    staffId: actor.staffId,
    staffRole: actor.role,
    branchId,
    action,
    entityType,
    entityId: id,
    meta,
  });
}

async function bookOrThrow(q: Queryable, id: number, branchId: number | null = null): Promise<BookRecord> {
  const book = await books.findBook(q, id, branchId);
  if (!book) throw new NotFoundError('Book');
  return book;
}

async function lockOrThrow(q: Queryable, id: number) {
  const status = await books.lockStatus(q, id);
  if (!status) throw new NotFoundError('Book');
  return status;
}

// ── Links to authors, categories and publishers ──────────────────────────────

async function byId(q: Queryable, table: 'authors' | 'categories' | 'publishers', ids: number[]): Promise<LinkedName[]> {
  const unique = [...new Set(ids)];
  const found = await books.linkedById(q, table, unique);
  if (found.length !== unique.length) throw new NotFoundError(table === 'authors' ? 'Author' : table === 'categories' ? 'Category' : 'Publisher');
  // Keep the caller's order (the first author is the main one).
  return unique.map((id) => found.find((f) => f.id === id)!);
}

/**
 * The authors or categories a book should link to: ids win over names;
 * names match existing records ignoring letter case and never rename them.
 * Records the book does not link to yet must be active.
 */
async function resolveLinks(
  q: Queryable,
  table: 'authors' | 'categories',
  ids: number[] | undefined,
  names: string[] | undefined,
  alreadyLinked: number[],
): Promise<number[]> {
  const linked = ids && ids.length > 0 ? await byId(q, table, ids) : await books.findOrCreateByName(q, table, names ?? []);
  policy.checkSelectable(
    table === 'authors' ? 'Author' : 'Category',
    linked.filter((l) => !alreadyLinked.includes(l.id)),
  );
  return linked.map((l) => l.id);
}

async function checkPublisher(q: Queryable, publisherId: number | null | undefined, current: number | null): Promise<void> {
  if (!publisherId || publisherId === current) return;
  policy.checkSelectable('Publisher', await byId(q, 'publishers', [publisherId]));
}

function duplicateIsbn(isbn: string | undefined) {
  return (err: unknown): never => {
    if (isUniqueViolation(err)) throw new ConflictError('DUPLICATE_ISBN', `ISBN '${isbn}' already exists in the catalog`);
    throw err;
  };
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export async function listBooks(filter: BookFilter, branchId: number | null, paging: Paging): Promise<Paged<BookRecord>> {
  const result = await books.listBooks(kysely, filter, branchId, window(paging));
  return { ...result, page: paging.page, pageSize: paging.pageSize, totalPages: Math.ceil(result.total / paging.pageSize) };
}

/** Books with their stock at one location, for the sale and receiving screens. */
export async function listBooksWithAvailability(
  filter: BookFilter,
  branchId: number | null,
  locationId: number | undefined,
  paging: Paging,
) {
  const result = await listBooks(filter, branchId, paging);
  const stock = locationId
    ? await bookAvailability(kysely, result.items.map((b) => b.id), locationId)
    : [];
  return {
    ...result,
    items: result.items.map((book) => {
      const found = stock.find((s) => s.bookId === book.id);
      const availability = locationId
        ? (found ?? { locationId, locationName: null, onHand: 0, reserved: 0, available: 0 })
        : null;
      return { book, availability };
    }),
  };
}

/** A quick lookup across the active catalog, without paging (scanners and pickers). */
export async function searchCatalog(term: string, branchId: number | null, limit: number): Promise<BookRecord[]> {
  const filter: BookFilter = { q: term, qIsbns: policy.isbnSearchForms(term), statuses: ['ACTIVE'] };
  return (await books.listBooks(kysely, filter, branchId, { limit, offset: 0 })).items;
}

export function getBook(id: number, branchId: number | null): Promise<BookRecord> {
  return bookOrThrow(kysely, id, branchId);
}

export async function usage(id: number): Promise<Record<string, number>> {
  await bookOrThrow(kysely, id);
  return books.usage(kysely, id);
}

export async function branchPrices(id: number): Promise<BranchPriceRecord[]> {
  await bookOrThrow(kysely, id);
  return books.branchPrices(kysely, id);
}

export async function editHistory(id: number, paging: Paging): Promise<{ items: BookEditRecord[]; total: number }> {
  return books.editHistory(kysely, id, window(paging));
}

/** Active authors whose name starts with `prefix`. */
export function suggestAuthors(prefix: string): Promise<string[]> {
  return books.suggest(kysely, 'authors', prefix, 10);
}

/** Active categories whose name starts with `prefix`. */
export function suggestCategories(prefix: string): Promise<string[]> {
  return books.suggest(kysely, 'categories', prefix, 10);
}

// ── Create and update ─────────────────────────────────────────────────────────

function fieldsOf(dto: UpdateBookRequest): BookFields {
  const has = (key: keyof UpdateBookRequest) => key in dto;
  const value = <K extends keyof UpdateBookRequest>(key: K) => (has(key) ? (dto[key] ?? null) : undefined);
  return {
    sku: has('sku') ? dto.sku?.trim() || null : undefined,
    title: dto.title,
    genre: value('genre') as string | null | undefined,
    publisher: value('publisher') as string | null | undefined,
    publisherId: value('publisherId') as number | null | undefined,
    formatId: value('formatId') as number | null | undefined,
    editionId: value('editionId') as number | null | undefined,
    edition: value('edition') as string | null | undefined,
    language: value('language') as string | null | undefined,
    format: value('format') as string | null | undefined,
    description: value('description') as string | null | undefined,
    coverImageUrl: value('coverImageUrl') as string | null | undefined,
    defaultPrice: value('defaultPrice') as number | null | undefined,
    tradeValue: value('tradeValue') as number | null | undefined,
  };
}

export async function createBook(actor: Actor, dto: CreateBookRequest): Promise<BookRecord> {
  const isbn = policy.storedIsbn(dto.isbn) ?? policy.placeholderIsbn(dto.sku, Date.now());
  return withTransaction({}, async (tx) => {
    const authorIds = await resolveLinks(tx, 'authors', dto.authorIds, dto.authors, []);
    const categoryIds = await resolveLinks(tx, 'categories', dto.categoryIds, dto.categories, []);
    await checkPublisher(tx, dto.publisherId, null);

    const id = await books
      .insertBook(tx, { ...fieldsOf(dto), isbn, title: dto.title })
      .catch(duplicateIsbn(dto.isbn));
    await books.replaceAuthors(tx, id, authorIds);
    await books.replaceCategories(tx, id, categoryIds);
    await books.replaceTags(tx, id, dto.tags ?? []);
    await books.refreshSearch(tx, id);
    await audit(tx, actor, 'CREATE', 'book', id, { isbn: dto.isbn, title: dto.title });
    return bookOrThrow(tx, id);
  });
}

/** A catalog-only entry from the sale screens; the rest is filled in later. */
export function quickRegister(actor: Actor, dto: QuickRegisterBookRequest): Promise<BookRecord> {
  return createBook(actor, {
    isbn: dto.isbn,
    title: dto.title,
    authors: dto.author ? [dto.author] : [],
    defaultPrice: dto.defaultPrice,
  });
}

export async function updateBook(actor: Actor, id: number, dto: UpdateBookRequest): Promise<BookRecord> {
  return withTransaction({}, async (tx) => {
    await lockOrThrow(tx, id);
    const existing = await bookOrThrow(tx, id);

    await books.insertEdits(tx, id, policy.editsOf({ ...existing }, dto), actor.staffId);
    await checkPublisher(tx, dto.publisherId, existing.publisherId);
    await books.updateBook(tx, id, fieldsOf(dto), actor.staffId);

    if (dto.authorIds !== undefined || dto.authors !== undefined) {
      await books.replaceAuthors(tx, id, await resolveLinks(tx, 'authors', dto.authorIds, dto.authors, existing.authorIds));
    }
    if (dto.categoryIds !== undefined || dto.categories !== undefined) {
      await books.replaceCategories(tx, id, await resolveLinks(tx, 'categories', dto.categoryIds, dto.categories, existing.categoryIds));
    }
    if (dto.tags !== undefined) await books.replaceTags(tx, id, dto.tags);

    await books.refreshSearch(tx, id);
    await audit(tx, actor, 'UPDATE', 'book', id, { updatedFields: Object.keys(dto) });
    return bookOrThrow(tx, id);
  });
}

// ── Lifecycle, delete, prices ─────────────────────────────────────────────────

/** A repeat of the current status changes nothing and is not audited. */
export async function transition(actor: Actor, id: number, action: LifecycleAction): Promise<void> {
  await withTransaction({}, async (tx) => {
    const previousStatus = await lockOrThrow(tx, id);
    const newStatus = policy.nextStatus(previousStatus, action);
    if (newStatus === null) return;
    await books.setStatus(tx, id, newStatus, actor.staffId);
    await audit(tx, actor, action, 'book', id, { previousStatus, newStatus });
  });
}

/** Only a book nothing refers to may be deleted, stock movements included. */
export async function remove(actor: Actor, id: number): Promise<void> {
  await withTransaction({}, async (tx) => {
    await lockOrThrow(tx, id);
    policy.checkDeletable({ ...(await books.usage(tx, id)), inventoryTransactions: await books.stockMovementCount(tx, id) });
    await books.remove(tx, id);
    await audit(tx, actor, 'DELETE', 'book', id, {});
  });
}

/** The routes allow only the session's branch, or any with access to all branches. */
export async function setBranchPrice(actor: Actor, bookId: number, branchId: number, price: number): Promise<void> {
  await withTransaction({}, async (tx) => {
    await lockOrThrow(tx, bookId);
    await books.setBranchPrice(tx, bookId, branchId, Money.of(price));
    await audit(tx, actor, 'UPDATE', 'book_price', bookId, { branchId, price }, branchId);
  });
}
