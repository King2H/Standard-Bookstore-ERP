// #32 (owner decisions 1a, 2a, 3a, 2026-11-07): the API writes structured
// logs (Pino) in which every line written while serving a request carries its
// request ID, staff, branch and shop; secrets and customer contacts never
// reach a log line. A request ID from the client is taken only when it is a
// short, safe token, and is sent back. Liveness (the process answers) and
// readiness (the database answers and the API is not shutting down) are
// separate endpoints. Before, only the access line carried the request ID,
// any X-Request-Id was written to the logs as given, and one /health mixed
// both.
import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import request from 'supertest';
import { LivenessResponseSchema, ReadinessResponseSchema } from '@bms/shared';
import { captureLogs, log } from '../lib/log.js';
import { setShuttingDown } from '../lib/readiness.js';
import { getTestApp } from './helpers/testApp.js';
import { createTestStaff } from './helpers/seed.js';
import { cleanTestStaff } from './helpers/testDb.js';

type Line = Record<string, unknown>;

describe('Logging and health (#32)', () => {
  let stop: (() => Line[]) | undefined;
  afterEach(() => { stop?.(); stop = undefined; setShuttingDown(false); });
  afterAll(() => cleanTestStaff('obs_test_'));

  describe('the request ID', () => {
    it('takes a safe one from the client, and sends it back', async () => {
      const res = await request(getTestApp()).get('/api/v1/health/live').set('X-Request-Id', 'counter-2.req_0042');
      expect(res.headers['x-request-id']).toBe('counter-2.req_0042');
    });

    it('makes its own for one that is not a short, safe token', async () => {
      for (const given of ['bad{"level":"error","msg":"forged"}', 'x'.repeat(65), 'a b']) {
        const res = await request(getTestApp()).get('/api/v1/health/live').set('X-Request-Id', given);
        expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      }
    });

    it('is on every line written while serving the request, with the staff, branch and shop', async () => {
      const staff = await createTestStaff({ username: `obs_test_${Date.now()}`, role: 'Manager' });
      stop = captureLogs();
      const res = await request(getTestApp()).get('/api/v1/staff/me').set('Authorization', `Bearer ${staff.token}`).set('X-Request-Id', 'obs-test-1');
      expect(res.status).toBe(200);
      const lines = stop().filter((l) => l.requestId === 'obs-test-1');
      const access = lines.find((l) => l.msg === 'request');
      expect(access).toMatchObject({
        level: 'info', method: 'GET', path: '/api/v1/staff/me', statusCode: 200,
        staffId: staff.staffId, branchId: staff.branchId, tenantId: expect.any(Number),
      });
      expect(typeof access!.durationMs).toBe('number');
      expect(typeof access!.time).toBe('string');
    });
  });

  it('never writes passwords, tokens, keys or customer contacts', () => {
    stop = captureLogs();
    log.info({
      password: 'pw-secret', token: 'tok-secret', accessToken: 'at-secret', refreshToken: 'rt-secret', key: 'key-secret',
      headers: { authorization: 'Bearer hdr-secret', cookie: 'sid=cookie-secret' },
      customer: { phone: '+251911999888', email: 'hidden@example.et', name: 'Shown' },
    }, 'redaction check');
    const text = JSON.stringify(stop());
    for (const secret of ['pw-secret', 'tok-secret', 'at-secret', 'rt-secret', 'key-secret', 'hdr-secret', 'cookie-secret', '+251911999888', 'hidden@example.et']) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('Shown');
  });

  describe('liveness and readiness', () => {
    it('is live while the process answers', async () => {
      const res = await request(getTestApp()).get('/api/v1/health/live');
      expect(res.status).toBe(200);
      expect(LivenessResponseSchema.parse(res.body).status).toBe('ok');
    });

    it('is ready when the database answers', async () => {
      const res = await request(getTestApp()).get('/api/v1/health/ready');
      expect(res.status).toBe(200);
      expect(ReadinessResponseSchema.parse(res.body)).toMatchObject({ status: 'ready', database: 'ok', shuttingDown: false });
    });

    it('writes an answered health check at debug level only: Docker asks every 15 seconds', async () => {
      stop = captureLogs();
      await request(getTestApp()).get('/api/v1/health/ready').set('X-Request-Id', 'obs-health-1');
      setShuttingDown(true);
      await request(getTestApp()).get('/api/v1/health/ready').set('X-Request-Id', 'obs-health-2');
      const lines = stop();
      expect(lines.find((l) => l.requestId === 'obs-health-1')).toMatchObject({ level: 'debug', msg: 'request' });
      // One that fails is logged as any other 5xx: an error.
      expect(lines.find((l) => l.requestId === 'obs-health-2')).toMatchObject({ level: 'error', statusCode: 503 });
    });

    it('is not ready once shutting down, while still live', async () => {
      setShuttingDown(true);
      const ready = await request(getTestApp()).get('/api/v1/health/ready');
      expect(ready.status).toBe(503);
      expect(ReadinessResponseSchema.parse(ready.body)).toMatchObject({ status: 'not_ready', shuttingDown: true });
      expect((await request(getTestApp()).get('/api/v1/health/live')).status).toBe(200);
    });
  });

  it('logs through the logger only: no console calls in the API', () => {
    const srcDir = resolve(import.meta.dirname, '..');
    const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return ['tests', '__tests__'].includes(name) ? [] : files(path);
      return path.endsWith('.ts') ? [path] : [];
    });
    const offenders: string[] = [];
    for (const file of files(srcDir)) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        // A console call in code, not one quoted in a message (such as a command to run).
        if (/(^|[^"'`\w.])console\.(log|warn|error|info|debug)\(/.test(line)) offenders.push(`${relative(srcDir, file)}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
