'use strict';

// Negative stock when the shop allows it (#21, owner decision). With the
// allow_negative_stock setting on, a sale may go ahead before the receipt that
// covers it is booked; the quantity then goes below zero until the receipt
// arrives. The CHECK kept it at zero instead, so the code clamped it and the
// history (-5) no longer matched the quantity (-2), overstating stock after
// the next receipt. The setting stays off by default, and then the code
// refuses any movement that would take stock below zero.

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.dropConstraint('inventory', 'inventory_quantity_nonneg');
};

// Negative quantities cannot survive the restored CHECK; they become zero,
// as the code used to make them.
exports.down = function (pgm) {
  pgm.sql('UPDATE inventory SET quantity = 0 WHERE quantity < 0');
  pgm.addConstraint('inventory', 'inventory_quantity_nonneg', 'CHECK (quantity >= 0)');
};
