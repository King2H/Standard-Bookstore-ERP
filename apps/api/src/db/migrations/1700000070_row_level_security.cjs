'use strict';

// Tenancy, part 3 (#13, ADR-0003): the database keeps tenants apart even if
// the application forgets to.
//
// - bms_app: the role the API works as (owner decision 1a). It cannot log in
//   itself; each environment adds its own login user to it, with its own
//   password (`npm run db:app-role`), so no password lives here. Migrations
//   keep running as the owner, which also owns every table and function.
// - Row-level security on every table with a tenant_id: a row is seen and
//   written only by work of its tenant (app.tenant_id, set on every
//   connection by the API). Work without a tenant sees and writes nothing.
// - Two narrow functions run as the owner for sign-in, before any tenant is
//   known: the tenant of a username, and of a refresh token. Nothing else.

exports.shorthands = undefined;

const TENANT = `NULLIF(current_setting('app.tenant_id', true), '')::integer`;

// Every table with a tenant_id, partitions included (they are reached through
// their parent, but are closed directly too).
const FOR_EACH_TENANT_TABLE = (body) => `
  DO $$
  DECLARE t text;
  BEGIN
    FOR t IN
      SELECT c.relname FROM pg_class c
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
    LOOP
      ${body}
    END LOOP;
  END $$;
`;

exports.up = function (pgm) {
  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bms_app') THEN
        CREATE ROLE bms_app NOLOGIN;
      END IF;
    END $$;

    GRANT USAGE ON SCHEMA public TO bms_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bms_app;
    GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO bms_app;
    -- Tenants are managed by the owner (sign-up, #28); the app only lists them.
    REVOKE INSERT, UPDATE, DELETE ON tenants FROM bms_app;
    REVOKE ALL ON pgmigrations FROM bms_app;
    -- Tables and sequences later migrations create.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bms_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO bms_app;
  `);

  pgm.sql(FOR_EACH_TENANT_TABLE(`
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I USING (tenant_id = ${TENANT.replace(/'/g, "''")}) WITH CHECK (tenant_id = ${TENANT.replace(/'/g, "''")})',
        t
      );
  `));

  pgm.sql(`
    CREATE FUNCTION auth_tenant_of_username(p_username text) RETURNS integer
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
      AS $$ SELECT tenant_id FROM staff WHERE lower(username) = lower(p_username) $$;

    CREATE FUNCTION auth_tenant_of_refresh_token(p_token_hash text) RETURNS integer
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
      AS $$
        SELECT ss.tenant_id FROM refresh_tokens rt JOIN staff_sessions ss ON ss.id = rt.session_id
        WHERE rt.token_hash = p_token_hash
      $$;

    REVOKE ALL ON FUNCTION auth_tenant_of_username(text), auth_tenant_of_refresh_token(text) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION auth_tenant_of_username(text), auth_tenant_of_refresh_token(text) TO bms_app;
  `);
};

exports.down = function (pgm) {
  pgm.sql(`
    DROP FUNCTION auth_tenant_of_refresh_token(text);
    DROP FUNCTION auth_tenant_of_username(text);
  `);
  pgm.sql(FOR_EACH_TENANT_TABLE(`
      EXECUTE format('DROP POLICY tenant_isolation ON %I', t);
      EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
  `));
  // The role is shared by every database on the server, so it stays; this
  // database's grants to it go.
  pgm.sql(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM bms_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM bms_app;
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM bms_app;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM bms_app;
    REVOKE USAGE ON SCHEMA public FROM bms_app;
  `);
};
