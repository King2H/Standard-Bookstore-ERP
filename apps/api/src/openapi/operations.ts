import type { z } from 'zod';
import {
  BranchConfigKeyParamsSchema,
  BranchConfigListResponseSchema,
  BranchConfigParamsSchema,
  ConfigEntrySchema,
  ConfigKeyParamsSchema,
  CurrencyResponseSchema,
  EffectiveConfigQuerySchema,
  EffectiveConfigResponseSchema,
  SetConfigValueRequestSchema,
  SystemConfigListResponseSchema,
  CancelOrderRequestSchema,
  CollectOrderPaymentRequestSchema,
  ConfirmOrderRequestSchema,
  CreateOrderRequestSchema,
  OrderListQuerySchema,
  OrderListResponseSchema,
  OrderSchema,
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
  ...configOperations(),
  ...supplierOperations(),
  ...orderOperations(),
];

function configOperations(): ApiOperation[] {
  const tag = 'Configuration';
  return [
    {
      operationId: 'listSystemConfig',
      method: 'get',
      path: '/config/system',
      summary: 'List the system settings (Super_Admin, Admin, Manager)',
      tag,
      responses: { 200: { description: 'Every system setting, by key', schema: SystemConfigListResponseSchema } },
      errors: [401, 403, 500],
    },
    {
      operationId: 'setSystemConfig',
      method: 'put',
      path: '/config/system/{key}',
      summary: 'Set a system setting (Super_Admin); the value must have the key\'s type',
      tag,
      request: { params: ConfigKeyParamsSchema, body: SetConfigValueRequestSchema },
      responses: { 200: { description: 'The saved setting', schema: ConfigEntrySchema } },
    },
    {
      operationId: 'getCurrency',
      method: 'get',
      path: '/config/currency',
      summary: 'The session branch\'s currency (ETB when it cannot be read)',
      tag,
      responses: { 200: { description: 'The currency code', schema: CurrencyResponseSchema } },
      errors: [401, 403, 500],
    },
    {
      operationId: 'getEffectiveConfig',
      method: 'get',
      path: '/config/effective',
      summary: 'The session branch\'s effective values for ?keys=a,b (null for a key set nowhere)',
      tag,
      request: { query: EffectiveConfigQuerySchema },
      responses: { 200: { description: 'One entry per requested key', schema: EffectiveConfigResponseSchema } },
    },
    {
      operationId: 'listBranchConfig',
      method: 'get',
      path: '/config/branches/{branchId}',
      summary: 'A branch\'s effective settings, each marked branch or system (Super_Admin, Admin, Manager)',
      tag,
      request: { params: BranchConfigParamsSchema },
      responses: { 200: { description: 'Every system key with its effective value', schema: BranchConfigListResponseSchema } },
    },
    {
      operationId: 'setBranchConfig',
      method: 'put',
      path: '/config/branches/{branchId}/{key}',
      summary: 'Override a setting for a branch (Super_Admin, Admin, Manager)',
      tag,
      request: { params: BranchConfigKeyParamsSchema, body: SetConfigValueRequestSchema },
      responses: { 200: { description: 'The saved override', schema: ConfigEntrySchema } },
      errors: [400, 401, 403, 404, 500],
    },
    {
      operationId: 'removeBranchConfig',
      method: 'delete',
      path: '/config/branches/{branchId}/{key}',
      summary: 'Remove a branch override, so the system default applies again (Super_Admin, Admin)',
      tag,
      request: { params: BranchConfigKeyParamsSchema },
      responses: { 200: { description: 'Removed', schema: MessageResponseSchema } },
      errors: [400, 401, 403, 404, 500],
    },
  ];
}

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

function orderOperations(): ApiOperation[] {
  const tag = 'Orders';
  const byId = { params: IdParamsSchema };
  const order = (description: string) => ({ 200: { description, schema: OrderSchema } });
  return [
    {
      operationId: 'listOrders',
      method: 'get',
      path: '/orders',
      summary: 'List the session branch\'s orders, newest first (?branchId= another branch needs access to all branches)',
      tag,
      request: { query: OrderListQuerySchema },
      responses: { 200: { description: 'One page of orders', schema: OrderListResponseSchema } },
    },
    {
      operationId: 'createOrder',
      method: 'post',
      path: '/orders',
      summary: 'Create a draft order (send an Idempotency-Key header to make retries safe)',
      tag,
      request: { body: CreateOrderRequestSchema },
      responses: {
        201: { description: 'The new draft order', schema: OrderSchema },
        200: { description: 'Replay of an earlier request with the same Idempotency-Key', schema: OrderSchema },
      },
      errors: [400, 401, 403, 404, 409, 422, 500],
    },
    {
      operationId: 'getOrder',
      method: 'get',
      path: '/orders/{id}',
      summary: 'Get an order with its lines',
      tag,
      request: byId,
      responses: order('The order'),
      errors: [400, 401, 403, 404, 500],
    },
    {
      operationId: 'deleteOrder',
      method: 'delete',
      path: '/orders/{id}',
      summary: 'Delete a draft or cancelled order without payment or stock history (Admin)',
      tag,
      request: byId,
      responses: { 200: { description: 'Deleted', schema: MessageResponseSchema } },
      errors: [400, 401, 403, 404, 422, 500],
    },
    {
      operationId: 'confirmOrder',
      method: 'post',
      path: '/orders/{id}/confirm',
      summary: 'Confirm a draft: takes the stock out, then records the cash payment or opens the receivable',
      tag,
      request: { params: IdParamsSchema, body: ConfirmOrderRequestSchema },
      responses: order('The confirmed order'),
      errors: [400, 401, 403, 404, 422, 500],
    },
    {
      operationId: 'fulfillOrder',
      method: 'post',
      path: '/orders/{id}/fulfill',
      summary: 'Hand over a confirmed order (it becomes COMPLETED)',
      tag,
      request: byId,
      responses: order('The completed order'),
      errors: [400, 401, 403, 404, 422, 500],
    },
    {
      operationId: 'cancelOrder',
      method: 'post',
      path: '/orders/{id}/cancel',
      summary: 'Cancel an unfulfilled order: restores stock and settles its receivable',
      tag,
      request: { params: IdParamsSchema, body: CancelOrderRequestSchema },
      responses: order('The cancelled order'),
      errors: [400, 401, 403, 404, 422, 500],
    },
    {
      operationId: 'collectOrderPayment',
      method: 'post',
      path: '/orders/{id}/collect-payment',
      summary: 'Collect a payment against a fulfilled credit order\'s receivable',
      tag,
      request: { params: IdParamsSchema, body: CollectOrderPaymentRequestSchema },
      responses: order('The order with its new payment status'),
      errors: [400, 401, 403, 404, 422, 500],
    },
    {
      operationId: 'progressOrder',
      method: 'post',
      path: '/orders/{id}/progress',
      summary: 'Legacy: move a pre-v1.1 Confirmed order to In_Progress (#69)',
      tag,
      request: byId,
      responses: order('The order'),
      errors: [400, 401, 403, 404, 422, 500],
    },
    {
      operationId: 'payOrder',
      method: 'post',
      path: '/orders/{id}/pay',
      summary: 'Retired: record payments with POST /payments',
      tag,
      request: byId,
      responses: {},
      errors: [401, 403, 404, 410],
    },
  ];
}
