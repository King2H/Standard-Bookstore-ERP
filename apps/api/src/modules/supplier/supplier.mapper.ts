import type { BookSupplier, LifecycleStatus, Supplier, SupplierType } from '@bms/shared';
import type { BookSupplierRecord, SupplierRecord } from './supplier.types.js';

/** The columns supplier.repository selects for a supplier. */
export interface SupplierRow {
  id: number;
  name: string;
  contact_info: unknown;
  lead_time_days: number;
  pricing_terms: string | null;
  supplier_type: string;
  publisher_id: number | null;
  publisher_name: string | null;
  is_active: boolean;
  is_blacklisted: boolean;
  status: string;
  archived_at: Date | null;
  created_at: Date;
}

export interface BookSupplierRow {
  book_id: number;
  supplier_id: number;
  supplier_name: string;
  supplier_sku: string | null;
  is_primary: boolean;
}

// The database CHECK constraints limit supplier_type and status to these values.
export function toSupplierRecord(row: SupplierRow): SupplierRecord {
  return {
    id: row.id,
    name: row.name,
    contactInfo: (row.contact_info as Record<string, unknown> | null) ?? {},
    leadTimeDays: row.lead_time_days,
    pricingTerms: row.pricing_terms,
    supplierType: row.supplier_type as SupplierType,
    publisherId: row.publisher_id,
    publisherName: row.publisher_name,
    isActive: row.is_active,
    isBlacklisted: row.is_blacklisted,
    status: row.status as LifecycleStatus,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
  };
}

export function toSupplierResponse(record: SupplierRecord): Supplier {
  return {
    ...record,
    archivedAt: record.archivedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
  };
}

export function toBookSupplierRecord(row: BookSupplierRow): BookSupplierRecord {
  return {
    bookId: row.book_id,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    supplierSku: row.supplier_sku,
    isPrimary: row.is_primary,
  };
}

export function toBookSupplierResponse(record: BookSupplierRecord): BookSupplier {
  return { ...record };
}
