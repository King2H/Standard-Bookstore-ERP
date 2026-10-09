import type { Branch } from '@bms/shared';
import type { BranchRecord } from './branch.types.js';

/** The columns branch.repository selects for a branch. */
export interface BranchRow {
  id: number;
  name: string;
  address: string;
  contact_info: unknown;
  operating_hours: unknown;
  is_active: boolean;
  created_at: Date;
}

export function toBranchRecord(row: BranchRow): BranchRecord {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    contactInfo: (row.contact_info as Record<string, string> | null) ?? {},
    operatingHours: (row.operating_hours as Record<string, string> | null) ?? {},
    isActive: row.is_active,
    createdAt: row.created_at,
  };
}

export function toBranchResponse(record: BranchRecord): Branch {
  return { ...record, createdAt: record.createdAt.toISOString() };
}
