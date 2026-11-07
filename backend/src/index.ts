import { fatal } from './crashlog.js'; // harus pertama: menangkap & mencatat crash
import * as cfg from './config.js'; // memuat .env & menyiapkan folder data
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { Server } from 'socket.io';
import { z } from 'zod';
import { rateLimited, readCookie, registerAuth, verifyToken } from './auth.js';
import { MonitorManager } from './manager.js';
import { agentErrorMessage, fetchAgent } from './agent.js';
import * as store from './store.js';
import type { ConnConfig } from './collectors/types.js';
import type { DeviceConfig } from './sources/types.js';
import { DeviceManager } from './devices.js';
import { clientIp } from './net.js';
import { forgetAlerts } from './alertLog.js';
import { registerReports } from './report.js';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' }, trustProxy: cfg.TRUST_PROXY });
const io = new Server(app.server); // frontend disajikan dari origin yang sama → tidak perlu CORS
const manager = new MonitorManager(cfg.INTERVAL_MS);
const devices = new DeviceManager(manager.alerts); // Proxmox, NAS, Active Backup, ISP, FortiGate, MikroTik

registerAuth(app);

// ---------- Validasi input form ----------
const name = z.string().trim().min(1).max(60);
const host = z.string().trim().min(1).max(255);
const port = z.coerce.number().int().min(1).max(65535);
const ServerConn = z.object({
  engine: z.enum(['mariadb', 'postgres', 'mssql']),
  name,
  host,
  port,
  username: z.string().min(1).max(128),
  password: z.string().max(512),
  database: z.string().trim().max(128).optional(),
});
const SqliteConn = z.object({
  engine: z.literal('sqlite'),
  name,
  filePath: z.string().trim().min(1).max(1024),
});
const https = z.boolean().optional().default(true);
const ProxmoxConn = z.object({
  engine: z.literal('proxmox'),
  name,
  host,
  port: port.optional().default(8006),
  // Token ID lengkap, mis. monitor@pve!dbmon
  username: z.string().trim().regex(/^[^@\s]+@[^!\s]+![^\s]+$/, 'format token ID: user@realm!nama-token'),
  password: z.string().trim().min(1).max(200),
  options: z.object({ https, node: z.string().trim().max(60).optional() }).optional().default({}),
});
const PbsConn = z.object({
  engine: z.literal('pbs'),
  name,
  host,
  port: port.optional().default(8007),
  // Token ID lengkap, mis. monitor@pbs!dashboard
  username: z.string().trim().regex(/^[^@\s]+@[^!\s]+![^\s]+$/, 'format token ID: user@realm!nama-token'),
  password: z.string().trim().min(1).max(200),
  options: z
    .object({ https, staleHours: z.coerce.number().min(1).max(24 * 30).optional() })
    .optional()
    .default({}),
});
const SynologyConn = z.object({
  engine: z.enum(['synology', 'abb']),
  name,
  host,
  port: port.optional(),
  username: z.string().trim().min(1).max(128),
  password: z.string().max(512),
  options: z
    .object({ https, staleHours: z.coerce.number().min(1).max(24 * 30).optional() })
    .optional()
    .default({}),
});
const IspConn = z.object({
  engine: z.literal('isp'),
  name,
  host,
  options: z
    .object({
      provider: z.string().trim().max(60).optional(),
      slaTarget: z.coerce.number().min(90).max(100).optional().default(99.5),
      intervalSec: z.coerce.number().int().min(5).max(300).optional().default(10),
      method: z.enum(['ping', 'tcp']).optional().default('ping'),
      tcpPort: z.coerce.number().int().min(1).max(65535).optional(),
      latencyWarnMs: z.coerce.number().min(1).max(10_000).optional().default(100),
    })
    .optional()
    .default({}),
});
const FortiConn = z.object({
  engine: z.literal('fortigate'),
  name,
  host,
  port: port.optional(),
  // REST API key (System → Administrators → REST API Admin)
  password: z.string().trim().min(1, 'API key wajib diisi').max(200),
  options: z
    .object({
      https,
      vdom: z.string().trim().max(60).optional(),
      threats: z.boolean().optional(),
      siteLat: z.coerce.number().min(-60).max(85).optional(),
      siteLon: z.coerce.number().min(-180).max(180).optional(),
      siteLabel: z.string().trim().max(40).optional(),
      threatSpike: z.coerce.number().int().min(10).max(100000).optional(),
    })
    .optional()
    .default({}),
});
const MikrotikConn = z.object({
  engine: z.literal('mikrotik'),
  name,
  host,
  port: port.optional(),
  username: z.string().trim().min(1).max(128),
  password: z.string().max(512),
  options: z.object({ https: z.boolean().optional().default(false) }).optional().default({}),
});
const ConnInput = z.discriminatedUnion('engine', [ServerConn, SqliteConn, ProxmoxConn, PbsConn, SynologyConn, IspConn, FortiConn, MikrotikConn]);

