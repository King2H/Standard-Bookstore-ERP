import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import { IdParamsSchema, PaginationQuerySchema, MoneyInputSchema, ErrorResponseSchema } from '@bms/shared';
import { validate, valid } from '../middleware/validate.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { getTestApp } from './helpers/testApp.js';

const schemas = {
  params: IdParamsSchema,
  query: PaginationQuerySchema,
  body: z.object({ name: z.string().min(1), price: MoneyInputSchema }),
};

function appWithRoute() {
  const app = express();
  app.use(express.json());
  app.post('/items/:id', validate(schemas), (req, res) => {
    const { params, query, body } = valid(req, schemas);
    res.json({ params, query, body });
  });
  app.use(errorHandler);
  return app;
}

describe('validate()', () => {
  it('passes parsed values with coercions and defaults to the handler', async () => {
    const res = await request(appWithRoute()).post('/items/12').send({ name: 'Fiction', price: '19.99' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      params: { id: 12 },
      query: { page: 1, pageSize: 25 },
      body: { name: 'Fiction', price: '19.99' },
    });
  });

  it('rejects with 400 VALIDATION_ERROR listing every issue by request part', async () => {
    const res = await request(appWithRoute())
      .post('/items/abc?pageSize=500')
      .send({ name: '', price: '1,000.00' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    const paths = (res.body.details.issues as { path: string[] }[]).map((i) => i.path.join('.'));
    expect(paths).toEqual(expect.arrayContaining(['params.id', 'query.pageSize', 'body.name', 'body.price']));
  });

  it('does not echo submitted values back in the issues', async () => {
    const res = await request(appWithRoute()).post('/items/1').send({ name: 'x', price: 'secret-value' });
    expect(JSON.stringify(res.body)).not.toContain('secret-value');
  });
});

describe('Error envelope', () => {
  it('unknown routes return the full envelope', async () => {
    const res = await request(getTestApp()).get('/api/no-such-route');

    expect(res.status).toBe(404);
    expect(ErrorResponseSchema.parse(res.body)).toMatchObject({ error: 'NOT_FOUND', details: {} });
    expect(res.body.requestId).toBeTruthy();
  });

  it('middleware rejections use the full envelope too (CSRF)', async () => {
    const res = await request(getTestApp())
      .post('/api/branches')
      .set('Cookie', 'csrf-token=expected')
      .set('X-CSRF-Token', 'wrong')
      .send({});

    expect(res.status).toBe(403);
    expect(ErrorResponseSchema.parse(res.body)).toMatchObject({ error: 'CSRF_INVALID' });
  });

  it('application errors match the shared schema', async () => {
    const res = await request(getTestApp()).get('/api/branches');
    expect(res.status).toBe(401);
    expect(() => ErrorResponseSchema.parse(res.body)).not.toThrow();
  });
});
