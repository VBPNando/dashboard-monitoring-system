import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { MASTER_KEY } from './config.js';

/**
 * Password database TIDAK pernah disimpan sebagai plaintext.
 * AES-256-GCM: format tersimpan = base64(iv[12] | authTag[16] | ciphertext)
 * Kunci: env DBMON_MASTER_KEY, atau data/master.key yang dibuat otomatis.
 * PENTING: jika master.key hilang, password yang tersimpan tidak bisa dibuka lagi.
 */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', MASTER_KEY, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

export function decrypt(b64: string): string {
  const buf = Buffer.from(b64, 'base64');
  const d = createDecipheriv('aes-256-gcm', MASTER_KEY, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}
