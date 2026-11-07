import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { DATA_DIR } from '../config.js';

/**
 * Riwayat serangan dari log FortiGate (IPS, DoS/anomaly, antivirus) di data/threats.sqlite.
 * Kejadian yang sama (nama serangan, IP asal, tujuan, aksi) dalam satu menit digabung dan dihitung (×N).
 */
const RETENTION_MS = 90 * 86400_000;
const db = new DatabaseSync(join(DATA_DIR, 'threats.sqlite'));
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS fw_threat (
    source_id TEXT NOT NULL,
    minute INTEGER NOT NULL,
    last_ts INTEGER NOT NULL,
    kind TEXT NOT NULL,          -- IPS | DoS | Malware
    dir TEXT NOT NULL,           -- in | out | lan
    name TEXT NOT NULL,
    severity TEXT NOT NULL,      -- critical | high | medium | low | info
    blocked INTEGER NOT NULL,
    action TEXT,
    remote_ip TEXT,              -- penyerang (masuk) / tujuan luar (keluar)
    country TEXT,                -- negara pihak luar
    local_ip TEXT,               -- server/PC kantor
    port INTEGER,
    count INTEGER NOT NULL,
    PRIMARY KEY (source_id, minute, kind, dir, name, remote_ip, local_ip, blocked)
  ) WITHOUT ROWID
`);
db.exec('CREATE INDEX IF NOT EXISTS fw_threat_ts ON fw_threat (source_id, last_ts)');
db.exec(`CREATE TABLE IF NOT EXISTS fw_cursor (source_id TEXT NOT NULL, log TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (source_id, log))`);

export interface ThreatEvent {
  ts: number;
  kind: 'IPS' | 'DoS' | 'Malware';
  dir: 'in' | 'out' | 'lan';
  name: string;
  severity: string;
  blocked: boolean;
  action: string;
  remoteIp: string;
  country: string;
  localIp: string;
  port: number | null;
  count: number;
}

const upsert = db.prepare(`
  INSERT INTO fw_threat (source_id, minute, last_ts, kind, dir, name, severity, blocked, action, remote_ip, country, local_ip, port, count)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (source_id, minute, kind, dir, name, remote_ip, local_ip, blocked)
  DO UPDATE SET count = count + excluded.count, last_ts = MAX(last_ts, excluded.last_ts),
    severity = CASE WHEN excluded.severity = 'critical' OR severity = 'critical' THEN 'critical'
                    WHEN excluded.severity = 'high' OR severity = 'high' THEN 'high' ELSE severity END
