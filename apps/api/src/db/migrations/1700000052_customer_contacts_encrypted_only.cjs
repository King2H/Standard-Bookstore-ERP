'use strict';

// Customer phone and email stored only encrypted (#90). They were written
// three times: encrypted, as a lookup hash, and in plain text, which made the
// encryption pointless. This migration gives every contact its encrypted copy
// and lookup hash (rows such as the demo customers of 1700000020 had only the
// plain value), then drops the plain columns.
//
// Encrypting needs COLUMN_ENCRYPTION_KEY, the key the API uses; npm run migrate
// reads it from .env. The format matches src/lib/encryption.ts at the time of
// writing: base64(12-byte IV + 16-byte GCM tag + ciphertext), AES-256-GCM.
// The lookup hash matches src/lib/piiEncryption.ts: sha256 of the trimmed,
// lower-cased value.

const crypto = require('crypto');

exports.shorthands = undefined;

function key() {
  const hex = process.env.COLUMN_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      'COLUMN_ENCRYPTION_KEY must be set (the same key the API uses) to encrypt existing customer contacts. ' +
        'Add it to .env and run the migration again.',
    );
  }
  return Buffer.from(hex, 'hex');
}

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

function decrypt(ciphertext) {
  const buf = Buffer.from(ciphertext, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

function lookup(value) {
  return crypto.createHash('sha256').update(value.toLowerCase().trim()).digest('hex');
}

exports.up = async function (pgm) {
  const { rows } = await pgm.db.query(
    `SELECT id, phone, email, phone_encrypted, email_encrypted, phone_lookup, email_lookup
     FROM customers
     WHERE (phone IS NOT NULL AND (phone_encrypted IS NULL OR phone_lookup IS NULL))
        OR (email IS NOT NULL AND (email_encrypted IS NULL OR email_lookup IS NULL))`,
  );
  for (const row of rows) {
    const set = {};
    for (const field of ['phone', 'email']) {
      const plain = row[field] && row[field].trim();
      if (!plain) continue;
      if (!row[`${field}_encrypted`]) set[`${field}_encrypted`] = encrypt(plain);
      if (!row[`${field}_lookup`]) set[`${field}_lookup`] = lookup(plain);
    }
    const columns = Object.keys(set);
    if (columns.length === 0) continue;
    await pgm.db.query(
      `UPDATE customers SET ${columns.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`,
      [row.id, ...columns.map((c) => set[c])],
    );
  }

  pgm.dropColumns('customers', ['phone', 'email']);
};

// The plain values come back only when the key is set to decrypt them.
exports.down = async function (pgm) {
  await pgm.db.query(`ALTER TABLE customers ADD COLUMN phone text, ADD COLUMN email text`);
  await pgm.db.query(`CREATE INDEX customers_phone_idx ON customers (phone)`);
  await pgm.db.query(`CREATE INDEX customers_email_idx ON customers (email)`);
  if (!process.env.COLUMN_ENCRYPTION_KEY) return;
  const { rows } = await pgm.db.query(
    `SELECT id, phone_encrypted, email_encrypted FROM customers WHERE phone_encrypted IS NOT NULL OR email_encrypted IS NOT NULL`,
  );
  for (const row of rows) {
    await pgm.db.query(`UPDATE customers SET phone = $2, email = $3 WHERE id = $1`, [
      row.id,
      row.phone_encrypted ? decrypt(row.phone_encrypted) : null,
      row.email_encrypted ? decrypt(row.email_encrypted) : null,
    ]);
  }
};
