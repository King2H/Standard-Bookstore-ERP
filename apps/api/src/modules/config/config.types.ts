import type { ConfigSource } from '@bms/shared';

/** The signed-in staff member changing a setting. */
export interface Actor {
  staffId: number;
  /** The first role held, recorded in the audit log. */
  role: string;
  /** Every role held in the session branch; the rules look at all of them. */
  roles: string[];
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
