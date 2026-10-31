'use strict';

// Cancelling the rest of a part-delivered order (#174, owner decision 1a,
// 2026-10-31): the copies it will never deliver are recorded as a return
// against the order, marked as never delivered, so the reports subtract them
// as they subtract returns and the order's lines can tell them apart.

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.sql(`
    ALTER TABLE returns ADD COLUMN undelivered boolean NOT NULL DEFAULT false;
    ALTER TABLE returns ADD CONSTRAINT returns_undelivered_order CHECK (NOT undelivered OR order_id IS NOT NULL);
  `);
};

exports.down = function (pgm) {
  // Rolling back would make never-delivered copies look returned: refused once there are any.
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM returns WHERE undelivered) THEN
        RAISE EXCEPTION 'Orders have undelivered copies cancelled; this migration cannot be rolled back';
      END IF;
    END $$;
    ALTER TABLE returns DROP CONSTRAINT returns_undelivered_order;
    ALTER TABLE returns DROP COLUMN undelivered;
  `);
};
