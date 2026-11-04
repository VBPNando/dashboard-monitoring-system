import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { join } from 'node:path';
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import {
  ADMIN_HASH_FILE,
  ADMIN_PASSWORD,
  ADMIN_PASSWORD_FILE,
  ADMIN_PASSWORD_SOURCE,
  DATA_DIR,
  MASTER_KEY,
  REMEMBER_DAYS,
  SESSION_HOURS,
} from './config.js';
import { clientIp, isHttps, isPrivateIp, viaCloudflare } from './net.js';

/**
 * Login satu admin dengan cookie sesi yang ditandatangani HMAC (stateless):
 * sesi tetap berlaku setelah server restart, tanpa tabel sesi.
 * Mengganti password otomatis membatalkan semua sesi lama (sidik jari password ada di token).
 *
 * Password awal = teks di data/admin-password.txt (atau DBMON_ADMIN_PASSWORD).
 * Setelah diganti lewat aplikasi, disimpan sebagai hash scrypt di data/admin-password.hash.
 */
const COOKIE = 'dbmon_session';
const sessionKey = createHash('sha256').update(MASTER_KEY).update('dbmon-session').digest();

type Cred = { kind: 'plain'; value: string } | { kind: 'hash'; salt: string; hash: string };

function loadCred(): Cred {
  if (ADMIN_PASSWORD_SOURCE === 'hash') {
    try {
      const j = JSON.parse(readFileSync(ADMIN_HASH_FILE, 'utf8')) as { salt: string; hash: string };
      if (j.salt && j.hash) return { kind: 'hash', salt: j.salt, hash: j.hash };
    } catch {
      /* file rusak → jatuh ke teks */
    }
    throw new Error(`File ${ADMIN_HASH_FILE} rusak. Hapus file itu lalu jalankan ulang untuk membuat password baru.`);
  }
  return { kind: 'plain', value: ADMIN_PASSWORD };
}

let cred = loadCred();

/** "Keluarkan semua perangkat": nilai acak di data/session-epoch; diganti → semua token lama batal */
const EPOCH_FILE = join(DATA_DIR, 'session-epoch');
let epoch = existsSync(EPOCH_FILE) ? readFileSync(EPOCH_FILE, 'utf8').trim() : '';

const fingerprintOf = (c: Cred) =>
  createHash('sha256')
    .update(c.kind === 'plain' ? c.value : `${c.salt}:${c.hash}`)
    .update(epoch)
    .digest('hex')
    .slice(0, 16);
let pwFingerprint = fingerprintOf(cred);

function rotateEpoch() {
  epoch = randomBytes(12).toString('base64url');
  writeFileSync(EPOCH_FILE, epoch + '\n', { mode: 0o600 });
  pwFingerprint = fingerprintOf(cred);
}

const PUBLIC_API = new Set(['/api/login', '/api/health']);

function sign(payload: string) {
  return createHmac('sha256', sessionKey).update(payload).digest('base64url');
}

/** Token: <kedaluwarsa>.<sidik jari password>.<1 = ingat saya>.<tanda tangan> */
function issueToken(remember: boolean) {
  const ms = remember ? REMEMBER_DAYS * 86400_000 : SESSION_HOURS * 3600_000;
  const payload = `${Date.now() + ms}.${pwFingerprint}.${remember ? 1 : 0}`;
  return { token: `${payload}.${sign(payload)}`, maxAge: Math.round(ms / 1000) };
}

function parseToken(token?: string) {
  if (!token) return null;
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const payload = token.slice(0, i);
  const sig = Buffer.from(token.slice(i + 1));
  const expected = Buffer.from(sign(payload));
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
  const [exp, fp, r] = payload.split('.');
  if (fp !== pwFingerprint || !(Number(exp) > Date.now())) return null;
  return { exp: Number(exp), remember: r === '1' };
}

export function verifyToken(token?: string) {
  return parseToken(token) != null;
}

