import { describe, it, expect } from 'vitest';
import { checkEnvironment, assertEnvironment, parseTrustProxy, readHttpConfig } from '../lib/env.js';

const goodJwt = 'k3D9fQx1-Lr8sWm2VbN7cTz4Hy6PgJa0Ue5Io';
const goodKey = '3f9a1c7e5b2d4086a1e3c5b7d9f0a2c4e6b8d0f1a3c5e7b9d1f3a5c7e9b1d3f5';

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { NODE_ENV: 'production', JWT_SECRET: goodJwt, COLUMN_ENCRYPTION_KEY: goodKey, ...overrides };
}

describe('checkEnvironment', () => {
  it('accepts a production environment with generated secrets', () => {
    expect(checkEnvironment(env({}))).toEqual({ errors: [], warnings: [] });
  });

  it('rejects missing, short or malformed secrets in every environment', () => {
    for (const NODE_ENV of ['production', 'development', 'test']) {
      expect(checkEnvironment(env({ NODE_ENV, JWT_SECRET: undefined })).errors).toHaveLength(1);
      expect(checkEnvironment(env({ NODE_ENV, JWT_SECRET: 'short' })).errors).toHaveLength(1);
      expect(checkEnvironment(env({ NODE_ENV, COLUMN_ENCRYPTION_KEY: 'replace_with_64_char_hex_string_generated_by_command_above' })).errors).toHaveLength(1);
      expect(checkEnvironment(env({ NODE_ENV, COLUMN_ENCRYPTION_KEY: goodKey.slice(0, 58) })).errors).toHaveLength(1);
    }
  });

  it('rejects published example secrets in production', () => {
    const placeholders = [
      { JWT_SECRET: 'change_this_to_a_secure_random_string_in_production' },
      { JWT_SECRET: 'dev_jwt_secret_change_in_production' },
      { COLUMN_ENCRYPTION_KEY: '0'.repeat(64) },
      { COLUMN_ENCRYPTION_KEY: `${'0'.repeat(63)}1` },
    ];
    for (const p of placeholders) {
      expect(checkEnvironment(env(p)).errors).toHaveLength(1);
    }
  });

  it('treats an unset NODE_ENV as production', () => {
    expect(checkEnvironment(env({ NODE_ENV: undefined, COLUMN_ENCRYPTION_KEY: '0'.repeat(64) })).errors).toHaveLength(1);
  });

  it('only warns about example secrets in development, and is silent in test', () => {
    const dev = checkEnvironment(env({ NODE_ENV: 'development', COLUMN_ENCRYPTION_KEY: '0'.repeat(64) }));
    expect(dev.errors).toEqual([]);
    expect(dev.warnings).toHaveLength(1);

    expect(checkEnvironment(env({ NODE_ENV: 'test', COLUMN_ENCRYPTION_KEY: '0'.repeat(64) }))).toEqual({ errors: [], warnings: [] });
  });

  it('rejects FRONTEND_URL entries that are not origins', () => {
    expect(checkEnvironment(env({ FRONTEND_URL: 'https://shop.example, http://localhost:5173/' })).errors).toEqual([]);
    expect(checkEnvironment(env({ FRONTEND_URL: 'shop.example' })).errors).toHaveLength(1);
    expect(checkEnvironment(env({ FRONTEND_URL: 'https://shop.example/app' })).errors).toHaveLength(1);
  });

  it('rejects TRUST_PROXY=true, which would trust any client', () => {
    expect(checkEnvironment(env({ TRUST_PROXY: 'true' })).errors).toHaveLength(1);
  });

  it('assertEnvironment lists every problem in one error', () => {
    expect(() => assertEnvironment(env({ JWT_SECRET: undefined, COLUMN_ENCRYPTION_KEY: undefined })))
      .toThrow(/JWT_SECRET[\s\S]*COLUMN_ENCRYPTION_KEY/);
  });
});

describe('HTTP configuration', () => {
  it('parses TRUST_PROXY as off, a hop count or a list of addresses', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('loopback, 10.0.0.0/8')).toBe('loopback, 10.0.0.0/8');
  });

  it('allows any origin only in development or test without FRONTEND_URL', () => {
    expect(readHttpConfig({ NODE_ENV: 'development' }).allowAnyOrigin).toBe(true);
    expect(readHttpConfig({ NODE_ENV: 'production' }).allowAnyOrigin).toBe(false);
    expect(readHttpConfig({}).allowAnyOrigin).toBe(false);
    expect(readHttpConfig({ NODE_ENV: 'development', FRONTEND_URL: 'https://shop.example/' })).toMatchObject({
      allowAnyOrigin: false,
      allowedOrigins: ['https://shop.example'],
    });
  });
});
