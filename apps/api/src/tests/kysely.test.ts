import { describe, it, expect } from 'vitest';
import { sql } from 'kysely';
import { kysely } from '../db/kysely.js';

describe('Kysely', () => {
  it('queries through the shared pool with generated column types', async () => {
    const branch = await kysely
      .selectFrom('branches')
      .select(['id', 'name', 'is_active'])
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();

    expect(branch).toEqual({ id: 1, name: 'Main Branch', is_active: true });
  });

  it('returns numeric values as exact strings, never floats', async () => {
    const row = await kysely
      .selectNoFrom(sql<string>`0.10::numeric + 0.20::numeric`.as('amount'))
      .executeTakeFirstOrThrow();

    expect(row.amount).toBe('0.30');
  });
});
