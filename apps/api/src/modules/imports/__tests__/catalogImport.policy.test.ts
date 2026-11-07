import { describe, it, expect } from 'vitest';
import { readCsv, cellText } from '../../../lib/csvRead.js';
import { readCatalogRow, readHeader, readPrice } from '../catalogImport.policy.js';

// The rules of a catalog file (#246), without a database.

describe('reading a CSV file', () => {
  it('keeps quoted delimiters, quotes and line breaks, and numbers rows by their first line', () => {
    const file = readCsv('\uFEFFA,B\r\n"x, y","say ""hi"""\r\n\r\n"two\nlines",z\n');
    expect(file.header).toEqual(['A', 'B']);
    expect(file.rows).toEqual([{ line: 2, cells: ['x, y', 'say "hi"'] }, { line: 4, cells: ['two\nlines', 'z'] }]);
  });

  it('takes the delimiter of the header line', () => {
    expect(readCsv('A;B\n1,5;2').rows[0].cells).toEqual(['1,5', '2']);
  });

  it('drops the apostrophe an export puts before a formula, and only that', () => {
    expect(cellText("'=SUM(A1)")).toBe('=SUM(A1)');
    expect(cellText("'quoted")).toBe("'quoted");
  });
});

describe('a catalog row', () => {
  const { index } = readHeader(['ISBN', 'SKU', 'Title', 'Price']);

  it('refuses unknown columns, and a file without Title or a key column', () => {
    expect(readHeader(['Title', 'Colour']).errors).toEqual([
      expect.stringMatching(/Unknown column 'Colour'/),
      expect.stringMatching(/neither an ISBN nor a SKU/),
    ]);
  });

  it('stores an ISBN-10 as its ISBN-13, and a book without one under its SKU', () => {
    expect(readCatalogRow(['0-306-40615-2', '', 'T', ''], index, 2, false).row).toMatchObject({ key: '9780306406157' });
    expect(readCatalogRow(['', 'BK 1', 'T', ''], index, 2, false).row).toMatchObject({ key: 'SKU-BK-1', sku: 'BK 1' });
    expect(readCatalogRow(['SKU-BK-1', '', 'T', ''], index, 2, false).row).toMatchObject({ key: 'SKU-BK-1', sku: 'BK-1' });
  });

  it('reads a price with at most two decimals, with a decimal comma only in a semicolon file', () => {
    expect(readPrice('12.5', false)).toBe('12.50');
    expect(readPrice('12,50', true)).toBe('12.50');
    expect(readPrice('12,50', false)).toBeNull();
    expect(readPrice('1.234', false)).toBeNull();
    expect(readPrice('-3', false)).toBeNull();
  });
});
