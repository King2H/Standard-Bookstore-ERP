import type { Request, Response } from 'express';
import {
  AuthorListQuerySchema,
  CategoryListQuerySchema,
  CreateCategoryRequestSchema,
  IdParamsSchema,
  PublisherListQuerySchema,
  ReferenceNameRequestSchema,
  UpdateCategoryRequestSchema,
  type Author,
  type AuthorListResponse,
  type BookLookupListResponse,
  type Category,
  type CategoryListResponse,
  type MessageResponse,
  type Publisher,
  type PublisherListResponse,
  type ReferenceListQuery,
  type ReferenceUsage,
} from '@bms/shared';
import { valid } from '../../middleware/validate.js';
import {
  toAuthorResponse,
  toCategoryResponse,
  toLookupResponse,
  toPublisherResponse,
} from './catalogReference.mapper.js';
import * as policy from './catalogReference.policy.js';
import * as service from './catalogReference.service.js';
import type { Actor, LifecycleAction, ReferenceKind } from './catalogReference.types.js';

/**
 * HTTP side of the catalog's reference data (A3): validated request ->
 * service -> response. The schemas are the ones the routes pass to validate().
 */

export const schemas = {
  listAuthors: { query: AuthorListQuerySchema },
  listCategories: { query: CategoryListQuerySchema },
  listPublishers: { query: PublisherListQuerySchema },
  byId: { params: IdParamsSchema },
  createName: { body: ReferenceNameRequestSchema },
  updateName: { params: IdParamsSchema, body: ReferenceNameRequestSchema },
  createCategory: { body: CreateCategoryRequestSchema },
  updateCategory: { params: IdParamsSchema, body: UpdateCategoryRequestSchema },
};

/** The signed-in staff member; authenticate() runs before every controller. */
function actor(req: Request): Actor {
  const { staffId, role, branchId } = req.staff!;
  return { staffId, role, branchId };
}

function filterOf(query: ReferenceListQuery) {
  return {
    filter: { q: query.q?.trim() || undefined, statuses: policy.statusesFor(query.status) },
    paging: { page: query.page, pageSize: query.pageSize },
  };
}

function message(res: Response, text: string): void {
  const body: MessageResponse = { message: text };
  res.json(body);
}

// ── Lists ─────────────────────────────────────────────────────────────────────

export async function listAuthors(req: Request, res: Response): Promise<void> {
  const { filter, paging } = filterOf(valid(req, schemas.listAuthors).query);
  const result = await service.listAuthors(filter, paging);
  const body: AuthorListResponse = { total: result.total, items: result.items.map(toAuthorResponse) };
  res.json(body);
}

export async function listCategories(req: Request, res: Response): Promise<void> {
  const { filter, paging } = filterOf(valid(req, schemas.listCategories).query);
  const result = await service.listCategories(filter, paging);
  const body: CategoryListResponse = { total: result.total, items: result.items.map(toCategoryResponse) };
  res.json(body);
}

export async function listPublishers(req: Request, res: Response): Promise<void> {
  const { filter, paging } = filterOf(valid(req, schemas.listPublishers).query);
  const result = await service.listPublishers(filter, paging);
  const body: PublisherListResponse = { total: result.total, items: result.items.map(toPublisherResponse) };
  res.json(body);
}

export async function listBookFormats(_req: Request, res: Response): Promise<void> {
  const body: BookLookupListResponse = { items: (await service.listBookFormats()).map(toLookupResponse) };
  res.json(body);
}

export async function listBookEditions(_req: Request, res: Response): Promise<void> {
  const body: BookLookupListResponse = { items: (await service.listBookEditions()).map(toLookupResponse) };
  res.json(body);
}

// ── Create and update ─────────────────────────────────────────────────────────

export async function createAuthor(req: Request, res: Response): Promise<void> {
  const body: Author = toAuthorResponse(await service.createAuthor(actor(req), valid(req, schemas.createName).body.name));
  res.status(201).json(body);
}

export async function updateAuthor(req: Request, res: Response): Promise<void> {
  const { params, body: change } = valid(req, schemas.updateName);
  const body: Author = toAuthorResponse(await service.updateAuthor(actor(req), params.id, change.name));
  res.json(body);
}

export async function createCategory(req: Request, res: Response): Promise<void> {
  const body: Category = toCategoryResponse(await service.createCategory(actor(req), valid(req, schemas.createCategory).body));
  res.status(201).json(body);
}

export async function updateCategory(req: Request, res: Response): Promise<void> {
  const { params, body: change } = valid(req, schemas.updateCategory);
  const body: Category = toCategoryResponse(await service.updateCategory(actor(req), params.id, change));
  res.json(body);
}

export async function createPublisher(req: Request, res: Response): Promise<void> {
  const body: Publisher = toPublisherResponse(await service.createPublisher(actor(req), valid(req, schemas.createName).body.name));
  res.status(201).json(body);
}

export async function updatePublisher(req: Request, res: Response): Promise<void> {
  const { params, body: change } = valid(req, schemas.updateName);
  const body: Publisher = toPublisherResponse(await service.updatePublisher(actor(req), params.id, change.name));
  res.json(body);
}

// ── Usage, delete and lifecycle, for each kind ────────────────────────────────

const LABEL: Record<ReferenceKind, string> = { author: 'Author', category: 'Category', publisher: 'Publisher' };

const DONE: Record<LifecycleAction, string> = {
  ARCHIVE: 'archived',
  RESTORE: 'restored',
  INACTIVATE: 'set inactive',
  ACTIVATE: 'activated',
};

export function usage(kind: ReferenceKind) {
  return async (req: Request, res: Response): Promise<void> => {
    const body: ReferenceUsage = await service.usage(kind, valid(req, schemas.byId).params.id);
    res.json(body);
  };
}

export function remove(kind: ReferenceKind) {
  return async (req: Request, res: Response): Promise<void> => {
    await service.remove(actor(req), kind, valid(req, schemas.byId).params.id);
    message(res, `${LABEL[kind]} deleted`);
  };
}

export function transition(kind: ReferenceKind, action: LifecycleAction) {
  return async (req: Request, res: Response): Promise<void> => {
    await service.transition(actor(req), kind, valid(req, schemas.byId).params.id, action);
    message(res, `${LABEL[kind]} ${DONE[action]}`);
  };
}
