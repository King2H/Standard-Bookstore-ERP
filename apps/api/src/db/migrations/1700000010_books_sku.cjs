'use strict';

// Adds optional SKU (internal identifier) to books.
// ISBN remains required at DB level; UI treats it as optional by auto-generating
// a placeholder when blank (format: SKU-{sku} or AUTO-{id}).

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.addColumn('books', {
    sku: { type: 'text', unique: true },
  });
  pgm.addIndex('books', ['sku']);
};

exports.down = function (pgm) {
  pgm.dropIndex('books', ['sku']);
  pgm.dropColumn('books', 'sku');
};
