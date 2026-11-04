import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';

/**
 * Semua konfigurasi punya nilai default yang aman, sehingga aplikasi bisa
 * langsung jalan tanpa mengisi .env. Rahasia yang tidak diisi lewat env
 * dibuat otomatis sekali lalu disimpan di folder data (dipakai ulang saat restart).
 */
export const DATA_DIR = resolve(process.env.DBMON_DATA_DIR || 'data');
mkdirSync(DATA_DIR, { recursive: true });

type Source = 'env' | 'file' | 'generated';

function persistentSecret(envName: string, fileName: string, generate: () => string) {
  const fromEnv = process.env[envName];
  if (fromEnv) return { value: fromEnv.trim(), source: 'env' as Source, file: '' };
  const file = join(DATA_DIR, fileName);
  if (existsSync(file)) return { value: readFileSync(file, 'utf8').trim(), source: 'file' as Source, file };
  const value = generate();
  writeFileSync(file, value + '\n', { mode: 0o600 });
  return { value, source: 'generated' as Source, file };
}

const masterKey = persistentSecret('DBMON_MASTER_KEY', 'master.key', () => randomBytes(32).toString('base64'));
export const MASTER_KEY = Buffer.from(masterKey.value, 'base64');
if (MASTER_KEY.length !== 32) {
  throw new Error('DBMON_MASTER_KEY harus 32 byte dalam format base64');
}

/**
 * Password login. Bila sudah diganti lewat aplikasi, yang berlaku adalah hash di
 * data/admin-password.hash (file teks lama dihapus). Hapus file hash itu untuk reset:
 * saat start berikutnya password acak baru dibuat.
 */
export const ADMIN_HASH_FILE = join(DATA_DIR, 'admin-password.hash');
const useHash = !process.env.DBMON_ADMIN_PASSWORD && existsSync(ADMIN_HASH_FILE);
const admin = useHash
  ? { value: '', source: 'hash' as const, file: ADMIN_HASH_FILE }
  : persistentSecret('DBMON_ADMIN_PASSWORD', 'admin-password.txt', () => randomBytes(12).toString('base64url'));
/** Password awal (teks). Kosong bila sudah diganti lewat aplikasi (lihat ADMIN_HASH_FILE). */
export const ADMIN_PASSWORD = admin.value;
export const ADMIN_PASSWORD_SOURCE: Source | 'hash' = admin.source;
export const ADMIN_PASSWORD_FILE = admin.file;

export const PORT = Number(process.env.PORT || 3000);
export const HOST = process.env.HOST || '0.0.0.0';
export const INTERVAL_MS = Math.max(500, Number(process.env.DBMON_INTERVAL_MS || 1000));
export const STATIC_DIR = resolve(process.env.DBMON_STATIC_DIR || '../frontend/dist');
export const SESSION_HOURS = Number(process.env.DBMON_SESSION_HOURS || 12);
/** Lama login bila "Ingat saya" dicentang (hari) */
export const REMEMBER_DAYS = Math.max(1, Number(process.env.DBMON_REMEMBER_DAYS || 30));

/** Riwayat detail per menit disimpan sekian hari; setelah itu tetap ada sebagai ringkasan per jam. */
export const HISTORY_MINUTE_DAYS = Math.max(2, Number(process.env.DBMON_HISTORY_MINUTE_DAYS || 31));
/** Ringkasan per jam & riwayat alert disimpan sekian hari (bawaan ±13 bulan, cukup untuk laporan tahunan). */
export const HISTORY_DAYS = Math.max(HISTORY_MINUTE_DAYS, Number(process.env.DBMON_HISTORY_DAYS || 400));
/** Isi 1 bila aplikasi disajikan lewat HTTPS (cookie diberi flag Secure). */
export const SECURE_COOKIE = process.env.DBMON_SECURE_COOKIE === '1';
/** Isi 1 bila berada di belakang reverse proxy (Nginx/Caddy) agar IP klien terbaca benar. */
export const TRUST_PROXY = process.env.DBMON_TRUST_PROXY === '1';

/**
 * Daftar host DB yang boleh didaftarkan, dipisah koma. Kosong = semua host boleh.
 * Mendukung wildcard domain (*.internal.local) dan prefix IP (10.0.1.*).
 */
export const ALLOWED_HOSTS = (process.env.DBMON_ALLOWED_HOSTS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

/** Bila diisi, file SQLite hanya boleh berada di dalam folder ini (di Docker: /sqlite). */
export const SQLITE_DIR = process.env.DBMON_SQLITE_DIR ? resolve(process.env.DBMON_SQLITE_DIR) : '';