function hostAllowed(host: string) {
  if (!cfg.ALLOWED_HOSTS.length) return true;
  const h = host.toLowerCase();
  return cfg.ALLOWED_HOSTS.some((rule) =>
    rule.startsWith('*.') ? h.endsWith(rule.slice(1)) : rule.endsWith('*') ? h.startsWith(rule.slice(0, -1)) : h === rule,
  );
}

type Prepared = { type: 'db'; input: Omit<ConnConfig, 'id'> } | { type: 'device'; input: Omit<DeviceConfig, 'id'> };

/** Validasi + normalisasi. Mengembalikan pesan error (string) bila ditolak. */
function prepare(body: unknown): Prepared | string {
  const parsed = ConnInput.safeParse(body);
  if (!parsed.success) {
    const f = parsed.error.flatten().fieldErrors as Record<string, string[] | undefined>;
    const first = Object.entries(f).find(([, v]) => v?.length);
    return first ? `Kolom "${first[0]}" tidak valid: ${first[1]![0]}` : 'Input tidak valid';
  }
  const input = parsed.data;
  if (input.engine === 'sqlite') {
    const full = cfg.SQLITE_DIR ? resolve(cfg.SQLITE_DIR, input.filePath) : resolve(input.filePath);
    if (cfg.SQLITE_DIR && !full.startsWith(cfg.SQLITE_DIR + sep)) {
      return `File SQLite harus berada di dalam folder ${cfg.SQLITE_DIR}`;
    }
    if (!existsSync(full)) return `File tidak ditemukan: ${full}`;
    return { type: 'db', input: { ...input, filePath: full } };
  }
  if (!hostAllowed(input.host)) return `Host "${input.host}" tidak diizinkan (lihat DBMON_ALLOWED_HOSTS)`;
  switch (input.engine) {
    case 'mariadb':
    case 'postgres':
    case 'mssql':
      return { type: 'db', input: { ...input, database: input.database || undefined } };
    case 'proxmox':
    case 'synology':
    case 'abb':
    case 'mikrotik': {
      const { engine, ...rest } = input;
      return { type: 'device', input: { ...rest, kind: engine, options: rest.options } };
    }
    case 'pbs': {
      const { engine, ...rest } = input;
      return { type: 'device', input: { ...rest, kind: engine, options: rest.options } };
    }
    case 'fortigate': {
      const { engine, ...rest } = input;
      return { type: 'device', input: { ...rest, kind: engine, options: rest.options } };
    }
    case 'isp': {
      const { engine, ...rest } = input;
      return { type: 'device', input: { ...rest, kind: engine, options: rest.options } };
    }
  }
}

const statusOf = (id: string) => (devices.has(id) ? devices.statusOf(id) : manager.statusOf(id));

// ---------- REST API ----------
app.get('/api/connections', async () => store.listPublic().map((c) => ({ ...c, ...statusOf(c.id) })));

/** Uji koneksi; mengembalikan keterangan singkat (versi, jumlah node/tugas, dst.) */
async function testPrepared(p: Prepared) {
  if (p.type === 'db') {
    await manager.test({ id: 'test', ...p.input });
    return 'Koneksi berhasil';
  }
  return devices.test({ id: 'test', ...p.input });
}

app.post('/api/connections/test', async (req, reply) => {
  if (rateLimited(`test:${clientIp(req)}`, 60)) return reply.code(429).send({ error: 'Terlalu banyak percobaan, tunggu sebentar.' });
  const p = prepare(req.body);
  if (typeof p === 'string') return reply.code(400).send({ error: p });
  try {
    return { ok: true, message: await testPrepared(p) };
  } catch (e) {
    return reply.code(422).send({ error: `Gagal terhubung: ${(e as Error).message}` });
  }
});

app.post('/api/connections', async (req, reply) => {
  if (rateLimited(`test:${clientIp(req)}`, 60)) return reply.code(429).send({ error: 'Terlalu banyak percobaan, tunggu sebentar.' });
  const p = prepare(req.body);
  if (typeof p === 'string') return reply.code(400).send({ error: p });
  try {
    await testPrepared(p); // tolak kredensial salah sejak awal
  } catch (e) {
    return reply.code(422).send({ error: `Gagal terhubung: ${(e as Error).message}` });
  }
  if (p.type === 'db') {
    const saved = store.insert(p.input);
    void manager.start(saved);
    return reply.code(201).send({ ...store.toPublic(saved), status: 'connecting' });
  }
  const saved = store.insertDevice(p.input);
  devices.start(saved);
  return reply.code(201).send({ ...store.toPublic(saved), status: 'connecting' });
});