export function readCookie(header: string | undefined, name = COOKIE) {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

/** Secure otomatis bila pengunjung memakai HTTPS (mis. lewat Cloudflare), tetap jalan di http LAN */
function setCookie(req: FastifyRequest, reply: FastifyReply, value: string, maxAgeSec: number) {
  reply.header(
    'Set-Cookie',
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${isHttps(req) ? '; Secure' : ''}`,
  );
}

const sha = (x: string) => createHash('sha256').update(x).digest();

function passwordMatches(input: string) {
  if (cred.kind === 'plain') return timingSafeEqual(sha(input), sha(cred.value));
  const got = scryptSync(input, Buffer.from(cred.salt, 'base64'), 32);
  const want = Buffer.from(cred.hash, 'base64');
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Bisa diganti lewat aplikasi? Tidak bila diatur lewat environment variable. */
const changeable = () => ADMIN_PASSWORD_SOURCE !== 'env';

function savePassword(next: string) {
  const salt = randomBytes(16);
  const hash = scryptSync(next, salt, 32);
  const body = JSON.stringify({ algo: 'scrypt', salt: salt.toString('base64'), hash: hash.toString('base64'), changedAt: new Date().toISOString() });
  const tmp = `${ADMIN_HASH_FILE}.tmp`;
  writeFileSync(tmp, body + '\n', { mode: 0o600 });
  renameSync(tmp, ADMIN_HASH_FILE);
  // Password teks lama tidak berlaku lagi → hapus agar tidak membingungkan
  if (ADMIN_PASSWORD_FILE && ADMIN_PASSWORD_FILE !== ADMIN_HASH_FILE && existsSync(ADMIN_PASSWORD_FILE)) {
    try {
      unlinkSync(ADMIN_PASSWORD_FILE);
    } catch {
      /* abaikan */
    }
  }
  cred = { kind: 'hash', salt: salt.toString('base64'), hash: hash.toString('base64') };
  pwFingerprint = fingerprintOf(cred);
}

/** Rate limiter sederhana di memori: maksimal `max` percobaan per `windowMs` per kunci. */
const attempts = new Map<string, { count: number; reset: number }>();
export function rateLimited(key: string, max: number, windowMs = 15 * 60_000) {
  const now = Date.now();
  if (attempts.size > 10_000) {
    for (const [k, a] of attempts) if (a.reset < now) attempts.delete(k);
  }
  const a = attempts.get(key);
  if (!a || a.reset < now) {
    attempts.set(key, { count: 1, reset: now + windowMs });
    return false;
  }
  a.count++;
  return a.count > max;
}

/**
 * Penghitung login GAGAL:
 *  - per IP: 10 kali / 15 menit
 *  - semua IP dari internet (bukan LAN/VPN): 40 kali / 15 menit → login dari luar dikunci sementara,
 *    login dari jaringan kantor tetap bisa (agar serangan tebak password tidak mengunci admin).
 */
const fails = new Map<string, { n: number; reset: number }>();
const WINDOW = 15 * 60_000;
function failCount(key: string) {
  const f = fails.get(key);
  return f && f.reset > Date.now() ? f.n : 0;
}
function addFail(key: string) {
  const now = Date.now();
  const f = fails.get(key);
  if (!f || f.reset < now) fails.set(key, { n: 1, reset: now + WINDOW });
  else f.n++;
  if (fails.size > 10_000) for (const [k, v] of fails) if (v.reset < now) fails.delete(k);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function registerAuth(app: FastifyInstance) {
  // Header keamanan dasar untuk semua respons
  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    if (isHttps(req)) reply.header('Strict-Transport-Security', 'max-age=15552000');
  });

  // Semua /api/* wajib login, kecuali login & health check
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/') || PUBLIC_API.has(path)) return;
    if (!verifyToken(readCookie(req.headers.cookie))) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.post('/api/login', async (req, reply) => {
    const ip = clientIp(req);
    const external = !isPrivateIp(ip);
    if (failCount(`ip:${ip}`) >= 10) {
      return reply.code(429).send({ error: 'Terlalu banyak percobaan gagal. Coba lagi dalam 15 menit.' });
    }
    if (external && failCount('external') >= 40) {
      return reply.code(429).send({ error: 'Login dari luar jaringan kantor dikunci sementara (banyak percobaan gagal). Coba lagi dalam 15 menit.' });
    }
    const body = (req.body ?? {}) as { password?: unknown; remember?: unknown };
    if (typeof body.password !== 'string' || body.password.length > 200 || !passwordMatches(body.password)) {
      addFail(`ip:${ip}`);
      if (external) addFail('external');
      req.log.warn({ ip, via: viaCloudflare(req) ? 'cloudflare' : 'langsung' }, 'Login gagal');
      await sleep(700); // memperlambat tebak-tebakan password
      return reply.code(401).send({ error: 'Password salah' });
    }
    fails.delete(`ip:${ip}`);
    if (external) req.log.info({ ip, via: viaCloudflare(req) ? 'cloudflare' : 'langsung' }, 'Login berhasil dari luar jaringan kantor');
    const t = issueToken(body.remember === true);
    setCookie(req, reply, t.token, t.maxAge);
    return { ok: true };
  });

  app.post('/api/logout', async (req, reply) => {
    setCookie(req, reply, '', 0);
    return { ok: true };
  });

  /** Keluarkan SEMUA perangkat (mis. HP hilang); perangkat ini tetap masuk */
  app.post('/api/logout-all', async (req, reply) => {
    const remember = parseToken(readCookie(req.headers.cookie))?.remember ?? false;
    rotateEpoch();
    const t = issueToken(remember);
    setCookie(req, reply, t.token, t.maxAge);
    return { ok: true };
  });

  /** Info sesi. "Ingat saya" diperpanjang otomatis (maks. sekali sehari) selama aplikasi dibuka. */
  app.get('/api/me', async (req, reply) => {
    const t = parseToken(readCookie(req.headers.cookie));
    if (t?.remember && t.exp - Date.now() < (REMEMBER_DAYS - 1) * 86400_000) {
      const n = issueToken(true);
      setCookie(req, reply, n.token, n.maxAge);
    }
    const ip = clientIp(req);
    return {
      ok: true,
      remember: !!t?.remember,
      rememberDays: REMEMBER_DAYS,
      passwordChangeable: changeable(),
      access: { ip, via: viaCloudflare(req) ? 'cloudflare' : 'direct', https: isHttps(req), lan: isPrivateIp(ip) },
    };
  });

  app.post('/api/password', async (req, reply) => {
    if (!changeable()) {
      return reply.code(400).send({ error: 'Password diatur lewat DBMON_ADMIN_PASSWORD (file .env / environment). Ubah di sana.' });
    }
    if (rateLimited(`pw:${clientIp(req)}`, 10)) return reply.code(429).send({ error: 'Terlalu banyak percobaan. Coba lagi dalam 15 menit.' });
    const body = (req.body ?? {}) as { current?: unknown; next?: unknown };
    if (typeof body.current !== 'string' || !passwordMatches(body.current)) {
      return reply.code(400).send({ error: 'Password lama salah' });
    }
    const next = typeof body.next === 'string' ? body.next : '';
    if (next.length < 8) return reply.code(400).send({ error: 'Password baru minimal 8 karakter' });
    if (next.length > 200) return reply.code(400).send({ error: 'Password baru terlalu panjang' });
    if (next === body.current) return reply.code(400).send({ error: 'Password baru sama dengan yang lama' });
    const remember = parseToken(readCookie(req.headers.cookie))?.remember ?? false;
    savePassword(next);
    // Sesi lain otomatis keluar; sesi ini tetap masuk dengan token baru
    const t = issueToken(remember);
    setCookie(req, reply, t.token, t.maxAge);
    return { ok: true };
  });

  app.get('/api/health', async () => ({ ok: true }));
}
