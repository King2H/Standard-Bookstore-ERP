import type pg from 'pg';
import { CHECKS, type Check, type Severity } from './rules.js';

/** One rule's findings in one tenant: how many rows break it, and a few of them. */
export interface Finding {
  check: Check;
  tenantId: number;
  count: number;
  examples: string[];
}

const EXAMPLES = 5;

/**
 * Runs every rule on `client` and returns what breaks them. The caller owns
 * the transaction: the command opens a read-only one, tests one they roll back.
 */
export async function runChecks(client: pg.ClientBase, checks: readonly Check[] = CHECKS): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const check of checks) {
    const { rows } = await client.query<{ tenant_id: number; count: string; examples: string[] }>(
      `SELECT tenant_id, COUNT(*) AS count, (ARRAY_AGG(ref ORDER BY ref))[1:${EXAMPLES}] AS examples
       FROM (${check.sql}) broken GROUP BY tenant_id ORDER BY tenant_id`,
    );
    for (const row of rows) {
      findings.push({ check, tenantId: row.tenant_id, count: Number(row.count), examples: row.examples });
    }
  }
  return findings;
}

const count = (findings: Finding[], severity: Severity) =>
  findings.filter((f) => f.check.severity === severity).reduce((n, f) => n + f.count, 0);

/** The report the command prints: every rule, passed or not, then a summary line. */
export function formatReport(findings: Finding[], checks: readonly Check[] = CHECKS): string {
  const lines: string[] = [];
  let area = '';
  for (const check of checks) {
    if (check.area !== area) {
      area = check.area;
      lines.push('', area);
    }
    const broken = findings.filter((f) => f.check.id === check.id);
    if (broken.length === 0) {
      lines.push(`  ok     ${check.title}`);
      continue;
    }
    lines.push(`  ${check.severity === 'error' ? 'ERROR ' : 'warn  '} ${check.title} [${check.id}]`);
    for (const f of broken) {
      lines.push(`         tenant ${f.tenantId}: ${f.count} row(s)`);
      for (const example of f.examples) lines.push(`           - ${example}`);
    }
  }
  const errors = count(findings, 'error');
  const warnings = count(findings, 'warning');
  lines.push('', `${checks.length} rules: ${errors} error row(s), ${warnings} warning row(s).`);
  return lines.join('\n');
}

/** 1 when any error-level rule is broken (an upgrade should stop), else 0. */
export function exitCode(findings: Finding[]): number {
  return findings.some((f) => f.check.severity === 'error') ? 1 : 0;
}
