import type { z } from 'zod';
import { HealthResponseSchema } from '@bms/shared';

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
];
