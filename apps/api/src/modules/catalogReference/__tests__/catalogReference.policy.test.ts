import { describe, it, expect } from 'vitest';
import { checkCategoryParent, nextStatus, normalizeName, statusesFor } from '../catalogReference.policy.js';

describe('statusesFor', () => {
  it('shows active records unless asked for others', () => {
    expect(statusesFor(undefined)).toEqual(['ACTIVE']);
    expect(statusesFor('active')).toEqual(['ACTIVE']);
    expect(statusesFor('inactive')).toEqual(['INACTIVE']);
    expect(statusesFor('archived')).toEqual(['ARCHIVED']);
    expect(statusesFor('all')).toBeUndefined();
  });
});

describe('normalizeName', () => {
  it('ignores letter case and surrounding spaces', () => {
    expect(normalizeName('  Penguin Books ')).toBe('penguin books');
  });
});

describe('nextStatus', () => {
  const refused = expect.objectContaining({ code: 'INVALID_LIFECYCLE_TRANSITION', statusCode: 422 });

  it('switches between active and inactive', () => {
    expect(nextStatus('ACTIVE', 'INACTIVATE')).toBe('INACTIVE');
    expect(nextStatus('INACTIVE', 'ACTIVATE')).toBe('ACTIVE');
  });

  it('archives from active or inactive', () => {
    expect(nextStatus('ACTIVE', 'ARCHIVE')).toBe('ARCHIVED');
    expect(nextStatus('INACTIVE', 'ARCHIVE')).toBe('ARCHIVED');
  });

  it('brings an archived record back only by restoring it, to active', () => {
    expect(nextStatus('ARCHIVED', 'RESTORE')).toBe('ACTIVE');
    expect(() => nextStatus('ARCHIVED', 'ACTIVATE')).toThrow(refused);
    expect(() => nextStatus('ARCHIVED', 'INACTIVATE')).toThrow(refused);
  });

  it('restores only an archived record', () => {
    expect(() => nextStatus('INACTIVE', 'RESTORE')).toThrow(refused);
  });

  it('returns null when the record already has the status', () => {
    expect(nextStatus('ACTIVE', 'ACTIVATE')).toBeNull();
    expect(nextStatus('ACTIVE', 'RESTORE')).toBeNull();
    expect(nextStatus('INACTIVE', 'INACTIVATE')).toBeNull();
    expect(nextStatus('ARCHIVED', 'ARCHIVE')).toBeNull();
  });
});

describe('checkCategoryParent', () => {
  it('accepts a parent outside the category\'s own branch of the tree', () => {
    expect(() => checkCategoryParent(5, [3, 1])).not.toThrow();
  });

  it('refuses the category itself or one of its subcategories', () => {
    expect(() => checkCategoryParent(5, [5])).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(() => checkCategoryParent(5, [9, 7, 5, 1])).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });
});
