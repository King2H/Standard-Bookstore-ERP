import pg from 'pg';

/**
 * Makes sure the user the API logs in as (DATABASE_URL) exists and works as
 * bms_app, the role row-level security applies to (#13, owner decision 1a).
 * Run with the owner's connection (MIGRATION_DATABASE_URL) after migrating;
 * the user's name and password come from DATABASE_URL, so each environment
 * keeps its own and none lives in the repository.
 */
export async function ensureAppLogin(ownerUrl: string, appUrl: string): Promise<void> {
  const app = new URL(appUrl);
  const user = decodeURIComponent(app.username);
  const password = decodeURIComponent(app.password);
  if (!user || !password) throw new Error('DATABASE_URL must name the API login user and its password');
  const owner = new URL(ownerUrl);
  if (decodeURIComponent(owner.username) === user) {
    throw new Error('DATABASE_URL and MIGRATION_DATABASE_URL name the same user: the API must log in as its own user (docs/development.md)');
  }

  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    const role = client.escapeIdentifier(user);
    const secret = client.escapeLiteral(password);
    const exists = (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [user])).rowCount! > 0;
    await client.query(`${exists ? 'ALTER' : 'CREATE'} ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${secret}`);
    await client.query(`GRANT bms_app TO ${role}`);
  } finally {
    await client.end();
  }
}
