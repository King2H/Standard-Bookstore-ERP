import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { HealthResponseSchema } from '@bms/shared';
import { getTestApp } from './helpers/testApp.js';

// #245 (owner decision 3a): one version, in the root package.json.
const RELEASE = (JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')) as { version: string }).version;

describe('GET /api/health', () => {
  it('returns 200 with status ok when DB is reachable', async () => {
    const app = getTestApp();
    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.db).toBe('ok');
    expect(res.body.timestamp).toBeDefined();
  });

  it('says which version of the bookstore answers, the one in the root package.json (#245, 3a)', async () => {
    const res = await request(getTestApp()).get('/api/v1/health');

    expect(RELEASE).toMatch(/^\d+\.\d+\.\d+$/);
    expect(res.body.version).toBe(RELEASE);
    expect(HealthResponseSchema.parse(res.body).version).toBe(RELEASE);
  });

  it('returns JSON content-type', async () => {
    const app = getTestApp();
    const res = await request(app).get('/api/v1/health');

    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});
