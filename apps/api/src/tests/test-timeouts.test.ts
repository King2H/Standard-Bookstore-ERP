// A setup or cleanup step (beforeAll, afterAll) gets as long as a test does
// (30 s). Before, hooks kept Vitest's 10 s default, so on a busy PC a file
// whose tests all passed failed in its cleanup (the owner's run of
// pre-login-preservation.test.ts, 2026-11-11, 1235 s for the suite).
import { describe, it, expect, beforeAll } from 'vitest';

describe('Test time limits', () => {
  let setUp = false;

  // Just over the old limit, well inside the new one.
  beforeAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10_500));
    setUp = true;
  });

  it('let a setup step take longer than 10 s', () => {
    expect(setUp).toBe(true);
  });
});
