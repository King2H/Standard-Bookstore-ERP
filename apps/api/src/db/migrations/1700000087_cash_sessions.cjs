'use strict';

// Cash sessions (#171, owner decisions 1a–6a, 2026-10-28).
//
// The cash a staff member holds at the counter, from an opening float (0 when
// the drawer starts empty) to a blind count at close. No tills: one open
// session per person per branch, as a shop with one salesperson and no
// counter keeps it. Each counter flow records its money as a movement of the
// open session, naming the payment, refund or entry it stands for; cash put
// in or taken out by hand names a type and a reason. Only cash is in the
// drawer: expected cash is the float plus cash in less cash out. At close the
// session keeps expected, counted and variance, and is numbered Z- by the
// shop's daily counter; beyond the branch's limit it waits for a Manager or
// Admin to accept it with a reason.
//
// Two settings, each a branch may override: require_cash_session (off) and
// cash_variance_limit (50), added for every shop.

exports.shorthands = undefined;

const TENANT = `NULLIF(current_setting('app.tenant_id', true), '')::integer`;

const SETTINGS = [
  ['require_cash_session', 'false'],
  ['cash_variance_limit', '50'],
];

exports.up = function (pgm) {
  pgm.sql(`
    CREATE TABLE cash_sessions (
      id serial PRIMARY KEY,
      tenant_id integer NOT NULL DEFAULT ${TENANT} REFERENCES tenants(id),
      branch_id integer NOT NULL REFERENCES branches(id),
      staff_id integer NOT NULL REFERENCES staff(id),
      status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending_review', 'closed')),
      currency text NOT NULL,
      opening_float numeric(14,2) NOT NULL CHECK (opening_float >= 0),
      opened_at timestamptz NOT NULL DEFAULT now(),
      expected_cash numeric(14,2),
      counted_cash numeric(14,2) CHECK (counted_cash >= 0),
      variance numeric(14,2),
      close_note text,
      closed_by integer REFERENCES staff(id),
      closed_at timestamptz,
      z_number text,
      reviewed_by integer REFERENCES staff(id),
      reviewed_at timestamptz,
      review_reason text,
      CONSTRAINT cash_sessions_closed CHECK (
        (status = 'open') = (closed_at IS NULL)
        AND (closed_at IS NULL) = (counted_cash IS NULL)
        AND (closed_at IS NULL) = (expected_cash IS NULL)
        AND (closed_at IS NULL) = (variance IS NULL)
        AND (closed_at IS NULL) = (closed_by IS NULL)
        AND (closed_at IS NULL) = (z_number IS NULL)
      ),
      CONSTRAINT cash_sessions_reviewed CHECK (
        (reviewed_at IS NULL) = (reviewed_by IS NULL)
        AND (reviewed_at IS NULL OR (status = 'closed' AND btrim(coalesce(review_reason, '')) <> ''))
      ),
      CONSTRAINT cash_sessions_z_number_key UNIQUE (tenant_id, z_number)
    );
    CREATE UNIQUE INDEX cash_sessions_one_open ON cash_sessions (tenant_id, staff_id, branch_id) WHERE status = 'open';
    CREATE INDEX cash_sessions_branch_idx ON cash_sessions (branch_id, opened_at DESC);

    CREATE TABLE cash_session_movements (
      id bigserial PRIMARY KEY,
      tenant_id integer NOT NULL DEFAULT ${TENANT} REFERENCES tenants(id),
      session_id integer NOT NULL REFERENCES cash_sessions(id),
      kind text NOT NULL CHECK (kind IN (
        'pos_payment', 'pos_void', 'order_payment', 'order_refund', 'receivable_payment',
        'return_refund', 'exchange_payment', 'exchange_refund', 'exchange_void', 'pay_in', 'pay_out'
      )),
      source_id text,
      method text NOT NULL CHECK (method IN ('cash', 'bank', 'mobile')),
      direction text NOT NULL CHECK (direction IN ('in', 'out')),
      amount numeric(14,2) NOT NULL CHECK (amount > 0),
      category text CHECK (category IN ('float_top_up', 'bank_drop', 'petty_cash', 'other')),
      reason text,
      staff_id integer NOT NULL REFERENCES staff(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      -- Cash put in or taken out by hand is cash, with a type and a reason; anything else names its source.
      CONSTRAINT cash_session_movements_by_hand CHECK (
        CASE kind
          WHEN 'pay_in' THEN method = 'cash' AND direction = 'in' AND source_id IS NULL
            AND category IN ('float_top_up', 'other') AND btrim(coalesce(reason, '')) <> ''
          WHEN 'pay_out' THEN method = 'cash' AND direction = 'out' AND source_id IS NULL
            AND category IN ('bank_drop', 'petty_cash', 'other') AND btrim(coalesce(reason, '')) <> ''
          ELSE source_id IS NOT NULL AND category IS NULL
        END
      ),
      -- A payment, refund or entry is recorded once.
      CONSTRAINT cash_session_movements_source_key UNIQUE (tenant_id, kind, source_id, direction)
    );
    CREATE INDEX cash_session_movements_session_idx ON cash_session_movements (session_id, id);

    ALTER TABLE cash_sessions ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON cash_sessions USING (tenant_id = ${TENANT}) WITH CHECK (tenant_id = ${TENANT});
    ALTER TABLE cash_session_movements ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON cash_session_movements USING (tenant_id = ${TENANT}) WITH CHECK (tenant_id = ${TENANT});
  `);

  for (const [key, value] of SETTINGS) {
    pgm.sql(`
      INSERT INTO system_config (tenant_id, key, value, updated_by)
      SELECT t.id, '${key}', '${value}'::jsonb, COALESCE((SELECT MIN(s.id) FROM staff s WHERE s.tenant_id = t.id), 1)
      FROM tenants t
      ON CONFLICT (tenant_id, key) DO NOTHING;
    `);
  }
};

exports.down = function (pgm) {
  // A counted drawer is a financial record: rolling back after a session
  // was opened would lose it, so it is refused.
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM cash_sessions) THEN
        RAISE EXCEPTION 'Cash sessions have been recorded; this migration cannot be rolled back';
      END IF;
    END $$;
    DROP TABLE IF EXISTS cash_session_movements;
    DROP TABLE IF EXISTS cash_sessions;
    DELETE FROM branch_config WHERE key IN (${SETTINGS.map(([k]) => `'${k}'`).join(', ')});
    DELETE FROM system_config WHERE key IN (${SETTINGS.map(([k]) => `'${k}'`).join(', ')});
  `);
};
