import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';

// Migrations are the only source of schema truth (ADR-0001, #17): application
// code never inspects the schema or changes it at runtime.
const srcDir = resolve(__dirname, '..');
const FORBIDDEN = [
  /information_schema/i,
  /pg_catalog|pg_constraint|pg_class|to_regclass/i,
  /\b(CREATE|ALTER|DROP)\s+(TABLE|INDEX|TYPE|SCHEMA|COLUMN)\b/i,
  /\bADD\s+COLUMN\b/i,
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return ['tests', '__tests__', 'migrations'].includes(name) ? [] : sourceFiles(path);
    }
    return path.endsWith('.ts') ? [path] : [];
  });
}

describe('Runtime schema access', () => {
  it('no application code inspects or changes the database schema', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(srcDir)) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (FORBIDDEN.some((pattern) => pattern.test(line))) offenders.push(`${relative(srcDir, file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
