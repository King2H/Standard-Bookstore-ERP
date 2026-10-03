import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { getTestApp } from './helpers/testApp.js';

// Bank Accounts must stay unreachable unless FEATURE_BANK_ACCOUNTS=true.
// Without the switch the routes are not mounted, so even an unauthenticated
// request gets 404 rather than 401.
delete process.env.FEATURE_BANK_ACCOUNTS;

describe('Bank Accounts feature switch', () => {
  it('is off by default: bank account routes return 404', async () => {
    const res = await request(getTestApp()).get('/api/branches/1/bank-accounts');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });
});
