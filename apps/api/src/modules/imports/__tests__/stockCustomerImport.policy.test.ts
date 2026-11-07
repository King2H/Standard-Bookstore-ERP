import { describe, it, expect } from 'vitest';
import { readCustomerRow, readCustomerHeader } from '../customerImport.policy.js';
import { readStockHeader, readStockRow, stockDecision, type StockRow } from '../openingStockImport.policy.js';

// The rules of opening stock and customer files (#246), without a database.

describe('an opening stock row', () => {
  const { index } = readStockHeader(['ISBN', 'Location', 'Quantity', 'Unit Cost', 'Reorder Point']);
  const row = (quantity: number, unitCost?: string, reorderPoint?: number): StockRow => ({ line: 2, key: 'K', location: 'Front', quantity, unitCost, reorderPoint });

  it('reads a cost with up to four decimals, and refuses a negative quantity', () => {
    expect(readStockRow(['9780306406157', 'Front', '3', '12.3456', ''], index, 2, false).row).toMatchObject({ quantity: 3, unitCost: '12.3456' });
    expect(readStockRow(['9780306406157', 'Front', '-1', '1', ''], index, 2, false).messages).toEqual([expect.stringMatching(/Quantity/)]);
  });

  it('is opening stock only where nothing ever moved; then the same quantity is unchanged and another is refused', () => {
    expect(stockDecision(undefined, row(5, '10'))).toMatchObject({ action: 'create', stock: true });
    expect(stockDecision(undefined, row(5))).toMatchObject({ message: expect.stringMatching(/Unit Cost is empty/) });
    const moved = { quantity: 5, reorderPoint: 0, hasHistory: true };
    expect(stockDecision(moved, row(5, '10'))).toMatchObject({ action: 'unchanged', stock: false });
    expect(stockDecision(moved, row(6, '10'))).toMatchObject({ message: expect.stringMatching(/stock count/) });
    expect(stockDecision(moved, row(5, undefined, 4))).toMatchObject({ action: 'update', reorder: true });
  });
});

describe('a customer row', () => {
  const { index } = readCustomerHeader(['Code', 'Name', 'Phone', 'Email']);

  it('needs a code, a phone or an email to be found again', () => {
    expect(readCustomerRow(['', 'Name Only', '', ''], index, 2).messages).toEqual([expect.stringMatching(/a Code, a Phone or an Email/)]);
    expect(readCustomerRow(['', 'A', "'+251911000111", ''], index, 2).row).toMatchObject({ phone: '+251911000111' });
  });
});
