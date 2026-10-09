import type { ConfigSource } from '@bms/shared';

/** The signed-in staff member changing a setting. */
export interface Actor {
  staffId: number;
  role: string;
  branchId: number;
}

/** A system_config or branch_config row in application form. */
export interface ConfigRecord {
  key: string;
  value: unknown;
  updatedBy: number;
  updatedAt: Date;
}

export interface EffectiveConfigRecord extends ConfigRecord {
  source: ConfigSource;
}

/** The JSON type a key's value must have; `jsonb` accepts any JSON value. */
export type ConfigValueType = 'string' | 'number' | 'boolean' | 'jsonb';
