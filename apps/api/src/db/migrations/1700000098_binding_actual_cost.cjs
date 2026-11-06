'use strict';

// The binder's actual cost (#249, #225 B1; owner decision a, 2026-11-06).
//
// A binding job kept no cost: profit used the service's standard cost, frozen
// on the sale line, only. "Back and ready" now asks what the binder charged
// for the job, kept here with the moment it came back. The sale keeps its
// standard cost, so a closed day does not move (#230); the difference is a
// cost of the day the job came back. Jobs already back have neither: no
// difference is made up for them.

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.sql(`
    ALTER TABLE service_jobs
      ADD COLUMN actual_cost numeric(12,2) CHECK (actual_cost >= 0),
      ADD COLUMN ready_at timestamptz,
      ADD CONSTRAINT service_jobs_actual_cost_when_back CHECK (actual_cost IS NULL OR ready_at IS NOT NULL);
  `);
};

exports.down = function (pgm) {
  pgm.sql(`
    ALTER TABLE service_jobs
      DROP CONSTRAINT service_jobs_actual_cost_when_back,
      DROP COLUMN ready_at,
      DROP COLUMN actual_cost;
  `);
};
