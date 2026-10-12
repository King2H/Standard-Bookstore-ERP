import type { PublisherListResponse } from '@bms/shared';
import { api, toQuery } from '../../lib/api.js';

/** Catalog reference data (#21): only what the migrated features use so far. */

/** Active publishers whose name starts with `q`, for a picker. */
export const searchPublishers = (q: string, pageSize = 20) =>
  api.get<PublisherListResponse>(`/publishers${toQuery({ q, pageSize })}`);
