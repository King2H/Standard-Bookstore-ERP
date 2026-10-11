'use strict';

// Usernames are unique ignoring letter case (#21, auth part 2, owner decision
// 4a), and signing in ignores case too: "ABC" and "abc" were two accounts.
//
// Stops, naming them, if the database already holds usernames that differ
// only in case; rename one of each and run the migration again.

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.sql(`
    DO $$
    DECLARE clashes TEXT;
    BEGIN
      SELECT string_agg(names, '; ') INTO clashes
      FROM (SELECT string_agg(username, ', ' ORDER BY id) AS names FROM staff GROUP BY lower(username) HAVING count(*) > 1) c;
      IF clashes IS NOT NULL THEN
        RAISE EXCEPTION 'Usernames that differ only in letter case: %. Rename one of each, then migrate again.', clashes;
      END IF;
    END $$;

    CREATE UNIQUE INDEX staff_username_lower_key ON staff (lower(username));
  `);
};

exports.down = function (pgm) {
  pgm.sql(`DROP INDEX staff_username_lower_key;`);
};
