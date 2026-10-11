'use strict';

// Sign-in sessions (#21, auth part 1).
//
// 1. A sign-in opens a session (owner decision 1a). The session keeps the
// branch the staff member works in, so switching branch survives a token
// refresh, and lasts at most one shift (8 hours). Logging out, changing the
// password, an admin reset, deactivation or a reused refresh token end it;
// requests made with it stop at once (owner decision 5a).
//
// 2. Refresh tokens belong to a session and are replaced at every refresh.
// They were bcrypt-hashed, so a refresh compared the cookie against up to
// 100 tokens of all staff, and failed for anyone past the hundredth. A
// refresh token is now 256 random bits stored as its SHA-256 hash, found
// with one unique-index lookup. The branch and role move to the session.
//
// Existing refresh tokens cannot be carried over (they have no session), so
// everyone signs in once after the upgrade.

exports.shorthands = undefined;

exports.up = function (pgm) {
  pgm.sql(`
    CREATE TABLE staff_sessions (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      staff_id       INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
      -- A deleted branch ends the sessions in it rather than blocking the delete.
      branch_id      INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at     TIMESTAMPTZ NOT NULL,
      revoked_at     TIMESTAMPTZ,
      revoked_reason TEXT
        CONSTRAINT staff_sessions_revoked_reason_check
          CHECK (revoked_reason IN ('logout', 'password_changed', 'password_reset', 'deactivated', 'token_reuse')),
      CONSTRAINT staff_sessions_revoked_recorded CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
    );
    CREATE INDEX staff_sessions_staff_id_idx ON staff_sessions (staff_id) WHERE revoked_at IS NULL;

    DELETE FROM refresh_tokens;
    DROP INDEX IF EXISTS refresh_tokens_staff_id_revoked_index;
    ALTER TABLE refresh_tokens
      DROP COLUMN revoked,
      DROP COLUMN branch_id,
      DROP COLUMN role,
      DROP COLUMN expires_at,
      ADD COLUMN session_id UUID NOT NULL REFERENCES staff_sessions(id) ON DELETE CASCADE,
      ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- When it was exchanged for the next token; presenting it again after
      -- that is a reuse.
      ADD COLUMN used_at    TIMESTAMPTZ,
      ADD CONSTRAINT refresh_tokens_token_hash_key UNIQUE (token_hash);
    CREATE INDEX refresh_tokens_session_id_idx ON refresh_tokens (session_id);
  `);
};

exports.down = function (pgm) {
  pgm.sql(`
    DELETE FROM refresh_tokens;
    DROP INDEX refresh_tokens_session_id_idx;
    ALTER TABLE refresh_tokens
      DROP CONSTRAINT refresh_tokens_token_hash_key,
      DROP COLUMN used_at,
      DROP COLUMN created_at,
      DROP COLUMN session_id,
      ADD COLUMN expires_at TIMESTAMPTZ NOT NULL,
      ADD COLUMN role       TEXT,
      ADD COLUMN branch_id  INTEGER,
      ADD COLUMN revoked    BOOLEAN NOT NULL DEFAULT false;
    CREATE INDEX refresh_tokens_staff_id_revoked_index ON refresh_tokens (staff_id, revoked);
    DROP TABLE staff_sessions;
  `);
};
