import dgram from 'node:dgram';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { DATA_DIR } from '../config.js';

/**
 * Penerima syslog (UDP & TCP, bawaan port 514) untuk log yang dikirim QNAP lewat
 * QuLog Center → Log Sender → Send to Syslog Server (format RFC-3164). Contoh baris:
 *   <30>Nov 24 05:08:12 NAS01 qulogd[1234]: event log: Users: ---, Source IP: ---, Computer name: ---,
 *     Application: Hybrid Backup Sync, Category: Job Status, Content: [Hybrid Backup Sync] Finished Backup job: "Harian".
 *   <30>Nov 24 05:10:00 NAS01 qulogd[1234]: conn log: Users: budi, Source IP: 192.168.1.50, Computer name: PC-KASIR-01,
 *     Connection type: Samba, Accessed resources: NetBak/PC-KASIR-01/Dokumen/a.xlsx, Action: Add
 * Hanya log dari host yang didaftarkan sebagai "QNAP Backup" yang disimpan (lainnya diabaikan).
 * Disimpan di data/backup-events.sqlite agar status tugas tetap ada setelah Dashboard restart.
 */
export const SYSLOG_PORT = Number(process.env.DBMON_SYSLOG_PORT || 514);
const RETENTION_MS = 90 * 86400_000;

const db = new DatabaseSync(join(DATA_DIR, 'backup-events.sqlite'));
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS qb_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nas TEXT NOT NULL,           -- IP pengirim
    host TEXT,                   -- hostname di baris syslog
    ts INTEGER NOT NULL,
    app TEXT NOT NULL,
    job TEXT,
    kind TEXT,                   -- Backup | Sync | Restore | ...
    status TEXT NOT NULL,        -- running | success | warning | failed | stopped | info
    message TEXT NOT NULL,
    client TEXT
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS qb_event_nas_ts ON qb_event (nas, ts)');
db.exec(`
  CREATE TABLE IF NOT EXISTS qb_access (
    nas TEXT NOT NULL,
    share TEXT NOT NULL,         -- folder bersama (huruf kecil)
    client TEXT NOT NULL,        -- nama komputer / IP
    ip TEXT,
    user TEXT,
    first_ts INTEGER NOT NULL,
    last_ts INTEGER NOT NULL,
    n INTEGER NOT NULL,
    PRIMARY KEY (nas, share, client)
  ) WITHOUT ROWID
`);
db.exec(`CREATE TABLE IF NOT EXISTS qb_seen (nas TEXT PRIMARY KEY, host TEXT, last_ts INTEGER NOT NULL, n INTEGER NOT NULL)`);

// ── Pengurai ──
export type JobStatus = 'running' | 'success' | 'warning' | 'failed' | 'stopped' | 'info';
export interface ParsedEvent {
  app: string;
  job: string | null;
  kind: string | null;
  status: JobStatus;
  message: string;
  client: string | null;
}
export interface ParsedAccess {
  share: string;
  client: string;
  ip: string | null;
  user: string | null;
}

/** Aplikasi yang dianggap backup */
const BACKUP_APP = /hybrid backup|\bhbs\b|hyper data protect|\bhdp\b|netbak|backup|rtrr|rsync|snapshot replica/i;
/** Aksi tulis di access log (bukan baca/hapus/login) */
const WRITE_ACTION = /^(add|write|modify|create|create directory|rename|move|copy|upload)/i;

const field = (body: string, name: string) => {
  const m = body.match(new RegExp(`${name}: (.*?)(?:, [A-Z][A-Za-z ]+: |$)`));
  const v = m?.[1]?.trim();
  return v && v !== '---' ? v : null;
};

/** Hasil dari isi pesan; PRI syslog dipakai bila kata kunci tidak jelas */
export function statusOf(text: string, sev = 6): JobStatus {
  const t = text.toLowerCase();
  if (/with (errors|warnings?)|completed with warning|partially|sebagian/.test(t)) return 'warning';
  if (/fail|abort|abnormal|unable|could not|cannot|error code|gagal|timed? ?out|disconnected/.test(t)) return 'failed';
  if (/\bstopped\b|cancel|skipped|dibatalkan/.test(t)) return 'stopped';
  if (/finish|complete|success|succeeded|done|berhasil|selesai/.test(t)) return 'success';
  if (/\bstart|running|began|resum|mulai/.test(t)) return 'running';
  if (sev <= 3) return 'failed';
  if (sev === 4) return 'warning';
  return 'info';
}

