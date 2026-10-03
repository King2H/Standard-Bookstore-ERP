import { defineConfig } from 'vitest/config';
import { resolve } from 'path';
import { config as dotenvConfig } from 'dotenv';
import { resolveTestDatabaseUrl } from './src/tests/testDatabaseUrl';

// Load .env from workspace root so DATABASE_URL is available in test workers
const dotenvResult = dotenvConfig({ path: resolve(__dirname, '../../.env') });
const envVars = dotenvResult.parsed ?? {};

// Tests use their own database (bms_test by default), never the development one.
const testDatabaseUrl = resolveTestDatabaseUrl({ ...envVars, ...process.env });

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    globalSetup: ['./src/tests/globalSetup.ts'],
    setupFiles: ['./src/tests/setup.ts'],
    // Pass env vars from workspace root .env to forked workers
    env: {
      ...envVars,
      DATABASE_URL: testDatabaseUrl,
      // Ensure test-safe defaults if not in .env
      JWT_SECRET: envVars.JWT_SECRET ?? 'test_jwt_secret_not_for_production',
      COLUMN_ENCRYPTION_KEY: envVars.COLUMN_ENCRYPTION_KEY ?? '0000000000000000000000000000000000000000000000000000000000000001',
    },
    // Run tests sequentially to avoid DB conflicts
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
        env: {
          ...envVars,
          DATABASE_URL: testDatabaseUrl,
          JWT_SECRET: envVars.JWT_SECRET ?? 'test_jwt_secret_not_for_production',
          COLUMN_ENCRYPTION_KEY: envVars.COLUMN_ENCRYPTION_KEY ?? '0000000000000000000000000000000000000000000000000000000000000001',
        },
      },
    },
    testTimeout: 30_000,
    // Run after-hooks in reverse registration order (the Vitest 2+ default),
    // so the pool cleanup in setup.ts runs after each file's own afterAll.
    sequence: { hooks: 'stack' },
  },
});