app.delete<{ Params: { id: string } }>('/api/connections/:id', async (req, reply) => {
  await manager.remove(req.params.id);
  await devices.remove(req.params.id);
  forgetAlerts(req.params.id);
  return store.remove(req.params.id) ? reply.code(204).send() : reply.code(404).send({ error: 'not found' });
});

/** Data mentah terakhir dari perangkat (diagnosa API yang tidak terdokumentasi, mis. Active Backup) */
app.get<{ Params: { id: string } }>('/api/connections/:id/raw', async (req, reply) => {
  if (!devices.has(req.params.id)) return reply.code(404).send({ error: 'Hanya untuk perangkat' });
  return { raw: devices.raw(req.params.id) };
});

const RANGES: Record<string, number> = {
  '15m': 15 * 60_000,
  '1h': 3600_000,
  '6h': 6 * 3600_000,
  '24h': 24 * 3600_000,
  '7d': 7 * 86400_000,
  '30d': 30 * 86400_000,
};

/** ?range=live → titik per-detik 5 menit terakhir; 15m/1h/6h/24h → ringkasan per bucket */
app.get<{ Params: { id: string }; Querystring: { range?: string } }>('/api/connections/:id/history', async (req) => {
  const range = req.query.range ?? 'live';
  if (devices.has(req.params.id)) {
    // Perangkat: "live" = 30 menit terakhir dari memori
    const ms = range === 'live' || !RANGES[range] ? 30 * 60_000 : RANGES[range];
    return { range, points: devices.range(req.params.id, ms) };
  }
  if (range === 'live' || !RANGES[range]) return { range: 'live', points: manager.live(req.params.id) };
  return { range, points: manager.range(req.params.id, RANGES[range]) };
});

/** Sesi, lock, slow query & alert terbaru (untuk tampilan awal sebelum event socket berikutnya) */
app.get<{ Params: { id: string } }>('/api/connections/:id/details', async (req) => ({
  details: manager.detailsOf(req.params.id),
  device: devices.snapshot(req.params.id),
  alerts: manager.alerts.snapshot(req.params.id),
}));

// ---------- Laporan (ringkasan & unduh CSV) ----------
registerReports(app, devices);

// ---------- Agen CPU & RAM ----------
const AgentInput = z.object({
  agentUrl: z.string().trim().max(300).optional().default(''),
  agentToken: z.string().trim().max(300).optional().default(''),
});

app.put<{ Params: { id: string } }>('/api/connections/:id/agent', async (req, reply) => {
  const current = store.getWithSecrets(req.params.id);
  if (!current) return reply.code(404).send({ error: 'Koneksi tidak ditemukan' });
  const parsed = AgentInput.safeParse(req.body ?? {});
  if (!parsed.success) return reply.code(400).send({ error: 'Input tidak valid' });
  let { agentUrl, agentToken } = parsed.data;

  // URL kosong = lepas agen
  if (!agentUrl) {
    store.updateAgent(current.id, null, null);
    manager.setAgent(current.id);
    return { ok: true, hasAgent: false };
  }
  if (!/^https?:\/\//i.test(agentUrl)) agentUrl = `http://${agentUrl}`;
  let url: URL;
  try {
    url = new URL(agentUrl);
  } catch {
    return reply.code(400).send({ error: 'Agent URL tidak valid. Contoh: http://192.168.10.20:9187' });
  }
  if (!hostAllowed(url.hostname)) return reply.code(400).send({ error: `Host "${url.hostname}" tidak diizinkan (lihat DBMON_ALLOWED_HOSTS)` });
  // Token dikosongkan saat mengedit = pakai token lama
  if (!agentToken && current.agentUrl) agentToken = current.agentToken ?? '';
  if (!agentToken) return reply.code(400).send({ error: 'Token agen wajib diisi' });

  if (rateLimited(`agent:${clientIp(req)}`, 60)) return reply.code(429).send({ error: 'Terlalu banyak percobaan, tunggu sebentar.' });
  const base = url.origin + url.pathname.replace(/\/+$/, '');
  try {
    const m = await fetchAgent(base, agentToken);
    store.updateAgent(current.id, base, agentToken);
    manager.setAgent(current.id, base, agentToken);
    return { ok: true, hasAgent: true, agentUrl: base, hostname: m.hostname, cpuPct: m.cpuPct, memPct: m.memPct };
  } catch (e) {
    return reply.code(422).send({ error: `Agen tidak bisa dihubungi: ${agentErrorMessage(e)}` });
  }
});

// ---------- Frontend (hasil build React) ----------
if (existsSync(join(cfg.STATIC_DIR, 'index.html'))) {
  await app.register(fastifyStatic, { root: cfg.STATIC_DIR, wildcard: false });
  // SPA fallback: rute non-API yang tidak dikenal → index.html
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
    return reply.code(404).send({ error: 'not found' });
  });
} else {
  app.log.warn(`Frontend belum di-build (tidak ada ${cfg.STATIC_DIR}/index.html). Hanya API yang aktif.`);
}

