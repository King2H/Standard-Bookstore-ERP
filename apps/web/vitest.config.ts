import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Frontend UI test harness (Pagination & Layout Standardization initiative,
// Part 4). Component-level tests only — no dev server, no backend, no DB.
// Kept as a separate config from vite.config.ts so the test-only deps
// (jsdom, @testing-library/*) never affect the production build.
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/tests/setup.ts'],
    css: false,
    // Tests that type through whole forms take about 1.5 s here and over 5 s
    // on slower machines; the 5 s default failed them there (owner's PC, #23).
    testTimeout: 20_000,
  },
});
