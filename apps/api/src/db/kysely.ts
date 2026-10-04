import { Kysely, PostgresDialect } from 'kysely';
import { db } from './index.js';
import type { DB } from './types.generated.js';

// Shares the v1 pg pool, so Kysely queries and existing `pg` code use the same
// connections while modules move to repositories one at a time (ADR-0002).
// Column types come from src/db/types.generated.ts: regenerate with
// `npm run db:types` after adding a migration.
export const kysely = new Kysely<DB>({
  dialect: new PostgresDialect({ pool: db }),
});

export type { DB };
