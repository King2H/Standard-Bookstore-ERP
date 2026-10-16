import type { z } from 'zod';
import type {
  Author, AuthorListQuerySchema, AuthorListResponse, Category, CategoryListResponse, CreateCategoryRequest, MessageResponse,
  Publisher, PublisherListResponse, ReferenceNameRequest, UpdateCategoryRequest,
} from '@bms/shared';
import { api, toQuery } from '../../lib/api.js';

/** The catalog's reference data (#21): authors, categories and publishers, typed with their @bms/shared contracts. */

/** Each kind is served at `/{kind}`. */
export type ReferenceKind = 'authors' | 'categories' | 'publishers';

export interface ReferenceRecord { authors: Author; categories: Category; publishers: Publisher }
interface ReferenceList { authors: AuthorListResponse; categories: CategoryListResponse; publishers: PublisherListResponse }
/** A name; a category also takes its parent (null for top level). */
export type ReferenceBody = ReferenceNameRequest | CreateCategoryRequest | UpdateCategoryRequest;

/** `GET /{kind}` filters, as they travel in the query string (the same for every kind). */
export type ReferenceListParams = Omit<z.input<typeof AuthorListQuerySchema>, 'page' | 'pageSize'> & {
  page?: number;
  pageSize?: number;
};

/** Lifecycle actions, each `POST /{kind}/{id}/{action}`. */
export type ReferenceAction = 'deactivate' | 'activate' | 'archive' | 'restore';

export const listReference = <K extends ReferenceKind>(kind: K, params: ReferenceListParams) =>
  api.get<ReferenceList[K]>(`/${kind}${toQuery(params)}`);

export const createReference = <K extends ReferenceKind>(kind: K, body: ReferenceBody) =>
  api.post<ReferenceRecord[K]>(`/${kind}`, body);

export const updateReference = <K extends ReferenceKind>(kind: K, id: number, body: ReferenceBody) =>
  api.put<ReferenceRecord[K]>(`/${kind}/${id}`, body);

export const runReferenceAction = (kind: ReferenceKind, id: number, action: ReferenceAction) =>
  api.post<MessageResponse>(`/${kind}/${id}/${action}`);

export const deleteReference = (kind: ReferenceKind, id: number) => api.delete<MessageResponse>(`/${kind}/${id}`);

/** Active publishers whose name starts with `q`, for a picker. */
export const searchPublishers = (q: string, pageSize = 20) => listReference('publishers', { q, pageSize });

/** Active categories whose name starts with `q`, for a picker. */
export const searchCategories = (q: string, pageSize = 20) => listReference('categories', { q, pageSize });
