import type { Request } from 'express';
import { ReportQuerySchema, type ReportQuery } from '@bms/shared';
import { scopedBranchOrAll } from '../../lib/scope.js';
import { valid } from '../../middleware/validate.js';

// What every report family shares (#22): the scope a report covers and how
// it becomes SQL conditions.

/** A report's scope: the branch (undefined: all branches) and a date range, both ends included. */
export interface ReportScope {
  branchId?: number;
  dateFrom?: string;
  dateTo?: string;
}

export interface ReportFilters extends ReportScope {
  groupBy: 'day' | 'week' | 'month';
}

export const reportQuery = { query: ReportQuerySchema };

/**
 * The validated report query, with the branch from the session's scope: the
 * session's branch, or for staff with access to all branches the one they
 * pick, or all.
 */
export function reportFilters(req: Request): ReportFilters {
  const query: ReportQuery = valid(req, reportQuery).query;
  return { branchId: scopedBranchOrAll(req), dateFrom: query.dateFrom, dateTo: query.dateTo, groupBy: query.groupBy };
}

/**
 * `alias.branch_id = $n` and the date range on `alias.column`, compared as
 * dates so the last day of the range is included in full. `branchColumn`
 * is for tables whose branch is on a joined row (stock: the location).
 */
export function scopeConditions(
  scope: ReportScope,
  alias: string,
  opts: { column?: string; branchAlias?: string; params?: unknown[] } = {},
): { conditions: string[]; params: unknown[] } {
  const column = opts.column ?? 'created_at';
  const params = opts.params ?? [];
  const conditions: string[] = [];
  if (scope.branchId) {
    params.push(scope.branchId);
    conditions.push(`${opts.branchAlias ?? alias}.branch_id = $${params.length}`);
  }
  if (scope.dateFrom) {
    params.push(scope.dateFrom);
    conditions.push(`${alias}.${column}::date >= $${params.length}::date`);
  }
  if (scope.dateTo) {
    params.push(scope.dateTo);
    conditions.push(`${alias}.${column}::date <= $${params.length}::date`);
  }
  return { conditions, params };
}

/** `WHERE a AND b`, or nothing when there are no conditions. */
export function where(conditions: string[]): string {
  return conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
}
