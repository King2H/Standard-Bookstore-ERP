import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';

// Error codes are part of the API contract (ADR-0004): every code the API can
// return must be listed in docs/v2/api-errors.md.
const srcDir = resolve(__dirname, '..');
const docPath = resolve(__dirname, '../../../../docs/v2/api-errors.md');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'tests' ? [] : sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

function codesInSource(): Set<string> {
  const codes = new Set<string>();
  const patterns = [
    /new (?:AppError|AuthError|ConflictError|BusinessError)\(\s*'([A-Z_]+)'/g,
    /super\(\s*'([A-Z_]+)'/g,
    /error: '([A-Z_]+)'/g,
  ];
  for (const file of sourceFiles(srcDir)) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) codes.add(match[1]);
    }
  }
  return codes;
}

describe('API error codes', () => {
  it('are all documented in docs/v2/api-errors.md', () => {
    const documented = new Set([...readFileSync(docPath, 'utf8').matchAll(/`([A-Z_]{3,})`/g)].map((m) => m[1]));
    const missing = [...codesInSource()].filter((code) => !documented.has(code)).sort();
    expect(missing).toEqual([]);
  });
});
