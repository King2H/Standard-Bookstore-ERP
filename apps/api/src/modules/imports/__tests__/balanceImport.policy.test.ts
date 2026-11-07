import { describe, it, expect } from 'vitest';
import { balanceDecision, readCustomerBalanceHeader, readCustomerBalanceRow, readDay, readSupplierBalanceHeader, readSupplierBalanceRow } from '../balanceImport.policy.js';

// The rules of the opening balance files (#246 part 3), without a database.

describe('opening balances', () => {
  it('reads a due date only as an existing YYYY-MM-DD day', () => {
    expect(readDay('2026-12-31')).toBe('2026-12-31');
    expect(readDay('2026-02-30')).toBeNull();
    expect(readDay('31/12/2026')).toBeNull();
  });

  it('needs a due date only for what is owed', () => {
    const { index } = readCustomerBalanceHeader(['Code', 'Amount Owed', 'Due Date', 'Store Credit']);
    expect(readCustomerBalanceRow(['CUS-1', '10', '', ''], index, 2, false).messages).toEqual([expect.stringMatching(/Due Date is empty/)]);
    expect(readCustomerBalanceRow(['CUS-1', '', '', '50'], index, 2, false).row).toMatchObject({ storeCredit: '50.00', owed: undefined });
  });

  it('takes a supplier balance above 0 only', () => {
    const { index } = readSupplierBalanceHeader(['Supplier', 'Amount Owed']);
    expect(readSupplierBalanceRow(['Mega', '0'], index, 2, false).messages).toEqual([expect.stringMatching(/more than 0/)]);
    expect(readSupplierBalanceRow(['Mega', '12,50'], index, 2, true).row).toMatchObject({ owed: '12.50' });
  });

  it('brings a balance in once: the same one again is unchanged, another is refused', () => {
    expect(balanceDecision(undefined, undefined)).toBe('none');
    expect(balanceDecision('0.00', undefined)).toBe('none');
    expect(balanceDecision('10.00', undefined)).toBe('new');
    expect(balanceDecision('10.00', '10')).toBe('same');
    expect(balanceDecision(350, 300)).toBe('different');
  });
});