// ---------- WebSocket (real-time) ----------
io.use((socket, next) =>
  verifyToken(readCookie(socket.handshake.headers.cookie)) ? next() : next(new Error('unauthorized')),
);

// Browser hanya menerima metrik koneksi yang di-subscribe (room per koneksi)
io.on('connection', (socket) => {
  socket.on('subscribe', (ids: unknown) => {
    if (!Array.isArray(ids)) return;
    for (const id of ids) {
      if (typeof id !== 'string') continue;
      void socket.join(`conn:${id}`);
      // Kirim kondisi terkini langsung, tanpa menunggu siklus berikutnya
      socket.emit('alerts', manager.alerts.snapshot(id));
      const d = manager.detailsOf(id);
      if (d) socket.emit('details', d);
      const dev = devices.snapshot(id);
      if (dev) socket.emit('device', dev);
    }
  });
  socket.on('unsubscribe', (ids: unknown) => {
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') void socket.leave(`conn:${id}`);
  });
});

manager.on('metric', (p) => io.to(`conn:${p.connId}`).emit('metric', p));
manager.on('status', (s) => io.emit('status', s));
manager.on('details', (d) => io.to(`conn:${d.connId}`).emit('details', d));
manager.on('alerts', (a) => io.to(`conn:${a.connId}`).emit('alerts', a));
devices.on('device', (d) => io.to(`conn:${d.connId}`).emit('device', d));
devices.on('status', (s) => io.emit('status', s));
devices.on('alerts', (a) => io.to(`conn:${a.connId}`).emit('alerts', a));

// ---------- Startup & shutdown ----------
for (const src of store.listSources()) {
  if (src.type === 'db') void manager.start(src.cfg);
  else devices.start(src.cfg);
}

const shutdown = async () => {
  await manager.stopAll();
  await devices.stopAll();
  io.close();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  await app.listen({ port: cfg.PORT, host: cfg.HOST });
} catch (e) {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'EADDRINUSE') {
    fatal(
      `port ${cfg.PORT} sudah dipakai program lain (mungkin Dashboard Monitoring System masih berjalan di jendela lain).\n` +
        `  Tutup program tersebut, atau pakai port lain. Windows: buka file start.bat dengan Notepad,\n` +
        `  lalu tambahkan baris "set PORT=3001" di bawah baris "setlocal".`,
    );
  }
  if (code === 'EACCES') fatal(`tidak punya izin memakai port ${cfg.PORT}. Coba port lain, mis. PORT=3001.`);
  fatal('server gagal dinyalakan', e);
}

// ---------- Info untuk pengguna ----------
const lanIps = Object.values(networkInterfaces())
  .flatMap((list: NetworkInterfaceInfo[] | undefined) => list ?? [])
  .filter((n) => n.family === 'IPv4' && !n.internal)
  .map((n) => n.address);

const lines = [
  '',
  '  Dashboard Monitoring System siap dipakai',
  `  • Komputer ini : http://localhost:${cfg.PORT}`,
  ...lanIps.map((ip) => `  • Dari HP (Wi-Fi sama): http://${ip}:${cfg.PORT}`),
];
if (cfg.ADMIN_PASSWORD_SOURCE === 'generated') {
  lines.push(`  • Password login (dibuat otomatis): ${cfg.ADMIN_PASSWORD}`, `    tersimpan di ${cfg.ADMIN_PASSWORD_FILE}`);
} else if (cfg.ADMIN_PASSWORD_SOURCE === 'file') {
  lines.push(`  • Password login ada di ${cfg.ADMIN_PASSWORD_FILE} (bisa diganti lewat menu ⚙ di aplikasi)`);
} else if (cfg.ADMIN_PASSWORD_SOURCE === 'hash') {
  lines.push('  • Password login: yang sudah Anda ganti lewat aplikasi', `    Lupa? Hapus ${cfg.ADMIN_HASH_FILE} lalu jalankan ulang (password baru dibuat)`);
} else {
  lines.push('  • Password login: nilai DBMON_ADMIN_PASSWORD');
}
lines.push('', '  Biarkan jendela ini terbuka selama aplikasi dipakai. Tekan Ctrl+C untuk berhenti.');
console.log(lines.join('\n') + '\n');

// start.bat menyetel DBMON_OPEN_BROWSER=1 → dashboard langsung terbuka di browser
if (process.env.DBMON_OPEN_BROWSER === '1') {
  const url = `http://localhost:${cfg.PORT}`;
  try {
    const child =
      process.platform === 'win32'
        ? spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true })
        : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* tidak bisa membuka browser otomatis: tidak masalah, alamat sudah tercetak di atas */
  }
}
