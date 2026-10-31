import { CONFIG_VALUE_SCHEMAS, SYSTEM_WIDE_CONFIG_KEYS } from '@bms/shared';
import { BusinessError, ForbiddenError, ValidationError } from '../../lib/errors.js';
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

/** Whether a branch may set its own value for `key`: not for a system-wide setting such as the currency. */
export const isBranchOverridable = (key: string): boolean => !SYSTEM_WIDE_CONFIG_KEYS.includes(key);

export function checkBranchOverridable(key: string): void {
  if (!isBranchOverridable(key)) {
    throw new ValidationError(`Config key '${key}' holds for every branch; change it in the system settings`);
  }
}

/**
 * The currency changes only while nothing is kept in it, a draft purchase
 * order or a bank account included (#181, owner decision 3a): amounts are
 * kept as entered, never converted, so a new currency would relabel them.
 */
/** The shop's time zone must be one PostgreSQL knows, or every date would fall back to the default (#175). */
export function checkTimeZone(zone: unknown, known: boolean): void {
  if (!known) throw new ValidationError(`Config key 'business_timezone' must be a time zone name, e.g. Africa/Addis_Ababa; '${String(zone)}' is not one`);
}

export function checkCurrencyChange(current: unknown, next: unknown, holders: string[]): void {
  if (current !== next && holders.length > 0) {
    throw new BusinessError(
      'CURRENCY_IN_USE',
      `The currency cannot change while records are kept in it (${holders.join(', ')}): amounts are kept as entered, never converted`,
    );
  }
}

/**
 * A record is kept in the shop's currency (#181): a currency the client names
 * must be it, as nothing is converted (another currency: #106).
 */
export function checkShopCurrency(given: string | undefined, shop: string, what: string): void {
  if (given !== undefined && given !== shop) {
    throw new ValidationError(`${what} are in the shop's currency, ${shop}`, { currency: given, shopCurrency: shop });
  }
}

/**
 * A branch's effective settings: every system key, with the branch's
 * override in its place where there is one. Overrides of keys that have no
 * system default, or that hold for every branch, are left out.
 */
export function mergeEffective(system: ConfigRecord[], branch: ConfigRecord[]): EffectiveConfigRecord[] {
  const overrides = new Map(branch.filter((r) => isBranchOverridable(r.key)).map((r) => [r.key, r]));
  return system.map((r) => {
    const override = overrides.get(r.key);
    return override ? { ...override, source: 'branch' } : { ...r, source: 'system' };
  });
}
