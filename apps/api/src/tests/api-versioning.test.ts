import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';

describe('API versioning', () => {
  it('serves routes under /api/v1', async () => {
    const res = await request(getTestApp()).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.headers.deprecation).toBeUndefined();
  });

  it('serves mounted sub-routers under /api/v1', async () => {
    const res = await request(getTestApp()).get('/api/v1/notifications');
    expect(res.status).toBe(401);
  });

  // M6, #23: the web app calls /api/v1 since step 2, so the alias is gone.
  // An old address says where the route moved (was: served as an alias).
  it('answers an unversioned /api address with 410 and the address to use instead', async () => {
    const res = await request(getTestApp()).get('/api/health?verbose=1');
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('DEPRECATED');
    expect(res.body.message).toBe('This API address moved to /api/v1/health. Reload the page.');
    expect(res.headers.link).toBe('</api/v1/health?verbose=1>; rel="successor-version"');
  });

  it('answers 410 before the CSRF check, so a stale page is told what changed', async () => {
    const res = await request(getTestApp())
      .post('/api/notifications/read-all')
      .set('Cookie', 'csrf-token=some-token');
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('DEPRECATED');
  });

  it('returns a plain 404 for unknown /api/v1 routes', async () => {
    const res = await request(getTestApp()).get('/api/v1/no-such-route');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
    expect(res.headers.link).toBeUndefined();
  });

  it('applies the CSRF sign-in exemption under /api/v1', async () => {
    const res = await request(getTestApp())
      .post('/api/v1/auth/pre-login')
      .set('Cookie', 'csrf-token=some-token')
      .send({ username: 'nobody', password: 'Wrong-password-1!' });
    expect(res.body.error).not.toBe('CSRF_INVALID');
  });
});