export function parseLine(line: string): { host: string | null; sev: number; event?: ParsedEvent; access?: ParsedAccess } | null {
  const m = line.match(/^\s*(?:\d+ )?<(\d{1,3})>(?:1 )?(.*)$/s);
  if (!m) return null;
  const sev = Number(m[1]) % 8;
  let rest = m[2];
  // RFC-3164: "Nov 24 05:08:12 HOST tag[pid]: isi" · RFC-5424: "2026-11-24T05:08:12+07:00 HOST app pid msgid - isi"
  let host: string | null = null;
  const r3164 = rest.match(/^[A-Z][a-z]{2} +\d{1,2} \d\d:\d\d:\d\d (\S+) (.*)$/s);
  const r5424 = rest.match(/^\d{4}-\d\d-\d\dT\S+ (\S+) (.*)$/s);
  if (r3164) [, host, rest] = r3164;
  else if (r5424) [, host, rest] = r5424;
  // Buang tag proses ("qulogd[123]: "); "event log:" / "conn log:" dicari di mana pun posisinya
  const body = rest.replace(/^[\w.\-/]+(\[\d+\])?: ?/, '').trim();

  const ev = body.indexOf('event log:');
  if (ev >= 0) {
    const b = body.slice(ev + 10).trim();
    const content = (b.match(/Content: (.*)$/s)?.[1] ?? b).trim();
    const app = field(b, 'Application') ?? content.match(/^\[([^\]]+)\]/)?.[1] ?? '';
    if (!BACKUP_APP.test(app) && !BACKUP_APP.test(content.slice(0, 60))) return { host, sev };
    return { host, sev, event: eventOf(app || 'Backup', content, sev) };
  }
  const cl = body.indexOf('conn log:');
  if (cl >= 0) {
    const b = body.slice(cl + 9).trim();
    const action = field(b, 'Action') ?? '';
    const res = field(b, 'Accessed resources');
    if (!res || !WRITE_ACTION.test(action)) return { host, sev };
    const share = res.replace(/^\/+/, '').replace(/^share\//i, '').split('/')[0].toLowerCase();
    const ip = field(b, 'Source IP');
    const client = field(b, 'Computer name') ?? ip;
    if (!share || !client) return { host, sev };
    return { host, sev, access: { share, client, ip, user: field(b, 'Users') } };
  }
  // Baris tanpa format QuLog (mis. dari aplikasi lain) tetap dicoba bila menyebut aplikasi backup
  if (BACKUP_APP.test(body.slice(0, 80))) {
    const app = body.match(/^\[([^\]]+)\]/)?.[1] ?? 'Backup';
    return { host, sev, event: eventOf(app, body, sev) };
  }
  return { host, sev };
}

function eventOf(app: string, content: string, sev: number): ParsedEvent {
  const job = content.match(/["“”]([^"“”]{1,120})["“”]/)?.[1]?.trim() ?? null;
  const kind = content.match(/\b(backup|sync|synchroni[sz]ation|restore|replication|verification|copy)\s+(?:job|task|plan)/i)?.[1] ?? null;
  const client = content.match(/from client:?\s*["“”]?([^"“”,]+)["“”]?/i)?.[1]?.trim() ?? null;
  return {
    app: app.replace(/\(.*\)$/, '').trim(),
    job,
    kind: kind ? kind[0].toUpperCase() + kind.slice(1).toLowerCase().replace(/^synchroni.ation$/, 'Sync') : null,
    status: statusOf(content.replace(/^\[[^\]]+\]\s*/, ''), sev),
    message: content.replace(/^\[[^\]]+\]\s*/, '').slice(0, 500),
    client,
  };
}

