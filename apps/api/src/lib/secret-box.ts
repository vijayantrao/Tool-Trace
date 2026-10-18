/**
 * Encrypts secrets that ToolTrace must store but never show again (database
 * passwords for data sources). AES-256-GCM with a key that lives outside the
 * database (DATA_SOURCE_KEY), so a copy of the database alone reveals nothing.
 *
 * Each secret is bound to the record it belongs to (GCM associated data), so an
 * encrypted password can't be moved to another data source to be used there.
 *
 * Layout: version (1 byte) | IV (12) | tag (16) | ciphertext.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const VERSION = 1;

export function decodeKey(raw: string): Buffer {
  const key = /^[0-9a-fA-F]{64,}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length < 32) throw new Error('DATA_SOURCE_KEY must be at least 32 bytes (64 hex characters or 44 base64)');
  return key;
}

export class SecretBox {
  private readonly key: Buffer;

  constructor(rawKey: string) {
    // A key just for this purpose, even if the same secret were ever reused elsewhere.
    this.key = Buffer.from(hkdfSync('sha256', decodeKey(rawKey), 'tooltrace', 'data-source-credentials-v1', 32));
  }

  seal(plaintext: string, context: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
  }

  open(blob: Buffer, context: string): string {
    if (blob.length < 29 || blob[0] !== VERSION) throw new Error('Unrecognised secret format');
    const decipher = createDecipheriv('aes-256-gcm', this.key, blob.subarray(1, 13));
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(blob.subarray(13, 29));
    return Buffer.concat([decipher.update(blob.subarray(29)), decipher.final()]).toString('utf8');
  }
}
