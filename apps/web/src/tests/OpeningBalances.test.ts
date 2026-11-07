// #246 part 3: what a customer owed when the shop started is a receivable of
// its own (opening_balance), collected in Payments by the receivable itself,
// like an exchange difference, with the methods that endpoint takes.
import { describe, it, expect } from 'vitest';
import { paymentsContext } from '../features/receivables/rules.js';
import { COLLECT_METHODS } from '../features/payments/rules.js';

describe('Opening balances on screen (#246)', () => {
  it('collects an opening balance in Payments by the receivable', () => {
    expect(paymentsContext({ id: '41', sourceType: 'opening_balance', sourceEntityId: '7' })).toEqual({ orderId: '41', sourceType: 'opening_balance' });
  });

  it('offers the methods the receivable endpoint takes', () => {
    expect(COLLECT_METHODS.opening_balance).toEqual(COLLECT_METHODS.exchange_difference);
  });
});
