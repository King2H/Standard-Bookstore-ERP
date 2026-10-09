'use strict';

// Publisher names unique ignoring letter case and surrounding spaces, like
// authors and categories (#21, owner decision): "Penguin" and "penguin " are
// the same publisher. A database that already holds such duplicates stops
// here and names them; an admin moves their books to one of them and deletes
// the rest, then runs the migration again. The code cannot know which to keep.

exports.shorthands = undefined;

exports.up = async function (pgm) {
  const { rows } = await pgm.db.query(
    `SELECT lower(btrim(name)) AS name, string_agg(id::text || ' "' || name || '"', ', ' ORDER BY id) AS publishers
     FROM publishers GROUP BY lower(btrim(name)) HAVING COUNT(*) > 1`,
  );
  if (rows.length > 0) {
    throw new Error(
      'Publishers with the same name in different letter case must be merged before this migration: ' +
        rows.map((r) => r.publishers).join('; '),
    );
  }
  pgm.sql('CREATE UNIQUE INDEX publishers_name_ci_key ON publishers (lower(btrim(name)))');
};

exports.down = function (pgm) {
  pgm.sql('DROP INDEX publishers_name_ci_key');
};
