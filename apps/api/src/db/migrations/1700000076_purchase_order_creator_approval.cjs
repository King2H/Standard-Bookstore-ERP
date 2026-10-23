'use strict';

// Any Admin or Manager of the ordering branch approves a purchase order, their
// own included, with no reason (owner decisions 1a, 2a, 2026-10-23, as in v1).
// Approving one's own order is recorded as approved by its creator ('creator'),
// so the order, the audit log and Super_Admin still see it.
//
// Orders approved before by their only approver keep 'sole_approver' and the
// reason given (its constraint stays). The down migration refuses while an
// order is recorded as approved by its creator.

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.sql(`
    ALTER TABLE purchase_orders
      DROP CONSTRAINT purchase_orders_approval_kind_check,
      ADD CONSTRAINT purchase_orders_approval_kind_check
        CHECK (approval_kind IN ('automatic', 'approver', 'creator', 'sole_approver'))
  `);
};

exports.down = function (pgm) {
  pgm.sql(`
    ALTER TABLE purchase_orders
      DROP CONSTRAINT purchase_orders_approval_kind_check,
      ADD CONSTRAINT purchase_orders_approval_kind_check
        CHECK (approval_kind IN ('automatic', 'approver', 'sole_approver'))
  `);
};
