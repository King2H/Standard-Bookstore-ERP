import type { ConfigSource } from '@bms/shared';
import { kysely } from '../../db/kysely.js';
import { isForeignKeyViolation } from '../../db/errors.js';
import { withTransaction } from '../../db/tx.js';
import { NotFoundError } from '../../lib/errors.js';
import { redisDel, redisGet, redisSet } from '../../lib/redis.js';
import { insertAuditEntry } from '../audit/audit.repository.js';
import * as policy from './config.policy.js';
import * as config from './config.repository.js';
import type { Actor, ConfigRecord, EffectiveConfigRecord } from './config.types.js';

/**
 * Use cases of the Configuration module (A4): one function each, owning its
 * transaction. The typed getters at the end are what other modules call.
 */

const CACHE_TTL_SECONDS = 300;
const cacheKey = (branchId: number, key: string) => `cfg:${branchId}:${key}`;

// ── Effective values (branch override, else system default) ───────────────────

export async function getEffectiveConfigWithSource(
  branchId: number,
  key: string,
): Promise<{ value: unknown; source: ConfigSource }> {
  const override = policy.isBranchOverridable(key) ? await config.findBranchValue(kysely, branchId, key) : undefined;
  if (override) return { value: override.value, source: 'branch' };

  const system = await config.findSystemValue(kysely, key);
  if (system) return { value: system.value, source: 'system' };

  throw new NotFoundError(`Config key '${key}'`);
}

/** Like getEffectiveConfigWithSource, cached in Redis (when configured) for five minutes. */
export async function getEffectiveConfig(branchId: number, key: string): Promise<unknown> {
  const cached = await redisGet(cacheKey(branchId, key));
  if (cached !== null) {
    try {
      return JSON.parse(cached);
    } catch {
      /* fall through to the database */
    }
  }
  const { value } = await getEffectiveConfigWithSource(branchId, key);
  await redisSet(cacheKey(branchId, key), JSON.stringify(value), CACHE_TTL_SECONDS);
  return value;
}

/** The branch's values for `keys`; a key set nowhere comes back as null. */
export async function getEffectiveValues(
  branchId: number,
  keys: string[],
): Promise<Array<{ key: string; value: unknown; source: ConfigSource }>> {
  return Promise.all(
    keys.map(async (key) => {
      try {
        return { key, ...(await getEffectiveConfigWithSource(branchId, key)) };
      } catch {
        return { key, value: null, source: 'system' as const };
      }
    }),
  );
}

/** The shop's currency, one for every branch; ETB when it cannot be read, so selling screens always get one. */
export async function getBaseCurrency(): Promise<string> {
  try {
    return await config.findShopCurrency(kysely);
  } catch {
    return 'ETB';
  }
}

// ── System settings ───────────────────────────────────────────────────────────

export function listSystemConfig(): Promise<ConfigRecord[]> {
  return config.listSystem(kysely);
}

export async function setSystemConfig(actor: Actor, key: string, value: unknown): Promise<ConfigRecord> {
  policy.checkCanChangeSystemConfig(actor.roles);
  policy.checkConfigValue(key, value);

  // Cached branch values pick up a new system default when they expire.
  return withTransaction({}, async (tx) => {
    const previous = await config.findSystemValue(tx, key);
    if (key === 'base_currency') {
      policy.checkCurrencyChange(previous?.value, value, await config.findCurrencyHolders(tx));
    }
    const record = await config.upsertSystem(tx, { key, value, updatedBy: actor.staffId });
    await insertAuditEntry(tx, {
      staffId: actor.staffId,
      staffRole: actor.role,
      branchId: null,
      action: 'UPDATE',
      entityType: 'system_config',
      entityId: key,
      meta: { key, previousValue: previous?.value ?? null, newValue: value },
    });
    return record;
  });
}

// ── Branch overrides ──────────────────────────────────────────────────────────

/** Every system key for the branch, each with its effective value and where it comes from. */
export async function getEffectiveBranchConfig(branchId: number): Promise<EffectiveConfigRecord[]> {
  const [system, branch] = await Promise.all([config.listSystem(kysely), config.listBranch(kysely, branchId)]);
  return policy.mergeEffective(system, branch);
}

