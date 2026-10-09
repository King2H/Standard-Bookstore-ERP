import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { cleanBranchConfig, cleanTestBranches } from './helpers/testDb.js';
import { createTestBranch } from './helpers/seed.js';

// Redis is optional and off in tests; this file stands one in so the
// five-minute config cache is exercised.
const cache = vi.hoisted(() => new Map<string, string>());
vi.mock('../lib/redis.js', () => ({
  redisGet: async (key: string) => cache.get(key) ?? null,
  redisSet: async (key: string, value: string) => void cache.set(key, value),
  redisDel: async (key: string) => void cache.delete(key),
}));

const configService = await import('../modules/config/config.service.js');

const BRANCH_PREFIX = 'Config Cache ';
const actor = { staffId: 1, role: 'Admin', branchId: 1 };

describe('Config cache', () => {
  let branchId: number;

  beforeAll(async () => {
    await cleanTestBranches(BRANCH_PREFIX);
    branchId = (await createTestBranch({ name: `${BRANCH_PREFIX}Branch` })).branchId;
  });

  afterAll(async () => {
    await cleanBranchConfig(branchId);
    await cleanTestBranches(BRANCH_PREFIX);
  });

  it('serves a new override at once', async () => {
    const system = await configService.getEffectiveConfig(branchId, 'return_window_days');
    await configService.setBranchConfig(actor, branchId, 'return_window_days', Number(system) + 5);
    expect(await configService.getEffectiveConfig(branchId, 'return_window_days')).toBe(Number(system) + 5);
  });

  it('serves the system default at once after the override is removed (was: the old override until the cache expired)', async () => {
    const system = (await configService.getEffectiveConfigWithSource(0, 'return_window_days')).value;
    await configService.getEffectiveConfig(branchId, 'return_window_days'); // cached override

    await configService.deleteBranchConfig(actor, branchId, 'return_window_days');

    expect(await configService.getEffectiveConfig(branchId, 'return_window_days')).toBe(system);
  });
});
