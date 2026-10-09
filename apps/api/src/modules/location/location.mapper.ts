import type { Location, StaffLocation } from '@bms/shared';
import type { LocationRecord, StaffLocationRecord } from './location.types.js';

/** The columns location.repository selects for a location. */
export interface LocationRow {
  id: number;
  branch_id: number;
  name: string;
  is_default_fulfillment: boolean;
  created_at: Date;
}

export function toLocationRecord(row: LocationRow): LocationRecord {
  return {
    id: row.id,
    branchId: row.branch_id,
    name: row.name,
    isDefaultFulfillment: row.is_default_fulfillment,
    createdAt: row.created_at,
  };
}

export function toLocationResponse(record: LocationRecord): Location {
  return { ...record, createdAt: record.createdAt.toISOString() };
}

export function toStaffLocationResponse(record: StaffLocationRecord): StaffLocation {
  return { locationId: record.locationId, locationName: record.locationName, branchId: record.branchId };
}
