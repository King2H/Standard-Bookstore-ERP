import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';

describe('API versioning', () => {
  it('serves routes under /api/v1 without deprecation headers', async () => {
    const res = await request(getTestApp()).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.headers.deprecation).toBeUndefined();
  });

  it('keeps /api as a deprecated alias pointing to /api/v1', async () => {
    const res = await request(getTestApp()).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.headers.deprecation).toBe('@1791072000');
    expect(res.headers.link).toBe('</api/v1/health>; rel="successor-version"');
  });

  it('serves mounted sub-routers under both prefixes', async () => {
    const v1 = await request(getTestApp()).get('/api/v1/notifications');
    const alias = await request(getTestApp()).get('/api/notifications');
    expect(v1.status).toBe(401);
    expect(alias.status).toBe(401);
  });

  it('returns a plain 404 for unknown /api/v1 routes, without alias headers', async () => {
    const res = await request(getTestApp()).get('/api/v1/no-such-route');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
    expect(res.headers.deprecation).toBeUndefined();
  });

  it('applies the CSRF login exemption under /api/v1 as well', async () => {
    const res = await request(getTestApp())
      .post('/api/v1/auth/pre-login')
      .set('Cookie', 'csrf-token=some-token')
      .send({ username: 'nobody', password: 'Wrong-password-1!' });
    expect(res.body.error).not.toBe('CSRF_INVALID');
  });
});
