import type { CreateCategoryRequest, UpdateCategoryRequest } from '@bms/shared';
import { kysely } from '../../db/kysely.js';
import { isUniqueViolation } from '../../db/errors.js';
import { withTransaction, type Queryable } from '../../db/tx.js';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { insertAuditEntry } from '../audit/audit.repository.js';
import * as policy from './catalogReference.policy.js';
import * as refs from './catalogReference.repository.js';
import type {
  Actor,
  AuthorRecord,
  CategoryRecord,
  LifecycleAction,
  LookupRecord,
  Paging,
  PublisherRecord,
  ReferenceFilter,
  ReferenceKind,
} from './catalogReference.types.js';

/**
 * Use cases of the catalog's reference data (A4): authors, categories and
 * publishers, which books link to, and the fixed lists of book formats and
 * editions. One function each, owning its transaction.
 */

const LABEL: Record<ReferenceKind, string> = { author: 'Author', category: 'Category', publisher: 'Publisher' };
const CODE: Record<ReferenceKind, string> = { author: 'AUTHOR', category: 'CATEGORY', publisher: 'PUBLISHER' };

function window(paging: Paging) {
  return { limit: paging.pageSize, offset: (paging.page - 1) * paging.pageSize };
}

function audit(q: Queryable, actor: Actor, action: string, kind: ReferenceKind, id: number, meta: Record<string, unknown>) {
  return insertAuditEntry(q, {
    staffId: actor.staffId,
    staffRole: actor.role,
    branchId: actor.branchId,
    action,
    entityType: kind,
    entityId: id,
    meta,
  });
}

function duplicate(kind: ReferenceKind, name: string | undefined) {
  return (err: unknown): never => {
    if (isUniqueViolation(err)) throw new ConflictError(`DUPLICATE_${CODE[kind]}`, `${LABEL[kind]} '${name}' already exists`);
    throw err;
  };
}

function found<T>(kind: ReferenceKind, record: T | undefined): T {
  if (record === undefined) throw new NotFoundError(LABEL[kind]);
  return record;
}

// ── Lists ─────────────────────────────────────────────────────────────────────

export function listAuthors(filter: ReferenceFilter, paging: Paging): Promise<{ items: AuthorRecord[]; total: number }> {
  return refs.listAuthors(kysely, filter, window(paging));
}

export function listCategories(filter: ReferenceFilter, paging: Paging): Promise<{ items: CategoryRecord[]; total: number }> {
  return refs.listCategories(kysely, filter, window(paging));
}

export function listPublishers(filter: ReferenceFilter, paging: Paging): Promise<{ items: PublisherRecord[]; total: number }> {
  return refs.listPublishers(kysely, filter, window(paging));
}

export function listBookFormats(): Promise<LookupRecord[]> {
  return refs.lookups(kysely, 'book_formats');
}

export function listBookEditions(): Promise<LookupRecord[]> {
  return refs.lookups(kysely, 'book_editions');
}

// ── Authors ───────────────────────────────────────────────────────────────────

export async function createAuthor(actor: Actor, name: string): Promise<AuthorRecord> {
  return withTransaction({}, async (tx) => {
    const author = await refs.insertAuthor(tx, name, policy.normalizeName(name)).catch(duplicate('author', name));
    await audit(tx, actor, 'CREATE', 'author', author.id, { name });
    return author;
  });
}

export async function updateAuthor(actor: Actor, id: number, name: string): Promise<AuthorRecord> {
  return withTransaction({}, async (tx) => {
    const author = await refs
      .updateAuthor(tx, id, { name, normalizedName: policy.normalizeName(name), updatedBy: actor.staffId })
      .catch(duplicate('author', name));
    found('author', author);
    await audit(tx, actor, 'UPDATE', 'author', id, { name });
    return author!;
  });
}

// ── Categories ────────────────────────────────────────────────────────────────

