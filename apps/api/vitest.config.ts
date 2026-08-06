import { defineConfig } from 'vitest/config';
import { resolve } from 'path';
import { config as dotenvConfig } from 'dotenv';

// Load .env from workspace root so DATABASE_URL is available in test workers
const dotenvResult = dotenvConfig({ path: resolve(__dirname, '../../.env') });
const envVars = dotenvResult.parsed ?? {};

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./src/tests/setup.ts'],
    // Pass env vars from workspace root .env to forked workers
    env: {
      ...envVars,
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
          JWT_SECRET: envVars.JWT_SECRET ?? 'test_jwt_secret_not_for_production',
          COLUMN_ENCRYPTION_KEY: envVars.COLUMN_ENCRYPTION_KEY ?? '0000000000000000000000000000000000000000000000000000000000000001',
        },
      },
    },
    testTimeout: 30_000,
  },
});
