import type { z } from 'zod';
import {
  BookIdParamsSchema,
  BookSupplierListResponseSchema,
  BookSupplierParamsSchema,
  CreateSupplierRequestSchema,
  HealthResponseSchema,
  IdParamsSchema,
  LinkBookSupplierRequestSchema,
  MessageResponseSchema,
  SupplierListQuerySchema,
  SupplierListResponseSchema,
  SupplierSchema,
  SupplierUsageSchema,
  UpdateSupplierRequestSchema,
} from '@bms/shared';

/**
 * One documented API operation. Each module adds its operations here when it
 * moves to shared contracts (Suppliers in #19, the rest in M5), using the same
 * schemas its routes pass to validate().
 */
export interface ApiOperation {
  /** Unique name for generated clients, e.g. listSuppliers. */
  operationId: string;
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  /** Path below /api/v1, with OpenAPI-style parameters: /branches/{id}. */
  path: string;
  summary: string;
  tag: string;
  /** False for public endpoints; everything else needs a bearer token. */
  auth?: boolean;
  request?: {
    params?: z.ZodObject;
    query?: z.ZodObject;
    body?: z.ZodType;
  };
  /** Success responses by status code. */
  responses: Record<number, { description: string; schema?: z.ZodType }>;
  /**
   * Error statuses the operation can return, all with the shared error envelope.
   * Default: 400, 401, 403 and 500 for authenticated operations; 500 for public ones.
   */
  errors?: number[];
}

export const operations: ApiOperation[] = [
  {
    operationId: 'getHealth',
    method: 'get',
    path: '/health',
    summary: 'Service and database health',
    tag: 'System',
    auth: false,
    responses: {
      200: { description: 'The API and its database are available', schema: HealthResponseSchema },
      503: { description: 'The database is unavailable', schema: HealthResponseSchema },
    },
  },
  ...supplierOperations(),
];

function supplierOperations(): ApiOperation[] {
  const tag = 'Suppliers';
  const byId = { params: IdParamsSchema };
  const action = (operationId: string, verb: string, summary: string, errors: number[]): ApiOperation => ({
    operationId,
    method: 'post',
    path: `/suppliers/{id}/${verb}`,
    summary,
    tag,
    request: byId,
    responses: { 200: { description: 'Done', schema: MessageResponseSchema } },
    errors,
  });
  return [
    {
      operationId: 'listSuppliers',
      method: 'get',
      path: '/suppliers',
      summary: 'List suppliers (active only when ?status=active; ?status=all for every status)',
      tag,
      request: { query: SupplierListQuerySchema },
      responses: { 200: { description: 'One page of suppliers, by name', schema: SupplierListResponseSchema } },
    },
    {
      operationId: 'createSupplier',
      method: 'post',
      path: '/suppliers',
      summary: 'Create a supplier',
      tag,
      request: { body: CreateSupplierRequestSchema },
      responses: { 201: { description: 'The new supplier', schema: SupplierSchema } },
      errors: [400, 401, 403, 409, 422, 500],
    },
    {
      operationId: 'getSupplier',
      method: 'get',
      path: '/suppliers/{id}',
      summary: 'Get a supplier',
      tag,
      request: byId,
      responses: { 200: { description: 'The supplier', schema: SupplierSchema } },
      errors: [400, 401, 403, 404, 500],
    },
    {
      operationId: 'updateSupplier',
      method: 'put',
      path: '/suppliers/{id}',
      summary: 'Change some of a supplier\'s fields',
      tag,
      request: { params: IdParamsSchema, body: UpdateSupplierRequestSchema },
      responses: { 200: { description: 'The updated supplier', schema: SupplierSchema } },
      errors: [400, 401, 403, 404, 409, 422, 500],
    },
    {
      operationId: 'deleteSupplier',
      method: 'delete',
      path: '/suppliers/{id}',
      summary: 'Delete a supplier that has no purchase orders (Admin, Manager)',
      tag,
      request: byId,
      responses: { 200: { description: 'Deleted', schema: MessageResponseSchema } },
      errors: [400, 401, 403, 404, 409, 500],
    },
    action('deactivateSupplier', 'deactivate', 'Set a supplier to INACTIVE', [400, 401, 403, 404, 500]),
    action('activateSupplier', 'activate', 'Set a supplier to ACTIVE', [400, 401, 403, 404, 500]),
    action('archiveSupplier', 'archive', 'Archive a supplier', [400, 401, 403, 404, 500]),
    action('restoreSupplier', 'restore', 'Restore an archived supplier to ACTIVE', [400, 401, 403, 404, 500]),
    action('blacklistSupplier', 'blacklist', 'Blacklist a supplier (Admin, Manager)', [400, 401, 403, 404, 500]),
    {
      operationId: 'getSupplierUsage',
      method: 'get',
      path: '/suppliers/{id}/usage',
      summary: 'Count the records that keep a supplier from being deleted',
      tag,
      request: byId,
      responses: { 200: { description: 'Counts by record type', schema: SupplierUsageSchema } },
      errors: [400, 401, 403, 404, 500],
    },
    {
      operationId: 'listBookSuppliers',
      method: 'get',
      path: '/books/{bookId}/suppliers',
      summary: 'List a book\'s suppliers, primary first',
      tag,
      request: { params: BookIdParamsSchema },
      responses: { 200: { description: 'The book\'s suppliers', schema: BookSupplierListResponseSchema } },
      errors: [400, 401, 500],
    },
    {
      operationId: 'linkBookSupplier',
      method: 'post',
      path: '/books/{bookId}/suppliers',
      summary: 'Link a supplier to a book, or update the link (Admin, Manager)',
      tag,
      request: { params: BookIdParamsSchema, body: LinkBookSupplierRequestSchema },
      responses: { 201: { description: 'Linked', schema: MessageResponseSchema } },
    },
    {
      operationId: 'unlinkBookSupplier',
      method: 'delete',
      path: '/books/{bookId}/suppliers/{supplierId}',
      summary: 'Remove a supplier from a book (Admin, Manager)',
      tag,
      request: { params: BookSupplierParamsSchema },
      responses: { 200: { description: 'Unlinked', schema: MessageResponseSchema } },
    },
  ];
}
