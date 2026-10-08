import { z } from 'zod';
import { ErrorResponseSchema } from '@bms/shared';
import { operations as defaultOperations, type ApiOperation } from './operations.js';

type JsonSchema = Record<string, unknown>;

// zod emits JSON Schema 2020-12, the dialect OpenAPI 3.1 uses; the per-schema
// $schema key is dropped because the document declares the dialect once.
function toSchema(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  const json = z.toJSONSchema(schema, { io }) as JsonSchema;
  delete json.$schema;
  return json;
}

function parameters(where: 'path' | 'query', schema: z.ZodObject | undefined) {
  if (!schema) return [];
  const json = toSchema(schema, 'input') as { properties?: Record<string, JsonSchema>; required?: string[] };
  return Object.entries(json.properties ?? {}).map(([name, propSchema]) => ({
    name,
    in: where,
    required: where === 'path' || (json.required ?? []).includes(name),
    schema: propSchema,
  }));
}

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: 'Invalid request (`VALIDATION_ERROR`)',
  401: 'Not signed in or session expired',
  403: 'Not allowed',
  404: 'Not found',
  409: 'Conflicts with the current state of the data',
  422: 'A business rule forbids the request',
  429: 'Too many requests',
  500: 'Unexpected server error',
};

function operationObject(op: ApiOperation) {
  const responses: Record<string, unknown> = {};
  for (const [status, { description, schema }] of Object.entries(op.responses)) {
    responses[status] = schema
      ? { description, content: { 'application/json': { schema: toSchema(schema, 'output') } } }
      : { description };
  }
  const errors = op.errors ?? (op.auth === false ? [500] : [400, 401, 403, 500]);
  for (const status of errors) {
    responses[String(status)] ??= {
      description: ERROR_DESCRIPTIONS[status] ?? 'Error',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
    };
  }

  return {
    operationId: op.operationId,
    summary: op.summary,
    tags: [op.tag],
    ...(op.auth === false ? { security: [] } : {}),
    parameters: [...parameters('path', op.request?.params), ...parameters('query', op.request?.query)],
    ...(op.request?.body
      ? { requestBody: { required: true, content: { 'application/json': { schema: toSchema(op.request.body, 'input') } } } }
      : {}),
    responses,
  };
}

/**
 * The OpenAPI 3.1 description of /api/v1, generated from the shared zod
 * contracts (ADR-0004). docs/api/openapi.json is this document; a test fails
 * when the committed file is out of date (`npm run openapi` rewrites it).
 */
export function buildOpenApiDocument(operations: ApiOperation[] = defaultOperations) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of [...operations].sort((a, b) => a.path.localeCompare(b.path))) {
    (paths[op.path] ??= {})[op.method] = operationObject(op);
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Bookstore ERP API',
      version: 'v1',
      // Placeholder until the owner sets the final license terms.
      license: { name: 'Proprietary' },
      description:
        'Versioned HTTP API of the Bookstore ERP. Error codes are listed in docs/v2/api-errors.md. ' +
        'Endpoints are added here as each module moves to shared contracts.',
    },
    servers: [{ url: '/api/v1' }],
    security: [{ bearerAuth: [] }],
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      schemas: { ErrorResponse: toSchema(ErrorResponseSchema, 'output') },
    },
  };
}
