import { describe, it, expect } from 'vitest';
import {
  checkDeletable,
  checkSupplierType,
  checkUsableForProcurement,
  lifecycleTransition,
  statusesFor,
  typeAfterUpdate,
} from '../supplier.policy.js';

describe('checkSupplierType', () => {
  it('accepts a publisher supplier with a publisher and an external one without', () => {
    expect(() => checkSupplierType('publisher', 3)).not.toThrow();
    expect(() => checkSupplierType('external', null)).not.toThrow();
  });

  it('requires a publisher for a publisher supplier', () => {
    expect(() => checkSupplierType('publisher', null)).toThrow(
      expect.objectContaining({ code: 'PUBLISHER_ID_REQUIRED', statusCode: 422 }),
    );
  });

  it('refuses a publisher on an external supplier', () => {
    expect(() => checkSupplierType('external', 3)).toThrow(
      expect.objectContaining({ code: 'PUBLISHER_ID_NOT_ALLOWED', statusCode: 422 }),
    );
  });
});

describe('typeAfterUpdate', () => {
  const current = { supplierType: 'publisher' as const, publisherId: 3 };

  it('is null when the update changes neither type nor publisher', () => {
    expect(typeAfterUpdate(current, {})).toBeNull();
  });

  it('fills the unchanged side from the current values', () => {
    expect(typeAfterUpdate(current, { publisherId: 5 })).toEqual({ supplierType: 'publisher', publisherId: 5 });
    expect(typeAfterUpdate(current, { supplierType: 'external' })).toEqual({ supplierType: 'external', publisherId: 3 });
  });

  it('treats an explicit null publisher as a change', () => {
    expect(typeAfterUpdate(current, { supplierType: 'external', publisherId: null })).toEqual({
      supplierType: 'external',
      publisherId: null,
    });
  });
});

describe('lifecycleTransition', () => {
  it('keeps is_active true only for ACTIVE, and marks only ARCHIVE as archived', () => {
    expect(lifecycleTransition('ACTIVATE')).toEqual({ status: 'ACTIVE', isActive: true, archived: false });
    expect(lifecycleTransition('INACTIVATE')).toEqual({ status: 'INACTIVE', isActive: false, archived: false });
    expect(lifecycleTransition('ARCHIVE')).toEqual({ status: 'ARCHIVED', isActive: false, archived: true });
    expect(lifecycleTransition('RESTORE')).toEqual({ status: 'ACTIVE', isActive: true, archived: false });
  });
});

describe('statusesFor', () => {
  it('maps the list filter to statuses, with "all" meaning no filter', () => {
    expect(statusesFor('active')).toEqual(['ACTIVE']);
    expect(statusesFor('inactive')).toEqual(['INACTIVE']);
    expect(statusesFor('archived')).toEqual(['ARCHIVED']);
    expect(statusesFor('all')).toBeUndefined();
  });
});

describe('checkUsableForProcurement', () => {
  it('accepts an active supplier that is not blacklisted', () => {
    expect(() => checkUsableForProcurement({ isActive: true, isBlacklisted: false })).not.toThrow();
  });

  it('refuses an inactive supplier first, then a blacklisted one', () => {
    expect(() => checkUsableForProcurement({ isActive: false, isBlacklisted: true })).toThrow(
      expect.objectContaining({ code: 'SUPPLIER_INACTIVE' }),
    );
    expect(() => checkUsableForProcurement({ isActive: true, isBlacklisted: true })).toThrow(
      expect.objectContaining({ code: 'SUPPLIER_BLACKLISTED' }),
    );
  });
});

describe('checkDeletable', () => {
  it('allows deleting a supplier without purchase orders', () => {
    expect(() => checkDeletable({ purchaseOrders: 0 })).not.toThrow();
  });

  it('refuses with 409 and the purchase order count', () => {
    expect(() => checkDeletable({ purchaseOrders: 2 })).toThrow(
      expect.objectContaining({ code: 'DEPENDENCY_CONFLICT', statusCode: 409, details: { poCount: 2 } }),
    );
  });
});
