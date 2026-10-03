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
