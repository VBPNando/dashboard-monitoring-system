import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { DATA_DIR } from '../config.js';

/**
 * Penyimpanan SLA ISP (data/isp.sqlite):
 *  - isp_1m       : ringkasan ping per menit (terkirim, terbalas, latency) → packet loss & cakupan pemantauan
 *  - isp_incident : gangguan (≥ N ping gagal berturut-turut) dengan waktu mulai & selesai
 * Disimpan 400 hari agar SLA bulanan & tahunan bisa dihitung.
 */
const db = new DatabaseSync(join(DATA_DIR, 'isp.sqlite'));
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS isp_1m (
    source_id TEXT NOT NULL, ts INTEGER NOT NULL,
    sent INTEGER NOT NULL, recv INTEGER NOT NULL, lat_sum REAL NOT NULL, lat_max REAL,
    PRIMARY KEY (source_id, ts)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS isp_incident (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT NOT NULL, start INTEGER NOT NULL, "end" INTEGER, reason TEXT
  );
  CREATE INDEX IF NOT EXISTS isp_incident_src ON isp_incident (source_id, start);
`);

const MIN = 60_000;
const RETENTION = 400 * 86400_000;

const upsert = db.prepare(`
  INSERT INTO isp_1m (source_id, ts, sent, recv, lat_sum, lat_max) VALUES (?, ?, 1, ?, ?, ?)
  ON CONFLICT (source_id, ts) DO UPDATE SET
    sent = sent + 1, recv = recv + excluded.recv, lat_sum = lat_sum + excluded.lat_sum,
    lat_max = MAX(COALESCE(lat_max, 0), COALESCE(excluded.lat_max, 0))`);

export function recordProbe(sourceId: string, ts: number, ok: boolean, ms: number | null) {
  upsert.run(sourceId, Math.floor(ts / MIN) * MIN, ok ? 1 : 0, ok && ms != null ? ms : 0, ok ? ms : null);
}

export function openIncident(sourceId: string, start: number, reason: string) {
  return Number(db.prepare('INSERT INTO isp_incident (source_id, start, reason) VALUES (?, ?, ?)').run(sourceId, start, reason).lastInsertRowid);
}

export function closeIncident(id: number, end: number) {
  db.prepare('UPDATE isp_incident SET "end" = ? WHERE id = ?').run(end, id);
}

/**
 * Saat Dashboard Monitoring System dinyalakan ulang: gangguan yang masih "terbuka" ditutup pada ping terakhir yang tercatat,
 * supaya waktu ketika Dashboard Monitoring System sendiri mati tidak dihitung sebagai downtime ISP.
 */
export function closeDangling(sourceId: string) {
  const last = db.prepare('SELECT MAX(ts) AS ts FROM isp_1m WHERE source_id = ?').get(sourceId) as { ts: number | null };
  db.prepare('UPDATE isp_incident SET "end" = MAX(start, ?) WHERE source_id = ? AND "end" IS NULL').run((last.ts ?? 0) + MIN, sourceId);
}

export interface Window {
  key: string;
  label: string;
  from: number;
  to: number;
}

/** Jendela waktu SLA: 24 jam, 7 hari, 30 hari, bulan berjalan, bulan lalu. */
export function windows(now = Date.now()): Window[] {
  const d = new Date(now);
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const prevStart = new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime();
  const monthName = (t: number) => new Date(t).toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
  return [
    { key: 'd1', label: '24 jam', from: now - 86400_000, to: now },
    { key: 'd7', label: '7 hari', from: now - 7 * 86400_000, to: now },
    { key: 'd30', label: '30 hari', from: now - 30 * 86400_000, to: now },
    { key: 'month', label: monthName(monthStart), from: monthStart, to: now },
    { key: 'prev', label: monthName(prevStart), from: prevStart, to: monthStart },
  ];
}

export interface SlaStat {
  key: string;
  label: string;
  /** % waktu tersedia selama periode yang terpantau */
  uptimePct: number | null;
  downtimeMs: number;
  incidents: number;
  /** % waktu periode yang benar-benar dipantau Dashboard Monitoring System */
  coveragePct: number;
  lossPct: number | null;
  latencyAvg: number | null;
}

export function sla(sourceId: string, w: Window, now = Date.now()): SlaStat {
  const agg = db
    .prepare(
      `SELECT COUNT(*) AS minutes, COALESCE(SUM(sent), 0) AS sent, COALESCE(SUM(recv), 0) AS recv, COALESCE(SUM(lat_sum), 0) AS lat
         FROM isp_1m WHERE source_id = ? AND ts >= ? AND ts < ?`,
    )
    .get(sourceId, Math.floor(w.from / MIN) * MIN, w.to) as { minutes: number; sent: number; recv: number; lat: number };
  const inc = db
    .prepare(
      `SELECT start, COALESCE("end", ?) AS e FROM isp_incident
        WHERE source_id = ? AND start < ? AND COALESCE("end", ?) > ?`,
    )
    .all(now, sourceId, w.to, now, w.from) as { start: number; e: number }[];
  const downtimeMs = inc.reduce((a, i) => a + Math.max(0, Math.min(i.e, w.to) - Math.max(i.start, w.from)), 0);
  const coveredMs = agg.minutes * MIN;
  return {
    key: w.key,
    label: w.label,
    uptimePct: coveredMs > 0 ? Math.max(0, Math.min(100, (1 - downtimeMs / coveredMs) * 100)) : null,
    downtimeMs,
    incidents: inc.length,
    coveragePct: Math.min(100, (coveredMs / Math.max(MIN, w.to - w.from)) * 100),
    lossPct: agg.sent ? ((agg.sent - agg.recv) / agg.sent) * 100 : null,
    latencyAvg: agg.recv ? agg.lat / agg.recv : null,
  };
}

export function incidents(sourceId: string, since: number, limit = 30) {
  return (
    db
      .prepare(`SELECT id, start, "end" AS end, reason FROM isp_incident WHERE source_id = ? AND COALESCE("end", start) >= ? ORDER BY start DESC LIMIT ?`)
      .all(sourceId, since, limit) as { id: number; start: number; end: number | null; reason: string | null }[]
  ).map((r) => ({ ...r, durationMs: (r.end ?? Date.now()) - r.start, ongoing: r.end == null }));
}

/** Gangguan yang beririsan dengan periode [from, to) — untuk laporan */
export function incidentsBetween(sourceId: string, from: number, to: number) {
  const now = Date.now();
  return (
    db
      .prepare(`SELECT id, start, "end" AS end, reason FROM isp_incident WHERE source_id = ? AND start < ? AND COALESCE("end", ?) > ? ORDER BY start`)
      .all(sourceId, to, now, from) as { id: number; start: number; end: number | null; reason: string | null }[]
  ).map((r) => ({ ...r, durationMs: Math.min(r.end ?? now, to) - Math.max(r.start, from), ongoing: r.end == null }));
}

export function forget(sourceId: string) {
  db.prepare('DELETE FROM isp_1m WHERE source_id = ?').run(sourceId);
  db.prepare('DELETE FROM isp_incident WHERE source_id = ?').run(sourceId);
}

setInterval(() => {
  try {
    const cut = Date.now() - RETENTION;
    db.prepare('DELETE FROM isp_1m WHERE ts < ?').run(cut);
    db.prepare('DELETE FROM isp_incident WHERE "end" IS NOT NULL AND "end" < ?').run(cut);
  } catch {
    /* abaikan */
  }
}, 3600_000).unref();
