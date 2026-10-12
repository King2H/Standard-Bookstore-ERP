/**
 * The API tests run against their own database, never the development one.
 *
 * - TEST_DATABASE_URL, if set, is used as is.
 * - Otherwise DATABASE_URL is reused with "_test" appended to the database
 *   name (bms -> bms_test), on the same server and with the same credentials.
 *
 * As a safety net, the database name must end in "_test": the suite creates
 * and deletes data freely and must never run against real data.
 */
export function resolveTestDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.TEST_DATABASE_URL ?? env.DATABASE_URL ?? 'postgres://bms:bms@localhost:5433/bms';
  const url = new URL(base);
  let name = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!env.TEST_DATABASE_URL && !name.endsWith('_test')) {
    name = `${name}_test`;
  }
  if (!name.endsWith('_test')) {
    throw new Error(
      `Refusing to run tests against database "${name}": test database names must end in "_test".`,
    );
  }
  url.pathname = `/${encodeURIComponent(name)}`;
  return url.toString();
}

/**
 * The owner's connection to the test database: MIGRATION_DATABASE_URL's
 * server and credentials, the test database's name. The suite creates and
 * migrates the database with it, while the tests themselves work as the
 * API's user, under row-level security (#13).
 */
export function resolveTestMigrationUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (!env.MIGRATION_DATABASE_URL) {
    throw new Error(
      'MIGRATION_DATABASE_URL is not set: the tests need the database owner to create and migrate the test database (docs/development.md).',
    );
  }
  const url = new URL(env.MIGRATION_DATABASE_URL);
  url.pathname = new URL(resolveTestDatabaseUrl(env)).pathname;
  return url.toString();
}
