#!/usr/bin/env node
/**
 * Monitoring Agent — dipasang di SERVER DATABASE untuk mengirim CPU, RAM & disk asli.
 * Tanpa dependensi: cukup Node.js 18+ (Windows / Linux / macOS).
 *
 *   node dbmon-agent.mjs
 *
 * Pengaturan (environment variable, semua opsional):
 *   DBMON_AGENT_PORT   port HTTP (default 9187)
 *   DBMON_AGENT_TOKEN  token rahasia; kosong = dibuat otomatis & disimpan di agent-token.txt
 *   DBMON_AGENT_ALLOW  IP yang boleh mengakses, dipisah koma; prefix didukung (mis. 192.168.1.,10.0.0.5)
 *                      kosong = semua IP (tetap wajib token)
 *
 * Endpoint: GET /metrics  (header  Authorization: Bearer <token>)
 */
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const VERSION = '1.0.0';
const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DBMON_AGENT_PORT || 9187);
const ALLOW = (process.env.DBMON_AGENT_ALLOW || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// ---------- Token ----------
function loadToken() {
  if (process.env.DBMON_AGENT_TOKEN) return { token: process.env.DBMON_AGENT_TOKEN.trim(), file: '' };
  const file = path.join(here, 'agent-token.txt');
  if (fs.existsSync(file)) return { token: fs.readFileSync(file, 'utf8').trim(), file };
  const token = crypto.randomBytes(18).toString('base64url');
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  return { token, file };
}
const { token: TOKEN, file: TOKEN_FILE } = loadToken();

// ---------- CPU: rata-rata semua core, diukur tiap 1 detik di latar belakang ----------
function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}
let prevCpu = cpuTimes();
let cpuPct = null;
setInterval(() => {
  const cur = cpuTimes();
  const dTotal = cur.total - prevCpu.total;
  const dIdle = cur.idle - prevCpu.idle;
  if (dTotal > 0) cpuPct = Math.round((1 - dIdle / dTotal) * 1000) / 10;
  prevCpu = cur;
}, 1000).unref();

// ---------- RAM ----------
function memory() {
  const total = os.totalmem();
  let available = os.freemem();
  // Linux: freemem tidak menghitung cache yang bisa dipakai ulang → pakai MemAvailable agar akurat
  if (process.platform === 'linux') {
    try {
      const m = /MemAvailable:\s+(\d+)\s+kB/.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
      if (m) available = Number(m[1]) * 1024;
    } catch {
      /* pakai freemem */
    }
  }
  const used = total - available;
  return { totalBytes: total, usedBytes: used, pct: Math.round((used / total) * 1000) / 10 };
}

// ---------- Disk (drive/partisi tempat data biasanya berada) ----------
function disk() {
  const target = process.platform === 'win32' ? path.parse(process.cwd()).root : '/';
  try {
    const s = fs.statfsSync(target);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { mount: target, totalBytes: total, usedBytes: total - free, pct: Math.round(((total - free) / total) * 1000) / 10 };
  } catch {
    return null;
  }
}

// ---------- HTTP ----------
function clientAllowed(ip) {
  if (!ALLOW.length) return true;
  const clean = (ip || '').replace(/^::ffff:/, '');
  return ALLOW.some((a) => clean === a || (a.endsWith('.') && clean.startsWith(a)) || clean.startsWith(a.replace(/\*$/, '')));
}

function tokenOk(header) {
  const given = Buffer.from(String(header || '').replace(/^Bearer\s+/i, ''));
  const expected = Buffer.from(TOKEN);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

const server = http.createServer((req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (!clientAllowed(req.socket.remoteAddress)) return send(403, { error: 'ip not allowed' });
  if (req.method !== 'GET' || req.url !== '/metrics') return send(404, { error: 'not found' });
  if (!tokenOk(req.headers.authorization)) return send(401, { error: 'invalid token' });
  send(200, {
    version: VERSION,
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    uptimeSec: Math.round(os.uptime()),
    cpuCores: os.cpus().length,
    cpuPct,
    memory: memory(),
    disk: disk(),
    loadAvg: process.platform === 'win32' ? null : os.loadavg(),
    ts: Date.now(),
  });
});

server.on('error', (e) => {
  console.error(`\n  Agen gagal berjalan: ${e.code === 'EADDRINUSE' ? `port ${PORT} sudah dipakai program lain` : e.message}\n`);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
  console.log(
    [
      '',
      `  Monitoring Agent ${VERSION} berjalan di port ${PORT}`,
      ...ips.map((ip) => `  • Agent URL : http://${ip}:${PORT}`),
      `  • Token     : ${TOKEN}`,
      TOKEN_FILE ? `    (tersimpan di ${TOKEN_FILE})` : '',
      ALLOW.length ? `  • Hanya menerima dari: ${ALLOW.join(', ')}` : '',
      '',
      '  Isi Agent URL & Token di Dashboard Monitoring System (menu ⋯ → Atur agen CPU & RAM).',
      '  Biarkan jendela ini terbuka. Tekan Ctrl+C untuk berhenti.',
      '',
    ]
      .filter((l) => l !== '')
      .join('\n') + '\n',
  );
});
