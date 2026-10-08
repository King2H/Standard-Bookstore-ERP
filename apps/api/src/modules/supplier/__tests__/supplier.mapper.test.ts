import { describe, it, expect } from 'vitest';
import { BookSupplierSchema, SupplierSchema } from '@bms/shared';
import {
  toBookSupplierRecord,
  toBookSupplierResponse,
  toSupplierRecord,
  toSupplierResponse,
  type SupplierRow,
} from '../supplier.mapper.js';

const row: SupplierRow = {
  id: 7,
  name: 'Addis Books',
  contact_info: { phone: '0911000000' },
  lead_time_days: 5,
  pricing_terms: null,
  supplier_type: 'publisher',
  publisher_id: 3,
  publisher_name: 'Mega Publishing',
  is_active: false,
  is_blacklisted: true,
  status: 'ARCHIVED',
  archived_at: new Date('2026-10-01T08:00:00Z'),
  created_at: new Date('2026-01-15T10:30:00Z'),
};

describe('supplier mapper', () => {
  it('maps a row to a record in camelCase, keeping dates as Date', () => {
    expect(toSupplierRecord(row)).toEqual({
      id: 7,
      name: 'Addis Books',
      contactInfo: { phone: '0911000000' },
      leadTimeDays: 5,
      pricingTerms: null,
      supplierType: 'publisher',
      publisherId: 3,
      publisherName: 'Mega Publishing',
      isActive: false,
      isBlacklisted: true,
      status: 'ARCHIVED',
      archivedAt: new Date('2026-10-01T08:00:00Z'),
      createdAt: new Date('2026-01-15T10:30:00Z'),
    });
  });

  it('reads missing contact info as an empty object', () => {
    expect(toSupplierRecord({ ...row, contact_info: null }).contactInfo).toEqual({});
  });

  it('turns a record into a response that matches the shared contract', () => {
    const response = toSupplierResponse(toSupplierRecord(row));
    expect(response.archivedAt).toBe('2026-10-01T08:00:00.000Z');
    expect(response.createdAt).toBe('2026-01-15T10:30:00.000Z');
    expect(SupplierSchema.strict().parse(response)).toEqual(response);
  });

  it('keeps archivedAt null for a supplier that is not archived', () => {
    expect(toSupplierResponse(toSupplierRecord({ ...row, archived_at: null })).archivedAt).toBeNull();
  });

  it('maps a book-supplier link to a response that matches the shared contract', () => {
    const response = toBookSupplierResponse(
      toBookSupplierRecord({ book_id: 1, supplier_id: 7, supplier_name: 'Addis Books', supplier_sku: 'AB-1', is_primary: true }),
    );
    expect(response).toEqual({ bookId: 1, supplierId: 7, supplierName: 'Addis Books', supplierSku: 'AB-1', isPrimary: true });
    expect(BookSupplierSchema.strict().parse(response)).toEqual(response);
  });
});
