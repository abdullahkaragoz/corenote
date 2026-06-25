import * as crypto from 'node:crypto';

// Version tags: v1 legacy (per-file key derived from password), v2 new (DEK-based).
const V1 = 'GN-ENC-v1.';
const V2 = 'GN-ENC-v2.';

const SCRYPT = { N: 16384, r: 8, p: 1 } as const;
const KEY_LEN = 32; // AES-256
const SALT_LEN = 16;
const IV_LEN = 12;

export function isV1(text: string): boolean {
  return text.startsWith(V1);
}
export function isV2(text: string): boolean {
  return text.startsWith(V2);
}
export function isEncrypted(text: string): boolean {
  return isV1(text) || isV2(text);
}

function deriveKek(secret: string, salt: Buffer): Buffer {
  return crypto.scryptSync(secret, salt, KEY_LEN, SCRYPT);
}

// ---- v2: content and titles are encrypted with the DEK (master key) ----

// Generate a random 256-bit master key.
export function generateKey(): Buffer {
  return crypto.randomBytes(KEY_LEN);
}

// Encrypt with the DEK. Envelope: GN-ENC-v2.<iv>.<tag>.<ciphertext> (each field base64)
export function encryptWithKey(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LEN);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const e = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return V2 + [iv, c.getAuthTag(), e].map((b) => b.toString('base64')).join('.');
}

export function decryptWithKey(envelope: string, key: Buffer): string {
  if (!isV2(envelope)) {
    throw new Error('Content is not in v2 format.');
  }
  const parts = envelope.slice(V2.length).split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted envelope format.');
  }
  const [iv, tag, e] = parts.map((p) => Buffer.from(p, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(e), d.final()]).toString('utf8');
}

// Decrypt a title/description; if not v2 (legacy plaintext) return it as-is.
export function decryptTitleOrRaw(raw: string, key: Buffer): string {
  if (isV2(raw)) {
    try {
      return decryptWithKey(raw, key);
    } catch {
      return raw;
    }
  }
  return raw;
}

// ---- v1 (legacy) decryption — for migration only ----
export function decryptV1(envelope: string, password: string): string {
  const [salt, iv, tag, e] = envelope
    .slice(V1.length)
    .split('.')
    .map((p) => Buffer.from(p, 'base64'));
  const key = deriveKek(password, salt);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(e), d.final()]).toString('utf8');
}

// ---- DEK wrapping: encrypt the master key with a password or recovery key ----
export interface Wrapped {
  salt: string;
  iv: string;
  tag: string;
  ct: string;
}

export function wrapKey(dek: Buffer, secret: string): Wrapped {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const kek = deriveKek(secret, salt);
  const c = crypto.createCipheriv('aes-256-gcm', kek, iv);
  const ct = Buffer.concat([c.update(dek), c.final()]);
  return {
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: c.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
}

// Unwrap the DEK; throws if the secret (password/recovery) is wrong.
export function unwrapKey(w: Wrapped, secret: string): Buffer {
  const kek = deriveKek(secret, Buffer.from(w.salt, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', kek, Buffer.from(w.iv, 'base64'));
  d.setAuthTag(Buffer.from(w.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(w.ct, 'base64')), d.final()]);
}

// ---- Recovery key generation (base32, grouped by 4, human-readable) ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function generateRecoveryKey(): string {
  const bytes = crypto.randomBytes(20); // 160 bit
  let bits = '';
  for (const b of bytes) {
    bits += b.toString(2).padStart(8, '0');
  }
  let out = '';
  for (let i = 0; i < bits.length; i += 5) {
    out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  }
  return out.match(/.{1,4}/g)!.join('-');
}
