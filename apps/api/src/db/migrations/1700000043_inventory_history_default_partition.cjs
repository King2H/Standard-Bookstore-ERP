'use strict';

// Fix: inventory_history partitioned table has no partition for dates beyond the
// original migration's +3-month lookahead. Any insert for a month not covered
// by an existing partition throws: "no partition of relation found".
//
// Solution: add a DEFAULT partition that catches all rows whose created_at falls
// outside the named partition ranges. Also extend coverage to the current month
// and the next 3 months from NOW (idempotent — uses IF NOT EXISTS equivalents).

exports.shorthands = undefined;

exports.up = function (pgm) {
  // Add a default partition — catches any date range not covered by named partitions.
  // This is the safest long-term fix: no inserts will ever fail due to missing partitions.
  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_inherits i ON i.inhrelid = c.oid
        JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname = 'inventory_history'
          AND c.relname = 'inventory_history_p_default'
      ) THEN
        CREATE TABLE inventory_history_p_default
          PARTITION OF inventory_history DEFAULT;
      END IF;
    END$$;
  `);

  // Also create named partitions for the current month + next 6 months so that
  // queries against those months benefit from partition pruning (performance).
  // Each CREATE is wrapped in a DO block so it is idempotent.
  //
  // Bug fix: the original version only checked for a partition with the same
  // NAME before creating one, but the base table (1700000014_create_inventory)
  // already has fixed-name partitions — inventory_history_p_cur, _p_prev,
  // _p_next1, _p_next2 — covering "now()" at the time THAT migration ran. If
  // this migration runs in the same calendar month (guaranteed on any fresh
  // install, since 1700000014 and 1700000043 both apply in the same batch),
  // its i=0 iteration computes the exact same date range as the pre-existing
  // _p_cur partition. Postgres correctly rejects the CREATE TABLE with
  // "would overlap partition inventory_history_p_cur" — but node-pg-migrate
  // runs the whole pending batch in one transaction, so that single error
  // rolled back every migration in the run, including ones with no bugs.
  // On a database that had already been migrated up through 1700000014 in an
  // earlier calendar month, no overlap occurs and the old code worked fine —
  // which is how this shipped without being caught.
  //
  // Fix: catch the overlap error per-partition instead of asserting no
  // partition exists by name. A range already covered by ANY partition
  // (named or default) means there is nothing to do for that month, so we
  // log and move on rather than aborting the migration.
  pgm.sql(`
    DO $$
    DECLARE
      i INTEGER;
      p_start TIMESTAMPTZ;
      p_end   TIMESTAMPTZ;
      p_name  TEXT;
    BEGIN
      FOR i IN 0..6 LOOP
        p_start := date_trunc('month', now()) + (i || ' months')::interval;
        p_end   := p_start + interval '1 month';
        p_name  := 'inventory_history_p_' || to_char(p_start, 'YYYY_MM');

        -- Skip if a partition with this exact name already exists
        IF NOT EXISTS (
          SELECT 1 FROM pg_class c
          JOIN pg_inherits inh ON inh.inhrelid = c.oid
          JOIN pg_class par ON par.oid = inh.inhparent
          WHERE par.relname = 'inventory_history'
            AND c.relname = p_name
        ) THEN
          BEGIN
            EXECUTE format(
              'CREATE TABLE %I PARTITION OF inventory_history FOR VALUES FROM (%L) TO (%L)',
              p_name, p_start, p_end
            );
          EXCEPTION
            -- 42P17 = invalid_table_definition, raised by Postgres as
            -- "would overlap partition X" when the range is already covered
            -- by a differently-named partition (e.g. inventory_history_p_cur).
            -- Matched by SQLSTATE directly — Postgres 16 does not expose this
            -- code under the documented condition-name alias in PL/pgSQL.
            -- 42P07 = duplicate_table, in case of a concurrent/racing create.
            WHEN SQLSTATE '42P17' OR SQLSTATE '42P07' THEN
              RAISE NOTICE 'Skipping partition %: range already covered by an existing partition', p_name;
          END;
        END IF;
      END LOOP;
    END$$;
  `);
};

exports.down = function (pgm) {
  // Drop the default partition only — leave named partitions in place
  pgm.sql(`DROP TABLE IF EXISTS inventory_history_p_default`);
};
