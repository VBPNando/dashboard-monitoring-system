import type { FastifyRequest } from 'fastify';
import { SECURE_COOKIE, TRUST_PROXY } from './config.js';

/**
 * Akses lewat Cloudflare Tunnel / reverse proxy di komputer yang sama:
 * cloudflared menyambung dari 127.0.0.1 dan mengirim IP asli pengunjung (CF-Connecting-IP,
 * X-Forwarded-For) serta protokol asli (X-Forwarded-Proto: https). Header tersebut HANYA
 * dipercaya bila koneksi datang dari komputer ini sendiri (atau DBMON_TRUST_PROXY=1),
 * sehingga pengguna LAN tidak bisa memalsukan IP.
 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function viaTrustedProxy(req: FastifyRequest) {
  return TRUST_PROXY || LOOPBACK.has(req.socket.remoteAddress ?? '');
}

const header = (req: FastifyRequest, name: string) => {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
};

/** IP asli pengunjung (untuk pembatas percobaan login & log) */
export function clientIp(req: FastifyRequest): string {
  if (viaTrustedProxy(req)) {
    const cf = header(req, 'cf-connecting-ip');
    if (cf) return cf;
    const xff = header(req, 'x-forwarded-for');
    if (xff) return xff.split(',').at(-1)!.trim();
  }
  return (req.socket.remoteAddress ?? req.ip).replace(/^::ffff:/, '');
}

/** Lewat Cloudflare (ada header khas Cloudflare dari koneksi tepercaya)? */
export function viaCloudflare(req: FastifyRequest) {
  return viaTrustedProxy(req) && !!header(req, 'cf-connecting-ip');
}

/** Diakses pengunjung lewat HTTPS (langsung atau di balik tunnel)? → cookie diberi flag Secure */
export function isHttps(req: FastifyRequest) {
  if (SECURE_COOKIE) return true;
  if (req.protocol === 'https') return true;
  return viaTrustedProxy(req) && header(req, 'x-forwarded-proto') === 'https';
}

/** IP jaringan lokal (LAN/VPN kantor) */
export function isPrivateIp(ip: string) {
  const v = ip.replace(/^::ffff:/, '');
  if (v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')) return true;
  const m = v.match(/^(\d+)\.(\d+)\./);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
