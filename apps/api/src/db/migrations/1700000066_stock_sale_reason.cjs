'use strict';

// Stock leaving in a sale is recorded with reason 'sale' (#109, owner
// decision 4a). POS sales were recorded as 'loss' (the default when no reason
// was given), confirmed orders as 'correction', and v1 exchanges' outgoing
// books as 'loss', so stock history and reports could not tell sales from
// shrinkage. Those rows are identified exactly by what they refer to.

exports.shorthands = undefined;

const SALES = [
  ['sale', 'loss'],
  ['order_confirmed', 'correction'],
  ['exchange_out', 'loss'],
];

exports.up = async function (pgm) {
  for (const [referenceType, reason] of SALES) {
    await pgm.db.query(
      `UPDATE inventory_history SET reason_code = 'sale'
       WHERE movement_type = 'stock_out' AND reference_type = $1 AND reason_code = $2`,
      [referenceType, reason],
    );
  }
};

exports.down = async function (pgm) {
  for (const [referenceType, reason] of SALES) {
    await pgm.db.query(
      `UPDATE inventory_history SET reason_code = $2
       WHERE movement_type = 'stock_out' AND reference_type = $1 AND reason_code = 'sale'`,
      [referenceType, reason],
    );
  }
};
