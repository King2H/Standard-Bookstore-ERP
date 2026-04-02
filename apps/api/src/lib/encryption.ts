/**
 * AES-256-GCM column-level encryption for sensitive fields.
 * Key loaded from COLUMN_ENCRYPTION_KEY env var (32-byte hex string = 64 hex chars).
 *
 * Encrypted format (base64): <12-byte IV> + <16-byte auth tag> + <ciphertext>
 * All three parts are concatenated then base64-encoded as a single string.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;   // 96-bit IV recommended for GCM
const TAG_LENGTH = 16;  // 128-bit auth tag

function getKey(): Buffer {
  const hex = process.env.COLUMN_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      'COLUMN_ENCRYPTION_KEY must be set to a 64-character hex string (32 bytes). ' +
      'Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypts a plaintext string.
 * Returns a base64-encoded string: IV (12 bytes) + auth tag (16 bytes) + ciphertext.
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  // Concatenate: iv (12) + tag (16) + ciphertext
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

/**
 * Decrypts a base64-encoded ciphertext produced by encrypt().
 */
export function decrypt(ciphertext: string): string {
  const key = getKey();
  const buf = Buffer.from(ciphertext, 'base64');

  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = buf.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Returns the last 4 characters of the decrypted value for display (masking).
 * If decryption fails, returns '****'.
 */
export function maskLast4(ciphertext: string | null | undefined): string {
  if (!ciphertext) return '';
  try {
    const plain = decrypt(ciphertext);
    return `****${plain.slice(-4)}`;
  } catch {
    return '****';
  }
}
