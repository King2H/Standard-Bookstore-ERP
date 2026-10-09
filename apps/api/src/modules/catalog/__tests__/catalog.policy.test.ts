import { describe, it, expect } from 'vitest';
import { Money } from '@bms/shared';
import { checkDeletable, checkSelectable, editsOf, isbnSearchForms, placeholderIsbn, storedIsbn } from '../catalog.policy.js';

describe('storedIsbn', () => {
  it('keeps a valid ISBN-13, without dashes or spaces', () => {
    expect(storedIsbn('978-0-306-40615-7')).toBe('9780306406157');
  });

  it('stores a valid ISBN-10 as its ISBN-13', () => {
    expect(storedIsbn('0-306-40615-2')).toBe('9780306406157');
    expect(storedIsbn('185326041x')).toBe('9781853260414');
  });

  it('refuses a wrong check digit in either form', () => {
    expect(() => storedIsbn('9780306406158')).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(() => storedIsbn('0306406153')).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });

  it('returns undefined for a blank ISBN', () => {
    expect(storedIsbn('')).toBeUndefined();
    expect(storedIsbn(undefined)).toBeUndefined();
  });
});

describe('isbnSearchForms', () => {
  it('finds a book scanned by its ISBN-10 under its ISBN-13 too', () => {
    expect(isbnSearchForms('0306406152')).toEqual(['0306406152', '9780306406157']);
    expect(isbnSearchForms('9780306406157')).toEqual(['9780306406157']);
  });
});

describe('placeholderIsbn', () => {
  it('uses the SKU, or the time when there is none', () => {
    expect(placeholderIsbn(' BK 001 ', 5)).toBe('SKU-BK-001');
    expect(placeholderIsbn(undefined, 5)).toBe('SKU-5');
  });
});

describe('checkSelectable', () => {
  it('lets only active records be linked', () => {
    expect(() => checkSelectable('Author', [{ id: 1, name: 'A', status: 'ACTIVE' }])).not.toThrow();
    expect(() => checkSelectable('Author', [{ id: 2, name: 'B', status: 'ARCHIVED' }])).toThrow(
      expect.objectContaining({ code: 'AUTHOR_NOT_SELECTABLE', statusCode: 422 }),
    );
  });
});

describe('editsOf', () => {
  it('lists the tracked fields that change, by column', () => {
    const existing = { title: 'Old', defaultPrice: Money.of('20'), genre: null, sku: 'X' };
    expect(editsOf(existing, { title: 'New', defaultPrice: 20, genre: 'Fiction', sku: 'Y' })).toEqual([
      { field: 'title', oldValue: 'Old', newValue: 'New' },
      { field: 'genre', oldValue: '', newValue: 'Fiction' },
    ]);
  });
});

describe('checkDeletable', () => {
  it('refuses a book anything refers to', () => {
    expect(() => checkDeletable({ sales: 0, orders: 0 })).not.toThrow();
    expect(() => checkDeletable({ sales: 1, orders: 0 })).toThrow(expect.objectContaining({ code: 'BOOK_IN_USE' }));
  });
});
