import type { LifecycleStatus, SupplierType } from '@bms/shared';

/** A suppliers row in application form, joined with its publisher's name. */
export interface SupplierRecord {
  id: number;
  name: string;
  contactInfo: Record<string, unknown>;
  leadTimeDays: number;
  pricingTerms: string | null;
  supplierType: SupplierType;
  publisherId: number | null;
  publisherName: string | null;
  isActive: boolean;
  isBlacklisted: boolean;
  /** Kept in step with isActive: isActive is true exactly when status is ACTIVE. */
  status: LifecycleStatus;
  archivedAt: Date | null;
  createdAt: Date;
}

export interface BookSupplierRecord {
  bookId: number;
  supplierId: number;
  supplierName: string;
  supplierSku: string | null;
  isPrimary: boolean;
}

export interface SupplierFilter {
  supplierType?: SupplierType;
  /** Ignored when `statuses` is set. */
  isActive?: boolean;
  isBlacklisted?: boolean;
  /** Undefined means any status. */
  statuses?: LifecycleStatus[];
  /** Case-insensitive substring of the name. */
  nameContains?: string;
}

export interface NewSupplier {
  name: string;
  contactInfo: Record<string, unknown>;
  leadTimeDays: number;
  pricingTerms: string | null;
  supplierType: SupplierType;
  publisherId: number | null;
}

/** Columns to change; undefined fields are left as they are. */
export interface SupplierChanges {
  name?: string;
  contactInfo?: Record<string, unknown>;
  leadTimeDays?: number;
  pricingTerms?: string | null;
  supplierType?: SupplierType;
  publisherId?: number | null;
  isActive?: boolean;
}

/** The staff member performing a change, for the audit log. */
export interface Actor {
  staffId: number;
  role: string;
  branchId: number;
}