/** The parent must exist and must not be the category itself or below it. */
async function checkParent(q: Queryable, categoryId: number | undefined, parentId: number | null | undefined): Promise<void> {
  if (parentId === null || parentId === undefined) return;
  const chain = await refs.categoryChain(q, parentId);
  if (chain.length === 0) throw new NotFoundError('Parent category');
  if (categoryId !== undefined) policy.checkCategoryParent(categoryId, chain);
}

export async function createCategory(actor: Actor, data: CreateCategoryRequest): Promise<CategoryRecord> {
  return withTransaction({}, async (tx) => {
    await checkParent(tx, undefined, data.parentId);
    const category = await refs
      .insertCategory(tx, { name: data.name, normalizedName: policy.normalizeName(data.name), parentId: data.parentId ?? null })
      .catch(duplicate('category', data.name));
    await audit(tx, actor, 'CREATE', 'category', category.id, { ...data });
    return category;
  });
}

export async function updateCategory(actor: Actor, id: number, data: UpdateCategoryRequest): Promise<CategoryRecord> {
  if (data.name === undefined && data.parentId === undefined) throw new ValidationError('Nothing to update');
  return withTransaction({}, async (tx) => {
    found('category', await refs.lockStatus(tx, 'category', id));
    await checkParent(tx, id, data.parentId);
    const category = await refs
      .updateCategory(tx, id, {
        name: data.name,
        normalizedName: data.name === undefined ? undefined : policy.normalizeName(data.name),
        parentId: data.parentId,
        updatedBy: actor.staffId,
      })
      .catch(duplicate('category', data.name));
    await audit(tx, actor, 'UPDATE', 'category', id, { ...data });
    return found('category', category);
  });
}

// ── Publishers ────────────────────────────────────────────────────────────────

export async function createPublisher(actor: Actor, name: string): Promise<PublisherRecord> {
  return withTransaction({}, async (tx) => {
    const publisher = await refs.insertPublisher(tx, name).catch(duplicate('publisher', name));
    await audit(tx, actor, 'CREATE', 'publisher', publisher.id, { name });
    return publisher;
  });
}

export async function updatePublisher(actor: Actor, id: number, name: string): Promise<PublisherRecord> {
  return withTransaction({}, async (tx) => {
    const publisher = await refs.updatePublisher(tx, id, { name, updatedBy: actor.staffId }).catch(duplicate('publisher', name));
    found('publisher', publisher);
    await audit(tx, actor, 'UPDATE', 'publisher', id, { name });
    return publisher!;
  });
}

// ── Any kind: usage, delete, lifecycle ────────────────────────────────────────

export async function usage(kind: ReferenceKind, id: number): Promise<Record<string, number>> {
  return { books: found(kind, await refs.bookUsage(kysely, kind, id)) };
}

/** Only a record no book uses may be deleted; archive the others. */
export async function remove(actor: Actor, kind: ReferenceKind, id: number): Promise<void> {
  await withTransaction({}, async (tx) => {
    found(kind, await refs.lockStatus(tx, kind, id));
    const books = found(kind, await refs.bookUsage(tx, kind, id));
    if (books > 0) {
      throw new ConflictError(`${CODE[kind]}_IN_USE`, `${LABEL[kind]} is linked to one or more books`, { books });
    }
    await refs.remove(tx, kind, id);
    await audit(tx, actor, 'DELETE', kind, id, {});
  });
}

/** A repeat of the current status changes nothing and is not audited. */
export async function transition(actor: Actor, kind: ReferenceKind, id: number, action: LifecycleAction): Promise<void> {
  await withTransaction({}, async (tx) => {
    const previousStatus = found(kind, await refs.lockStatus(tx, kind, id));
    const newStatus = policy.nextStatus(previousStatus, action);
    if (newStatus === null) return;
    await refs.setStatus(tx, kind, id, newStatus, actor.staffId);
    await audit(tx, actor, action, kind, id, { previousStatus, newStatus });
  });
}
