import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

/**
 * A backup file (#244, owner decision 2a): the archive, encrypted with the
 * passphrase chosen at install, so a copy on a USB drive or a network share
 * is useless to whoever finds it. AES-256-GCM, its key derived with scrypt;
 * the authentication tag refuses a wrong passphrase and any change to the
 * file. Layout: "BMSBAK1\n", salt (16), IV (12), ciphertext, tag (16).
 */
const MAGIC = Buffer.from('BMSBAK1\n');
const SALT = 16;
const IV = 12;
const TAG = 16;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passphrase, salt, 32, SCRYPT, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function encryptFile(source: string, target: string, passphrase: string): Promise<void> {
  const salt = randomBytes(SALT);
  const iv = randomBytes(IV);
  const cipher = createCipheriv('aes-256-gcm', await deriveKey(passphrase, salt), iv);
  const out = createWriteStream(target, { mode: 0o600 });
  out.write(Buffer.concat([MAGIC, salt, iv]));
  await pipeline(createReadStream(source), cipher, out, { end: false });
  await new Promise<void>((resolve, reject) => out.end(cipher.getAuthTag(), (err?: Error | null) => (err ? reject(err) : resolve())));
}

export async function decryptFile(source: string, target: string, passphrase: string): Promise<void> {
  const size = (await stat(source)).size;
  const head = Buffer.alloc(MAGIC.length + SALT + IV);
  const tag = Buffer.alloc(TAG);
  const file = await open(source, 'r');
  try {
    if (size < head.length + TAG) throw new Error('Not a bookstore backup file');
    await file.read(head, 0, head.length, 0);
    await file.read(tag, 0, TAG, size - TAG);
  } finally {
    await file.close();
  }
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not a bookstore backup file');
  const salt = head.subarray(MAGIC.length, MAGIC.length + SALT);
  const iv = head.subarray(MAGIC.length + SALT);
  const decipher = createDecipheriv('aes-256-gcm', await deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  try {
    await pipeline(createReadStream(source, { start: head.length, end: size - TAG - 1 }), decipher, createWriteStream(target, { mode: 0o600 }));
  } catch {
    throw new Error('Wrong passphrase, or the backup file was changed or damaged');
  }
}
