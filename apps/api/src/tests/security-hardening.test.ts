import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { createApp } from '../app.js';

// createApp reads FRONTEND_URL, NODE_ENV and TRUST_PROXY when it is called,
// so each test builds its own app with the environment it needs.
const saved = {
  NODE_ENV: process.env.NODE_ENV,
  FRONTEND_URL: process.env.FRONTEND_URL,
  TRUST_PROXY: process.env.TRUST_PROXY,
};

function withEnv(vars: Partial<Record<keyof typeof saved, string | undefined>>) {
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return createApp();
}

afterEach(() => {
  withEnv(saved);
});

describe('CORS', () => {
  it('in production without FRONTEND_URL, does not allow any cross-origin caller', async () => {
    const app = withEnv({ NODE_ENV: 'production', FRONTEND_URL: undefined });
    const res = await request(app).get('/api/health').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('in production, allows only the origins listed in FRONTEND_URL', async () => {
    const app = withEnv({ NODE_ENV: 'production', FRONTEND_URL: 'https://shop.example, https://admin.example/' });

    const allowed = await request(app).get('/api/health').set('Origin', 'https://admin.example');
    expect(allowed.headers['access-control-allow-origin']).toBe('https://admin.example');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');

    const denied = await request(app).get('/api/health').set('Origin', 'https://evil.example');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers a preflight from a disallowed origin without CORS headers', async () => {
    const app = withEnv({ NODE_ENV: 'production', FRONTEND_URL: 'https://shop.example' });
    const res = await request(app).options('/api/auth/login').set('Origin', 'https://evil.example');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('in development without FRONTEND_URL, allows any origin', async () => {
    const app = withEnv({ NODE_ENV: 'development', FRONTEND_URL: undefined });
    const res = await request(app).get('/api/health').set('Origin', 'http://localhost:5174');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5174');
  });
});

describe('Security headers', () => {
  it('sets helmet headers and hides the framework', async () => {
    const res = await request(withEnv({})).get('/api/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('Login rate limiter and X-Forwarded-For', () => {
  const attempt = (app: ReturnType<typeof createApp>, username: string, forwardedFor: string) =>
    request(app)
      .post('/api/auth/pre-login')
      .set('X-Forwarded-For', forwardedFor)
      .send({ username, password: 'Wrong-password-1!' });

  it('without a trusted proxy, a client cannot reset its limit by changing X-Forwarded-For', async () => {
    const app = withEnv({ TRUST_PROXY: undefined });
    const username = `rl_${randomUUID().slice(0, 8)}`;

    const statuses: number[] = [];
    for (let i = 1; i <= 11; i++) {
      statuses.push((await attempt(app, username, `203.0.113.${i}`)).status);
    }
    expect(statuses.slice(0, 10)).not.toContain(429);
    expect(statuses[10]).toBe(429);
  });

  it('behind a trusted proxy (TRUST_PROXY=1), limits each forwarded client separately', async () => {
    const app = withEnv({ TRUST_PROXY: '1' });
    const username = `rl_${randomUUID().slice(0, 8)}`;

    for (let i = 1; i <= 10; i++) {
      await attempt(app, username, '198.51.100.7');
    }
    expect((await attempt(app, username, '198.51.100.7')).status).toBe(429);
    expect((await attempt(app, username, '198.51.100.8')).status).not.toBe(429);
  });
});
