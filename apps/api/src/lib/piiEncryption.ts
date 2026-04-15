/**
 * PII encryption helpers for customer email/phone.
 * Uses the same AES-256-GCM key as bank account encryption.
 * Adds SHA256 lookup hashes for search without decryption.
 */
import { createHash } from 'crypto';
import { encrypt, decrypt } from './encryption.js';

/**
 * Encrypt a PII value (email or phone).
 * Returns null if input is null/empty.
 */
export function encryptPii(value: string | null | undefined): string | null {
  if (!value) return null;
  return encrypt(value);
}

/**
 * Decrypt a PII value.
 * Returns null if input is null/empty.
 */
export function decryptPii(ciphertext: string | null | undefined): string | null {
  if (!ciphertext) return null;
  try {
    return decrypt(ciphertext);
  } catch {
    return null;
  }
}

/**
 * Compute a SHA256 lookup hash for a PII value.
 * Used for equality search without decryption.
 * Returns null if input is null/empty.
 */
export function piiLookupHash(value: string | null | undefined): string | null {
  if (!value) return null;
  return createHash('sha256').update(value.toLowerCase().trim()).digest('hex');
}