`);

export function add(sourceId: string, events: ThreatEvent[]) {
  if (!events.length) return;
  db.exec('BEGIN');
  try {
    for (const e of events) {
      upsert.run(sourceId, Math.floor(e.ts / 60_000) * 60_000, e.ts, e.kind, e.dir, e.name.slice(0, 200), e.severity, e.blocked ? 1 : 0, e.action, e.remoteIp, e.country, e.localIp, e.port, e.count);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function cursor(sourceId: string, log: string): number {
  const r = db.prepare('SELECT ts FROM fw_cursor WHERE source_id = ? AND log = ?').get(sourceId, log) as { ts: number } | undefined;
  return r?.ts ?? 0;
}
export function setCursor(sourceId: string, log: string, ts: number) {
  db.prepare('INSERT OR REPLACE INTO fw_cursor (source_id, log, ts) VALUES (?, ?, ?)').run(sourceId, log, ts);
}

type Row = Record<string, string | number | null>;
const SEV_ORDER = `CASE severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END`;

/** Ringkasan untuk panel: angka, peringkat, data peta, daftar terbaru */
export function summary(sourceId: string, since: number, recentLimit = 60) {
  const q = (sql: string, ...args: (string | number)[]) => db.prepare(sql).all(sourceId, since, ...args) as Row[];
  const where = 'source_id = ? AND last_ts >= ?';
  const totals = q(
    `SELECT dir, severity, blocked, SUM(count) AS n FROM fw_threat WHERE ${where} GROUP BY dir, severity, blocked`,
  );
  const top = (col: string, extra = '') =>
    q(`SELECT ${col} AS k, SUM(count) AS n, MAX(${SEV_ORDER}) AS sev FROM fw_threat WHERE ${where} ${extra} AND ${col} IS NOT NULL AND ${col} != '' GROUP BY ${col} ORDER BY n DESC LIMIT 6`);
  const countries = q(
    `SELECT dir, country, SUM(count) AS n, MAX(${SEV_ORDER}) AS sev, MAX(last_ts) AS last FROM fw_threat WHERE ${where} AND dir != 'lan' GROUP BY dir, country ORDER BY n DESC LIMIT 60`,
  );
  const recent = db
    .prepare(
      `SELECT last_ts AS ts, kind, dir, name, severity, blocked, action, remote_ip AS remoteIp, country, local_ip AS localIp, port, count
         FROM fw_threat WHERE source_id = ? ORDER BY last_ts DESC LIMIT ?`,
    )
    .all(sourceId, recentLimit) as Row[];
  return {
    totals,
    topCountries: top('country', "AND dir = 'in'"),
    topAttacks: top('name'),
    topTargets: top('local_ip', "AND dir = 'in'"),
    infected: top('local_ip', "AND dir = 'out'"),
    countries,
    recent,
  };
}

/** Jumlah serangan untuk alert (n menit terakhir) */
export function recentCount(sourceId: string, sinceMs: number, cond: string) {
  const r = db.prepare(`SELECT COALESCE(SUM(count), 0) AS n FROM fw_threat WHERE source_id = ? AND last_ts >= ? AND ${cond}`).get(sourceId, sinceMs) as { n: number };
  return r.n;
}
export function recentRows(sourceId: string, sinceMs: number, cond: string, limit = 5) {
  return db
    .prepare(`SELECT name, remote_ip AS remoteIp, local_ip AS localIp, country, SUM(count) AS n FROM fw_threat WHERE source_id = ? AND last_ts >= ? AND ${cond} GROUP BY name, remote_ip, local_ip ORDER BY n DESC LIMIT ?`)
    .all(sourceId, sinceMs, limit) as { name: string; remoteIp: string; localIp: string; country: string; n: number }[];
}

/** Untuk laporan periode */
export function periodSummary(sourceId: string, from: number, to: number) {
  const args = [sourceId, from, to] as const;
  const where = 'source_id = ? AND last_ts >= ? AND last_ts < ?';
  const total = db.prepare(`SELECT COALESCE(SUM(count),0) AS n, COALESCE(SUM(CASE WHEN blocked=1 THEN count END),0) AS blocked,
      COALESCE(SUM(CASE WHEN severity='critical' THEN count END),0) AS critical, COALESCE(SUM(CASE WHEN severity='high' THEN count END),0) AS high,
      COALESCE(SUM(CASE WHEN dir='out' THEN count END),0) AS outbound FROM fw_threat WHERE ${where}`).get(...args) as { n: number; blocked: number; critical: number; high: number; outbound: number };
  const topCountries = db.prepare(`SELECT country AS k, SUM(count) AS n FROM fw_threat WHERE ${where} AND dir='in' AND country != '' GROUP BY country ORDER BY n DESC LIMIT 5`).all(...args) as { k: string; n: number }[];
  const topAttacks = db.prepare(`SELECT name AS k, SUM(count) AS n, MAX(${SEV_ORDER}) AS sev FROM fw_threat WHERE ${where} GROUP BY name ORDER BY n DESC LIMIT 5`).all(...args) as { k: string; n: number; sev: number }[];
  return { ...total, topCountries, topAttacks };
}

export function forget(sourceId: string) {
  db.prepare('DELETE FROM fw_threat WHERE source_id = ?').run(sourceId);
  db.prepare('DELETE FROM fw_cursor WHERE source_id = ?').run(sourceId);
}

setInterval(() => {
  try {
    db.prepare('DELETE FROM fw_threat WHERE last_ts < ?').run(Date.now() - RETENTION_MS);
  } catch {
    /* abaikan */
  }
}, 3600_000).unref();
