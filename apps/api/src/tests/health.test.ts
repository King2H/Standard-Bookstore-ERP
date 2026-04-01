import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';

describe('GET /api/health', () => {
  it('returns 200 with status ok when DB is reachable', async () => {
    const app = getTestApp();
    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.db).toBe('ok');
    expect(res.body.timestamp).toBeDefined();
  });

  it('returns JSON content-type', async () => {
    const app = getTestApp();
    const res = await request(app).get('/api/health');

    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});