export async function setBranchConfig(
  actor: Actor,
  branchId: number,
  key: string,
  value: unknown,
): Promise<ConfigRecord> {
  policy.checkCanChangeBranchConfig(actor.roles);
  policy.checkBranchOverridable(key);
  policy.checkConfigValue(key, value);

  const record = await withTransaction({}, async (tx) => {
    const previous = await config.findBranchValue(tx, branchId, key);
    let saved: ConfigRecord;
    try {
      saved = await config.upsertBranch(tx, branchId, { key, value, updatedBy: actor.staffId });
    } catch (err) {
      if (isForeignKeyViolation(err)) throw new NotFoundError('Branch');
      throw err;
    }
    await insertAuditEntry(tx, {
      staffId: actor.staffId,
      staffRole: actor.role,
      branchId,
      action: 'UPDATE',
      entityType: 'branch_config',
      entityId: key,
      meta: { key, branchId, previousValue: previous?.value ?? null, newValue: value },
    });
    return saved;
  });
  await redisDel(cacheKey(branchId, key));
  return record;
}

export async function deleteBranchConfig(actor: Actor, branchId: number, key: string): Promise<void> {
  policy.checkCanRemoveBranchOverride(actor.roles);

  await withTransaction({}, async (tx) => {
    if (!(await config.deleteBranch(tx, branchId, key))) {
      throw new NotFoundError(`Branch config key '${key}'`);
    }
    await insertAuditEntry(tx, {
      staffId: actor.staffId,
      staffRole: actor.role,
      branchId,
      action: 'DELETE',
      entityType: 'branch_config',
      entityId: key,
      meta: { key, branchId, action: 'override_removed' },
    });
  });
  await redisDel(cacheKey(branchId, key));
}

// ── Typed getters used by other modules ───────────────────────────────────────
// Some read the system value only, ignoring branch overrides, as they did in v1.

async function systemValue(key: string): Promise<unknown> {
  return (await config.findSystemValue(kysely, key))?.value;
}

/** The largest line discount any role held in the branch allows (every role held counts, as elsewhere). */
export async function getMaxLineDiscountPct(branchId: number, roles: readonly string[]): Promise<number> {
  const val = (await getEffectiveConfig(branchId, 'max_line_discount_pct')) as Record<string, number>;
  return Math.max(0, ...roles.map((r) => val[r] ?? 0));
}

export async function getDiscountApprovalThresholdPct(branchId: number): Promise<number> {
  return Number(await getEffectiveConfig(branchId, 'discount_approval_threshold_pct'));
}

export async function getPOApprovalThreshold(): Promise<number> {
  return Number((await systemValue('po_approval_threshold')) ?? 1000);
}

export async function getReturnWindowDays(branchId: number): Promise<number> {
  return Number(await getEffectiveConfig(branchId, 'return_window_days'));
}

export async function getMaxReturnValueWithoutAuth(): Promise<number> {
  return Number((await systemValue('max_return_value_without_auth')) ?? 500);
}

export async function getRefundMethodAfterWindow(): Promise<'any' | 'store_credit_only'> {
  return ((await systemValue('refund_method_after_window')) ?? 'any') as 'any' | 'store_credit_only';
}

export async function getAllowedPaymentMethods(branchId: number): Promise<string[]> {
  try {
    const val = await getEffectiveConfig(branchId, 'allowed_payment_methods');
    return Array.isArray(val) ? val : [];
  } catch {
    // Key not set → all methods allowed
    return [];
  }
}

export async function getLoyaltyAccrualRate(): Promise<number> {
  return Number((await systemValue('loyalty_accrual_rate')) ?? 0.01);
}

export async function getLoyaltyRedemptionRate(): Promise<number> {
  return Number((await systemValue('loyalty_redemption_rate')) ?? 1.0);
}

export async function getLoyaltyMinTransactionAmount(): Promise<number> {
  return Number((await systemValue('loyalty_min_transaction_amount')) ?? 0);
}

/** Failed sign-ins in a row that lock an account, and for how many minutes. */
export async function getSignInLockoutPolicy(): Promise<{ maxFailedAttempts: number; lockoutMinutes: number }> {
  const [max, minutes] = await Promise.all([systemValue('max_failed_login_attempts'), systemValue('account_lockout_minutes')]);
  return { maxFailedAttempts: Number(max ?? 5), lockoutMinutes: Number(minutes ?? 30) };
}

/**
 * Whether stock may go below zero in a branch: its own setting, else the
 * system's, as the Settings page offers it. Read uncached, so a change applies
 * at once to the next stock movement.
 */
export async function isNegativeStockAllowed(branchId: number): Promise<boolean> {
  try {
    return (await getEffectiveConfigWithSource(branchId, 'allow_negative_stock')).value === true;
  } catch (err) {
    if (err instanceof NotFoundError) return false;
    throw err;
  }
}

export async function isExchangeCashAdjustmentAllowed(): Promise<boolean> {
  return (await systemValue('exchange_cash_adjustment_allowed')) === true;
}
