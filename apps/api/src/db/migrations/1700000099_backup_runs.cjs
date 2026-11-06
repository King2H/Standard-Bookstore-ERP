'use strict';

// Backups of an on-premise install (#244, owner decisions 1a, 3a).
//
// The backup service records each run: when, whether it worked, the file it
// wrote or the error. Admin and Super_Admin are warned when there has been no
// good backup for 26 hours. A backup is of the whole install, every tenant,
// so the table belongs to none (like pgmigrations). The service writes it as
// the database owner; the API only reads it.

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.sql(`
    CREATE TABLE backup_runs (
      id bigserial PRIMARY KEY,
      started_at timestamptz NOT NULL,
      finished_at timestamptz NOT NULL,
      ok boolean NOT NULL,
      file_name text,
      bytes bigint,
      error text,
      CHECK (ok = (file_name IS NOT NULL)),
      CHECK (ok OR error IS NOT NULL)
    );
    CREATE INDEX backup_runs_finished_at ON backup_runs (finished_at DESC);
    REVOKE INSERT, UPDATE, DELETE ON backup_runs FROM bms_app;
    REVOKE USAGE, UPDATE ON SEQUENCE backup_runs_id_seq FROM bms_app;
  `);
};

exports.down = function (pgm) {
  pgm.sql(`DROP TABLE backup_runs;`);
};
