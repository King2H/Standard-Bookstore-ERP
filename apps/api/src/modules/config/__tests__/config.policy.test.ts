import { describe, it, expect } from 'vitest';
import {
  checkCanChangeBranchConfig,
  checkCanChangeSystemConfig,
  checkCanRemoveBranchOverride,
  checkConfigValue,
  mergeEffective,
} from '../config.policy.js';
import type { ConfigRecord } from '../config.types.js';

describe('checkConfigValue', () => {
  it('accepts a value of the key\'s type, and any JSON for jsonb keys', () => {
    expect(() => checkConfigValue('base_currency', 'ETB')).not.toThrow();
    expect(() => checkConfigValue('return_window_days', 14)).not.toThrow();
    expect(() => checkConfigValue('allow_negative_stock', false)).not.toThrow();
    expect(() => checkConfigValue('max_line_discount_pct', { Sales: 10 })).not.toThrow();
  });

  it('refuses a value of another type', () => {
    expect(() => checkConfigValue('return_window_days', '14')).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR', message: "Config key 'return_window_days' must be a number" }),
    );
    expect(() => checkConfigValue('allow_negative_stock', 'no')).toThrow(expect.objectContaining({ statusCode: 400 }));
  });

  it('refuses unknown keys, including names every object inherits', () => {
    for (const key of ['nonexistent_key', 'constructor', 'toString', '__proto__']) {
      expect(() => checkConfigValue(key, 'x')).toThrow(
        expect.objectContaining({ code: 'VALIDATION_ERROR', message: `Unknown config key: ${key}` }),
      );
    }
  });
});

describe('who may change settings', () => {
  it('lets only Super_Admin change system settings', () => {
    expect(() => checkCanChangeSystemConfig('Super_Admin')).not.toThrow();
    expect(() => checkCanChangeSystemConfig('Admin')).toThrow(expect.objectContaining({ statusCode: 403 }));
  });

  it('lets Super_Admin, Admin and Manager override a branch setting', () => {
    for (const role of ['Super_Admin', 'Admin', 'Manager']) expect(() => checkCanChangeBranchConfig(role)).not.toThrow();
    expect(() => checkCanChangeBranchConfig('Sales')).toThrow(expect.objectContaining({ statusCode: 403 }));
  });

  it('lets only Super_Admin and Admin remove a branch override', () => {
    for (const role of ['Super_Admin', 'Admin']) expect(() => checkCanRemoveBranchOverride(role)).not.toThrow();
    expect(() => checkCanRemoveBranchOverride('Manager')).toThrow(expect.objectContaining({ statusCode: 403 }));
  });
});

describe('mergeEffective', () => {
  const at = new Date('2026-10-08T00:00:00Z');
  const row = (key: string, value: unknown): ConfigRecord => ({ key, value, updatedBy: 1, updatedAt: at });

  it('uses the branch override where there is one and the system value elsewhere', () => {
    const merged = mergeEffective(
      [row('base_currency', 'ETB'), row('return_window_days', 7)],
      [row('return_window_days', 14), row('not_a_system_key', true)],
    );
    expect(merged).toEqual([
      { ...row('base_currency', 'ETB'), source: 'system' },
      { ...row('return_window_days', 14), source: 'branch' },
    ]);
  });
});