// ── Penyimpanan ──
const insEvent = db.prepare('INSERT INTO qb_event (nas, host, ts, app, job, kind, status, message, client) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
const upAccess = db.prepare(`
  INSERT INTO qb_access (nas, share, client, ip, user, first_ts, last_ts, n) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  ON CONFLICT (nas, share, client) DO UPDATE SET last_ts = MAX(last_ts, excluded.last_ts), ip = COALESCE(excluded.ip, ip), user = COALESCE(excluded.user, user), n = n + 1
`);
const upSeen = db.prepare(`
  INSERT INTO qb_seen (nas, host, last_ts, n) VALUES (?, ?, ?, 1)
  ON CONFLICT (nas) DO UPDATE SET last_ts = MAX(last_ts, excluded.last_ts), host = COALESCE(excluded.host, host), n = n + 1
`);

/** Host yang didaftarkan (IP atau nama NAS, huruf kecil) → hanya log dari sini yang disimpan */
const watched = new Map<string, number>();
export function watch(host: string) {
  const h = host.toLowerCase();
  watched.set(h, (watched.get(h) ?? 0) + 1);
}
export function unwatch(host: string) {
  const h = host.toLowerCase();
  const n = (watched.get(h) ?? 1) - 1;
  if (n <= 0) watched.delete(h);
  else watched.set(h, n);
}

export function handle(line: string, fromIp: string, now = Date.now()) {
  const ip = fromIp.replace(/^::ffff:/, '');
  const p = parseLine(line);
  if (!p) return;
  if (!watched.has(ip) && !(p.host && watched.has(p.host.toLowerCase()))) return;
  upSeen.run(ip, p.host, now);
  if (p.event) {
    const e = p.event;
    insEvent.run(ip, p.host, now, e.app, e.job, e.kind, e.status, e.message, e.client);
  } else if (p.access) {
    const a = p.access;
    upAccess.run(ip, a.share, a.client, a.ip, a.user, now, now);
  }
}

/** Kondisi WHERE untuk satu NAS: cocok dengan IP pengirim atau hostname di syslog */
const match = (col: string) => `(${col} = ? OR lower(COALESCE(host, '')) = ?)`;

export interface StoredEvent {
  ts: number;
  app: string;
  job: string | null;
  kind: string | null;
  status: JobStatus;
  message: string;
  client: string | null;
}
const qEvents = db.prepare(`SELECT ts, app, job, kind, status, message, client FROM qb_event WHERE ${match('nas')} AND ts >= ? ORDER BY ts ASC, id ASC`);
export function events(host: string, sinceTs: number): StoredEvent[] {
  return qEvents.all(host, host.toLowerCase(), sinceTs) as unknown as StoredEvent[];
}
const qRecent = db.prepare(`SELECT ts, app, job, kind, status, message, client FROM qb_event WHERE ${match('nas')} ORDER BY ts DESC, id DESC LIMIT ?`);
export function recent(host: string, limit = 30): StoredEvent[] {
  return qRecent.all(host, host.toLowerCase(), limit) as unknown as StoredEvent[];
}
const qAccess = db.prepare(`SELECT share, client, ip, user, first_ts AS firstTs, last_ts AS lastTs, n FROM qb_access WHERE (nas = ? OR nas IN (SELECT nas FROM qb_seen WHERE lower(COALESCE(host,'')) = ?)) AND share = ? ORDER BY client`);
export function access(host: string, share: string) {
  return qAccess.all(host, host.toLowerCase(), share.toLowerCase()) as unknown as { share: string; client: string; ip: string | null; user: string | null; firstTs: number; lastTs: number; n: number }[];
}
const qSeen = db.prepare(`SELECT MAX(last_ts) AS last, SUM(n) AS n FROM qb_seen WHERE nas = ? OR lower(COALESCE(host,'')) = ?`);
export function seen(host: string): { last: number | null; n: number } {
  const r = qSeen.get(host, host.toLowerCase()) as { last: number | null; n: number | null };
  return { last: r?.last ?? null, n: r?.n ?? 0 };
}

let lastPrune = 0;
export function prune(now = Date.now()) {
  if (now - lastPrune < 3600_000) return;
  lastPrune = now;
  db.prepare('DELETE FROM qb_event WHERE ts < ?').run(now - RETENTION_MS);
  db.prepare('DELETE FROM qb_access WHERE last_ts < ?').run(now - RETENTION_MS);
}

// ── Listener (dinyalakan saat perangkat QNAP Backup pertama ditambahkan) ──
let state: { udp?: dgram.Socket; tcp?: net.Server; error?: string; ready?: Promise<void> } = {};

export function listenerError() {
  return state.error ?? null;
}

export function ensureListener(): Promise<void> {
  if (state.ready) return state.ready;
  state.ready = new Promise<void>((resolve) => {
    let pending = 2;
    const done = () => --pending === 0 && resolve();
    const fail = (proto: string) => (e: NodeJS.ErrnoException) => {
      state.error =
        e.code === 'EADDRINUSE'
          ? `Port ${SYSLOG_PORT}/${proto} sudah dipakai program lain (mis. syslog server lain). Ubah DBMON_SYSLOG_PORT di backend/.env lalu samakan di QNAP.`
          : e.code === 'EACCES'
            ? `Tidak diizinkan membuka port ${SYSLOG_PORT}/${proto}. Jalankan Dashboard sebagai layanan (menu.bat → 1) atau pakai port di atas 1024.`
            : `Penerima syslog ${proto} gagal: ${e.message}`;
      done();
    };

    const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    udp.on('message', (msg, rinfo) => {
      for (const line of msg.toString('utf8').split(/\r?\n/)) if (line.trim()) handle(line, rinfo.address);
    });
    udp.once('error', fail('UDP'));
    udp.bind(SYSLOG_PORT, () => {
      state.udp = udp;
      udp.on('error', () => {});
      done();
    });

    const tcp = net.createServer((sock) => {
      let buf = '';
      sock.setEncoding('utf8');
      sock.setTimeout(10 * 60_000, () => sock.destroy());
      sock.on('data', (chunk: string) => {
        buf += chunk;
        if (buf.length > 1_000_000) buf = buf.slice(-100_000);
        // Bingkai: "panjang <PRI>..." (octet counting) atau diakhiri baris baru
        for (;;) {
          const oc = buf.match(/^\s*(\d+) /);
          if (oc && buf.length >= oc[0].length + Number(oc[1])) {
            handle(buf.slice(oc[0].length, oc[0].length + Number(oc[1])), sock.remoteAddress ?? '');
            buf = buf.slice(oc[0].length + Number(oc[1]));
            continue;
          }
          const nl = buf.search(/[\r\n\0]/);
          if (!oc && nl >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (line.trim()) handle(line, sock.remoteAddress ?? '');
            continue;
          }
          break;
        }
      });
      sock.on('error', () => {});
    });
    tcp.once('error', fail('TCP'));
    tcp.listen(SYSLOG_PORT, () => {
      state.tcp = tcp;
      tcp.on('error', () => {});
      done();
    });
  });
  return state.ready;
}
