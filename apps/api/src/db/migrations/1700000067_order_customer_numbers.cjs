'use strict';

// Order numbers and customer codes come from the document counters (#68,
// owner decision 3a), like payment, sale, return and exchange numbers. Orders
// were numbered from the count of the day's orders, so two created at once,
// or one created after a draft of the day was deleted, took a number already
// used and failed with a 500; customer codes were the highest code plus one.
// The counters start after the highest number already given: orders per day
// (ORD-YYYYMMDD-NNNN), customers as one running series (CUS-nnnn, period '').

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.sql(`
    INSERT INTO document_counters (series, period, last_value)
    SELECT 'ORD', substring(order_number FROM 5 FOR 8), MAX(substring(order_number FROM 14)::int)
    FROM orders
    WHERE order_number ~ '^ORD-[0-9]{8}-[0-9]+$'
    GROUP BY 2
    ON CONFLICT (series, period) DO UPDATE SET last_value = GREATEST(document_counters.last_value, EXCLUDED.last_value);

    INSERT INTO document_counters (series, period, last_value)
    SELECT 'CUS', '', MAX(substring(customer_code FROM 5)::int)
    FROM customers
    WHERE customer_code ~ '^CUS-[0-9]+$'
    HAVING MAX(substring(customer_code FROM 5)::int) > 0
    ON CONFLICT (series, period) DO UPDATE SET last_value = GREATEST(document_counters.last_value, EXCLUDED.last_value);
  `);
};

exports.down = function (pgm) {
  pgm.sql(`DELETE FROM document_counters WHERE series IN ('ORD', 'CUS')`);
};
