import type { ConfigEntry, EffectiveConfigEntry } from '@bms/shared';
import type { ConfigRecord, EffectiveConfigRecord } from './config.types.js';

/** The columns config.repository selects for a setting. */
export interface ConfigRow {
  key: string;
  value: unknown;
  updated_by: number;
  updated_at: Date;
}

export function toConfigRecord(row: ConfigRow): ConfigRecord {
  return { key: row.key, value: row.value, updatedBy: row.updated_by, updatedAt: row.updated_at };
}

export function toConfigEntryResponse(record: ConfigRecord): ConfigEntry {
  return {
    key: record.key,
    value: record.value,
    updatedBy: record.updatedBy,
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function toEffectiveConfigEntryResponse(record: EffectiveConfigRecord): EffectiveConfigEntry {
  return { ...toConfigEntryResponse(record), source: record.source };
}
