import { CONFIG_VALUE_SCHEMAS } from '@bms/shared';
import { ForbiddenError, ValidationError } from '../../lib/errors.js';
import type { ConfigRecord, EffectiveConfigRecord } from './config.types.js';

/**
 * Configuration rules as pure functions (A5): no I/O, so they are unit-tested
 * without a database (__tests__/config.policy.test.ts).
 */

/** Throws 400 unless `key` is a known setting and `value` is one it takes (CONFIG_VALUE_SCHEMAS). */
export function checkConfigValue(key: string, value: unknown): void {
  const schema = Object.hasOwn(CONFIG_VALUE_SCHEMAS, key) ? CONFIG_VALUE_SCHEMAS[key] : undefined;
  if (!schema) throw new ValidationError(`Unknown config key: ${key}`);
  const result = schema.safeParse(value);
  if (!result.success) throw new ValidationError(`Config key '${key}' ${result.error.issues[0].message}`);
}

const holds = (roles: readonly string[], allowed: string[]) => roles.some((r) => allowed.includes(r));

// Any role held in the session branch counts, whatever order the roles were given in.
export function checkCanChangeSystemConfig(roles: readonly string[]): void {
  if (!holds(roles, ['Super_Admin'])) {
    throw new ForbiddenError('Only Super_Admin can modify system configuration');
  }
}

export function checkCanChangeBranchConfig(roles: readonly string[]): void {
  if (!holds(roles, ['Super_Admin', 'Admin', 'Manager'])) {
    throw new ForbiddenError('Only Super_Admin, Admin, or Manager can modify branch configuration');
  }
}

export function checkCanRemoveBranchOverride(roles: readonly string[]): void {
  if (!holds(roles, ['Super_Admin', 'Admin'])) {
    throw new ForbiddenError('Only Super_Admin or Admin can delete branch config overrides');
  }
}

/**
 * A branch's effective settings: every system key, with the branch's
 * override in its place where there is one. Overrides of keys that have no
 * system default are left out.
 */
export function mergeEffective(system: ConfigRecord[], branch: ConfigRecord[]): EffectiveConfigRecord[] {
  const overrides = new Map(branch.map((r) => [r.key, r]));
  return system.map((r) => {
    const override = overrides.get(r.key);
    return override ? { ...override, source: 'branch' } : { ...r, source: 'system' };
  });
}
