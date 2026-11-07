import type { LifecycleStatus } from '@bms/shared';
import type { Queryable } from '../../db/tx.js';

// Lookups of the catalog import (#246): one query per list, whatever the
// size of the file.

export interface NamedRecord {
  id: number;
  name: string;
  status: LifecycleStatus;
}

/** Authors or categories by their lower-cased name. */
export async function namesByNormalized(q: Queryable, table: 'authors' | 'categories', normalized: string[]): Promise<Map<string, NamedRecord>> {
  if (normalized.length === 0) return new Map();
  const rows = await q.selectFrom(table).select(['id', 'name', 'status', 'normalized_name']).where('normalized_name', 'in', normalized).execute();
  return new Map(rows.map((r) => [r.normalized_name, { id: r.id, name: r.name, status: r.status as LifecycleStatus }]));
}

/** Every publisher, by its lower-cased name (a shop has tens, not thousands). */
export async function publishers(q: Queryable): Promise<Map<string, NamedRecord>> {
  const rows = await q.selectFrom('publishers').select(['id', 'name', 'status']).execute();
  return new Map(rows.map((r) => [r.name.toLowerCase(), { id: r.id, name: r.name, status: r.status as LifecycleStatus }]));
}
