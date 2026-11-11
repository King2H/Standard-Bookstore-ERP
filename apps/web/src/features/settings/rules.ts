import { CONFIG_VALUE_SCHEMAS, TAX_CONFIG_KEYS, type ProfileResponse } from '@bms/shared';

/**
 * Who may change which settings: the API's rules (config.policy.ts,
 * branchParamInScope), so the page offers only what the API accepts. Any role
 * held in the session branch counts.
 */
type Account = Pick<ProfileResponse, 'currentRoles' | 'currentBranchId' | 'isAllBranches'>;

const holds = (me: Account | undefined, allowed: string[]) => (me?.currentRoles ?? []).some((r) => allowed.includes(r));

/** System defaults: Super_Admin only. */
export const canChangeSystemSettings = (me: Account | undefined) => holds(me, ['Super_Admin']);

/** The tax settings (#247, owner decision 3a): Super_Admin and Admin. */
export const canChangeTaxSettings = (me: Account | undefined) => holds(me, ['Super_Admin', 'Admin']);

/** One shop-wide setting: the tax ones for Super_Admin and Admin, every other for Super_Admin. */
export const canChangeSystemSetting = (me: Account | undefined, key: string) =>
  (TAX_CONFIG_KEYS as readonly string[]).includes(key) ? canChangeTaxSettings(me) : canChangeSystemSettings(me);

/** Branch overrides: Super_Admin, Admin and Manager. */
export const canOverrideBranchSettings = (me: Account | undefined) => holds(me, ['Super_Admin', 'Admin', 'Manager']);

/** Removing a branch override: Super_Admin and Admin. */
export const canRemoveBranchOverrides = (me: Account | undefined) => holds(me, ['Super_Admin', 'Admin']);

/** A branch's settings are opened from that branch, unless with access to all branches. */
export function canOpenBranchSettings(me: Account | undefined, branchId: number): boolean {
  if (!me) return false;
  return me.isAllBranches || me.currentBranchId === branchId;
}

export type ValueType = 'string' | 'number' | 'boolean' | 'json';

/**
 * Reads what was typed for a setting and checks it with the rules the API
 * applies (CONFIG_VALUE_SCHEMAS). Returns the value to send, or what is wrong.
 */
export function readSettingValue(key: string, type: ValueType, raw: string): { value: unknown } | { error: string } {
  let value: unknown = raw;
  if (type === 'number') {
    value = raw.trim() === '' ? NaN : Number(raw);
    if (Number.isNaN(value)) return { error: 'Enter a number' };
  } else if (type === 'boolean') {
    value = raw === 'true';
  } else if (type === 'json') {
    try { value = JSON.parse(raw); } catch { return { error: 'Not valid JSON' }; }
  }
  const schema = CONFIG_VALUE_SCHEMAS[key];
  const result = schema?.safeParse(value);
  if (result && !result.success) return { error: `Must ${result.error.issues[0].message.replace(/^must /, '')}` };
  return { value };
}
