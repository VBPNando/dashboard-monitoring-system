import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { DATA_DIR, HISTORY_DAYS, HISTORY_MINUTE_DAYS } from './config.js';

/**
 * Riwayat angka perangkat (Proxmox, NAS, Backup, ISP, FortiGate, MikroTik): rata-rata & maksimum
 * tiap kunci (cpu, mem, latency, ...) di data/metrics.sqlite.
 *  - device_1m : per menit, HISTORY_MINUTE_DAYS (bawaan 31 hari)
 *  - device_1h : per jam,   HISTORY_DAYS (bawaan 400 hari), n = jumlah menit berisi data
 */
const MIN = 60_000;
const HOUR = 3600_000;
const db = new DatabaseSync(join(DATA_DIR, 'metrics.sqlite'));
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS device_1m (
    source_id TEXT NOT NULL, ts INTEGER NOT NULL, k TEXT NOT NULL, avg REAL, max REAL,
    PRIMARY KEY (source_id, ts, k)
  ) WITHOUT ROWID
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS device_1h (
    source_id TEXT NOT NULL, ts INTEGER NOT NULL, k TEXT NOT NULL, avg REAL, max REAL, n INTEGER NOT NULL,
    PRIMARY KEY (source_id, ts, k)
  ) WITHOUT ROWID
`);
const ins = db.prepare('INSERT OR REPLACE INTO device_1m (source_id, ts, k, avg, max) VALUES (?, ?, ?, ?, ?)');

interface Acc {
  minute: number;
  sum: Record<string, number>;
  n: Record<string, number>;
  max: Record<string, number>;
}
const accs = new Map<string, Acc>();

function flush(id: string, a: Acc) {
  try {
    for (const k of Object.keys(a.n)) ins.run(id, a.minute, k, a.sum[k] / a.n[k], a.max[k]);
  } catch (e) {
    console.error('[dbmon] gagal menyimpan riwayat perangkat:', (e as Error).message);
  }
}

export function record(id: string, ts: number, series: Record<string, number | null>) {
  const minute = Math.floor(ts / MIN) * MIN;
  let a = accs.get(id);
  if (a && a.minute !== minute) {
    flush(id, a);
    a = undefined;
  }
  if (!a) {
    a = { minute, sum: {}, n: {}, max: {} };
    accs.set(id, a);
  }
  for (const [k, v] of Object.entries(series)) {
    if (v == null || !Number.isFinite(v)) continue;
    a.sum[k] = (a.sum[k] ?? 0) + v;
    a.n[k] = (a.n[k] ?? 0) + 1;
    a.max[k] = Math.max(a.max[k] ?? -Infinity, v);
  }
}

export function flushAll() {
  for (const [id, a] of accs) flush(id, a);
}

export function forget(id: string) {
  accs.delete(id);
  db.prepare('DELETE FROM device_1m WHERE source_id = ?').run(id);
  db.prepare('DELETE FROM device_1h WHERE source_id = ?').run(id);
}

export interface DevicePoint {
  ts: number;
  v: Record<string, number | null>;
  max?: Record<string, number | null>;
}

function sourceSql(from: number, to: number, bucketMs: number) {
  const hourDone = Math.floor(Date.now() / HOUR) * HOUR - HOUR;
  const useHourly = bucketMs >= HOUR || from < Date.now() - HISTORY_MINUTE_DAYS * 86400_000 + HOUR;
  const m = 'SELECT source_id, ts, k, avg, max, 1 AS n FROM device_1m';
  if (!useHourly) return { sql: `${m} WHERE source_id = ? AND ts >= ? AND ts < ?`, args: (id: string) => [id, from, to] };
  const split = Math.max(from, Math.min(to, hourDone));
  return {
    sql: `SELECT source_id, ts, k, avg, max, n FROM device_1h WHERE source_id = ? AND ts >= ? AND ts < ?
          UNION ALL ${m} WHERE source_id = ? AND ts >= ? AND ts < ?`,
    args: (id: string) => [id, from, split, id, split, to],
  };
}

export function query(id: string, from: number, bucketMs: number, to = Date.now() + MIN): DevicePoint[] {
  const b = Math.max(MIN, bucketMs);
  const src = sourceSql(from, to, b);
  const rows = db
    .prepare(
      `SELECT (ts / ${b}) * ${b} AS bucket, k, SUM(avg * n) / SUM(n) AS a, MAX(max) AS m
         FROM (${src.sql}) GROUP BY bucket, k ORDER BY bucket`,
    )
    .all(...src.args(id)) as { bucket: number; k: string; a: number | null; m: number | null }[];
  const map = new Map<number, DevicePoint>();
  for (const r of rows) {
    let p = map.get(r.bucket);
    if (!p) {
      p = { ts: r.bucket, v: {}, max: {} };
      map.set(r.bucket, p);
    }
    p.v[r.k] = r.a == null ? null : Math.round(r.a * 10) / 10;
    p.max![r.k] = r.m;
  }
  return [...map.values()];
}

/** Ringkasan satu periode per kunci: rata-rata, maksimum, menit berisi data. */
export function summary(id: string, from: number, to: number) {
  const src = sourceSql(from, to, HOUR);
  return db
    .prepare(`SELECT k, SUM(avg * n) / SUM(n) AS avg, MAX(max) AS max, SUM(n) AS minutes FROM (${src.sql}) GROUP BY k`)
    .all(...src.args(id)) as { k: string; avg: number | null; max: number | null; minutes: number }[];
}

function rollup() {
  const hourDone = Math.floor(Date.now() / HOUR) * HOUR;
  const last = (db.prepare('SELECT MAX(ts) AS t FROM device_1h').get() as { t: number | null }).t;
  const first = (db.prepare('SELECT MIN(ts) AS t FROM device_1m').get() as { t: number | null }).t;
  if (first == null) return;
  const from = Math.min(last != null ? last + HOUR : first, hourDone - 2 * HOUR);
  db.prepare(
    `INSERT OR REPLACE INTO device_1h (source_id, ts, k, avg, max, n)
     SELECT source_id, (ts / ${HOUR}) * ${HOUR} AS h, k, AVG(avg), MAX(max), COUNT(*)
       FROM device_1m WHERE ts >= ? AND ts < ? GROUP BY source_id, h, k`,
  ).run(Math.floor(from / HOUR) * HOUR, hourDone);
}

export function maintain() {
  try {
    rollup();
    db.prepare('DELETE FROM device_1m WHERE ts < ?').run(Date.now() - HISTORY_MINUTE_DAYS * 86400_000);
    db.prepare('DELETE FROM device_1h WHERE ts < ?').run(Date.now() - HISTORY_DAYS * 86400_000);
  } catch (e) {
    console.error('[dbmon] gagal meringkas riwayat perangkat:', (e as Error).message);
  }
}
maintain();
setInterval(maintain, 10 * 60_000).unref();
