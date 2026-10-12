import { describe, it, expect } from 'vitest';
import { resolveTestDatabaseUrl, resolveTestMigrationUrl } from './testDatabaseUrl.js';

describe('resolveTestDatabaseUrl', () => {
  it('derives <name>_test from DATABASE_URL, keeping server and credentials', () => {
    expect(resolveTestDatabaseUrl({ DATABASE_URL: 'postgres://bms:s3cret@db.local:5433/bms' }))
      .toBe('postgres://bms:s3cret@db.local:5433/bms_test');
  });

  it('keeps a DATABASE_URL that already points at a _test database', () => {
    expect(resolveTestDatabaseUrl({ DATABASE_URL: 'postgres://bms:bms@localhost:5433/bms_test' }))
      .toBe('postgres://bms:bms@localhost:5433/bms_test');
  });

  it('prefers TEST_DATABASE_URL when it is set', () => {
    expect(resolveTestDatabaseUrl({
      DATABASE_URL: 'postgres://bms:bms@localhost:5433/bms',
      TEST_DATABASE_URL: 'postgres://ci:ci@ci-db:5432/erp_test',
    })).toBe('postgres://ci:ci@ci-db:5432/erp_test');
  });

  it('refuses a TEST_DATABASE_URL whose database name does not end in _test', () => {
    expect(() => resolveTestDatabaseUrl({ TEST_DATABASE_URL: 'postgres://bms:bms@localhost:5433/bms' }))
      .toThrow(/must end in "_test"/);
  });
});

describe('resolveTestMigrationUrl', () => {
  it("uses the owner's credentials for the test database", () => {
    expect(resolveTestMigrationUrl({
      DATABASE_URL: 'postgres://bms_api:api@localhost:5433/bms',
      MIGRATION_DATABASE_URL: 'postgres://bms:owner@localhost:5433/bms',
    })).toBe('postgres://bms:owner@localhost:5433/bms_test');
  });

  it('asks for MIGRATION_DATABASE_URL when it is missing', () => {
    expect(() => resolveTestMigrationUrl({ DATABASE_URL: 'postgres://bms_api:api@localhost:5433/bms' }))
      .toThrow(/MIGRATION_DATABASE_URL/);
  });
});
