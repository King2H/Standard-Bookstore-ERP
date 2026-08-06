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

        -- Skip if this partition already exists
        IF NOT EXISTS (
          SELECT 1 FROM pg_class c
          JOIN pg_inherits inh ON inh.inhrelid = c.oid
          JOIN pg_class par ON par.oid = inh.inhparent
          WHERE par.relname = 'inventory_history'
            AND c.relname = p_name
        ) THEN
          EXECUTE format(
            'CREATE TABLE %I PARTITION OF inventory_history FOR VALUES FROM (%L) TO (%L)',
            p_name, p_start, p_end
          );
        END IF;
      END LOOP;
    END$$;
  `);
};

exports.down = function (pgm) {
  // Drop the default partition only — leave named partitions in place
  pgm.sql(`DROP TABLE IF EXISTS inventory_history_p_default`);
};
