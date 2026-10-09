import type { Request, Response } from 'express';
import {
  BookBranchParamsSchema,
  BookListQuerySchema,
  BranchPriceRequestSchema,
  CatalogSearchQuerySchema,
  CreateBookRequestSchema,
  IdParamsSchema,
  ListPagingQuerySchema,
  QuickRegisterBookRequestSchema,
  SuggestQuerySchema,
  UpdateBookRequestSchema,
  type Book,
  type BookAvailabilityListResponse,
  type BookEditListResponse,
  type BookListQuery,
  type BookListResponse,
  type BookPriceListResponse,
  type BookUsage,
  type CatalogSearchResponse,
  type MessageResponse,
  type SuggestResponse,
} from '@bms/shared';
import { valid } from '../../middleware/validate.js';
import type { LifecycleAction } from '../catalogReference/catalogReference.types.js';
import { toBookEditResponse, toBookResponse } from './catalog.mapper.js';
import * as policy from './catalog.policy.js';
import * as service from './catalog.service.js';
import type { Actor, BookFilter } from './catalog.types.js';

/**
 * HTTP side of the book catalog (A3): validated request -> service ->
 * response. The schemas are the ones the routes pass to validate().
 */

export const schemas = {
  list: { query: BookListQuerySchema },
  search: { query: CatalogSearchQuerySchema },
  byId: { params: IdParamsSchema },
  get: { params: IdParamsSchema, query: BookListQuerySchema.pick({ branchId: true }) },
  create: { body: CreateBookRequestSchema },
  quickRegister: { body: QuickRegisterBookRequestSchema },
  update: { params: IdParamsSchema, body: UpdateBookRequestSchema },
  history: { params: IdParamsSchema, query: ListPagingQuerySchema },
  price: { params: BookBranchParamsSchema, body: BranchPriceRequestSchema },
  suggest: { query: SuggestQuerySchema },
};

/** The signed-in staff member; authenticate() runs before every controller. */
function actor(req: Request): Actor {
  const { staffId, role, branchId } = req.staff!;
  return { staffId, role, branchId };
}

function message(res: Response, text: string): void {
  const body: MessageResponse = { message: text };
  res.json(body);
}

function filterOf(query: BookListQuery): BookFilter {
  return {
    q: query.q?.trim() || undefined,
    qIsbns: query.q ? policy.isbnSearchForms(query.q) : undefined,
    isbns: query.isbn ? policy.isbnSearchForms(query.isbn) : undefined,
    sku: query.sku,
    author: query.author,
    genre: query.genre,
    category: query.category,
    tag: query.tag,
    isActive: policy.isActiveFilter(query.is_active),
    statuses: query.status === undefined ? undefined : policy.statusesFor(query.status),
    sortBy: query.sortBy,
    sortDir: query.sortDir,
  };
}

// Not branch-scoped (#12): staff may look up another branch's price and stock.
function priceBranch(req: Request, requested: number | undefined): number {
  return requested ?? req.staff!.branchId;
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export async function list(req: Request, res: Response): Promise<void> {
  const { query } = valid(req, schemas.list);
  const result = await service.listBooks(filterOf(query), priceBranch(req, query.branchId), {
    page: query.page,
    pageSize: query.pageSize,
  });
  const body: BookListResponse = { ...result, items: result.items.map(toBookResponse) };
  res.json(body);
}

export async function listWithAvailability(req: Request, res: Response): Promise<void> {
  const { query } = valid(req, schemas.list);
  const result = await service.listBooksWithAvailability(filterOf(query), priceBranch(req, query.branchId), query.locationId, {
    page: query.page,
    pageSize: query.pageSize,
  });
  const body: BookAvailabilityListResponse = {
    ...result,
    items: result.items.map(({ book, availability }) => ({ ...toBookResponse(book), availability })),
  };
  res.json(body);
}

export async function search(req: Request, res: Response): Promise<void> {
  const { query } = valid(req, schemas.search);
  const results = await service.searchCatalog(query.q, priceBranch(req, query.branchId), query.limit);
  const body: CatalogSearchResponse = { results: results.map(toBookResponse), total: results.length };
  res.json(body);
}

export async function get(req: Request, res: Response): Promise<void> {
  const { params, query } = valid(req, schemas.get);
  const body: Book = toBookResponse(await service.getBook(params.id, priceBranch(req, query.branchId)));
  res.json(body);
}

export async function usage(req: Request, res: Response): Promise<void> {
  const body: BookUsage = await service.usage(valid(req, schemas.byId).params.id);
  res.json(body);
}

export async function history(req: Request, res: Response): Promise<void> {
  const { params, query } = valid(req, schemas.history);
  const result = await service.editHistory(params.id, { page: query.page, pageSize: query.pageSize });
  const body: BookEditListResponse = { total: result.total, items: result.items.map(toBookEditResponse) };
  res.json(body);
}

export async function prices(req: Request, res: Response): Promise<void> {
  const items = await service.branchPrices(valid(req, schemas.byId).params.id);
  const body: BookPriceListResponse = { items: items.map((p) => ({ ...p, price: p.price.toNumber() })) };
  res.json(body);
}

export async function suggestAuthors(req: Request, res: Response): Promise<void> {
  const body: SuggestResponse = { items: await service.suggestAuthors(valid(req, schemas.suggest).query.q ?? '') };
  res.json(body);
}

export async function suggestCategories(req: Request, res: Response): Promise<void> {
  const body: SuggestResponse = { items: await service.suggestCategories(valid(req, schemas.suggest).query.q ?? '') };
  res.json(body);
}

// ── Changes ───────────────────────────────────────────────────────────────────

export async function create(req: Request, res: Response): Promise<void> {
  const body: Book = toBookResponse(await service.createBook(actor(req), valid(req, schemas.create).body));
  res.status(201).json(body);
}

export async function quickRegister(req: Request, res: Response): Promise<void> {
  const body: Book = toBookResponse(await service.quickRegister(actor(req), valid(req, schemas.quickRegister).body));
  res.status(201).json(body);
}

export async function update(req: Request, res: Response): Promise<void> {
  const { params, body: change } = valid(req, schemas.update);
  const body: Book = toBookResponse(await service.updateBook(actor(req), params.id, change));
  res.json(body);
}

export async function remove(req: Request, res: Response): Promise<void> {
  await service.remove(actor(req), valid(req, schemas.byId).params.id);
  message(res, 'Book deleted');
}

export async function setPrice(req: Request, res: Response): Promise<void> {
  const { params, body } = valid(req, schemas.price);
  await service.setBranchPrice(actor(req), params.id, params.branchId, body.price);
  message(res, 'Branch price updated');
}

const DONE: Record<LifecycleAction, string> = {
  INACTIVATE: 'Book deactivated',
  ACTIVATE: 'Book reactivated',
  ARCHIVE: 'Book archived',
  RESTORE: 'Book restored',
};

export function transition(action: LifecycleAction) {
  return async (req: Request, res: Response): Promise<void> => {
    await service.transition(actor(req), valid(req, schemas.byId).params.id, action);
    message(res, DONE[action]);
  };
}
