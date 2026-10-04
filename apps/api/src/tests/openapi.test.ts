import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import request from 'supertest';
import { z } from 'zod';
import { buildOpenApiDocument } from '../openapi/document.js';
import { OPENAPI_PATH, serializeOpenApi } from '../openapi/write.js';
import { getTestApp } from './helpers/testApp.js';

describe('OpenAPI document', () => {
  it('docs/api/openapi.json is up to date (run `npm run openapi` to refresh it)', () => {
    expect(readFileSync(OPENAPI_PATH, 'utf8')).toBe(serializeOpenApi());
  });

  it('is served at /api/v1/openapi.json', async () => {
    const res = await request(getTestApp()).get('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(JSON.parse(serializeOpenApi()));
  });

  it('describes requests and responses from the shared zod schemas', () => {
    const doc = buildOpenApiDocument([
      {
        operationId: 'createItem',
        method: 'post',
        path: '/items/{id}',
        summary: 'Example',
        tag: 'Example',
        request: {
          params: z.object({ id: z.coerce.number().int() }),
          query: z.object({ dryRun: z.coerce.boolean().optional() }),
          body: z.object({ name: z.string() }),
        },
        responses: { 201: { description: 'Created', schema: z.object({ id: z.number() }) } },
        errors: [400, 401, 422],
      },
    ]);

    const op = doc.paths['/items/{id}'].post as {
      parameters: { name: string; in: string; required: boolean }[];
      requestBody: unknown;
      responses: Record<string, { content?: { 'application/json': { schema: unknown } } }>;
    };
    expect(doc.openapi).toBe('3.1.0');
    expect(op.parameters).toEqual([
      expect.objectContaining({ name: 'id', in: 'path', required: true }),
      expect.objectContaining({ name: 'dryRun', in: 'query', required: false }),
    ]);
    expect(op.requestBody).toBeDefined();
    expect(Object.keys(op.responses).sort()).toEqual(['201', '400', '401', '422']);
    expect(op.responses['422'].content?.['application/json'].schema).toEqual({ $ref: '#/components/schemas/ErrorResponse' });
  });

  it('matches what the health endpoint actually returns', async () => {
    const res = await request(getTestApp()).get('/api/v1/health');
    const schema = buildOpenApiDocument().paths['/health'].get as {
      responses: Record<string, { content: { 'application/json': { schema: { required: string[] } } } }>;
    };
    expect(Object.keys(res.body).sort()).toEqual(schema.responses['200'].content['application/json'].schema.required.sort());
  });
});
