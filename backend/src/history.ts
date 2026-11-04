import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { DATA_DIR, HISTORY_DAYS, HISTORY_MINUTE_DAYS } from './config.js';
import type { MetricPoint } from './collectors/types.js';

/**
 * Riwayat metrik database jangka panjang (data/metrics.sqlite):
 *  - metrics_1m : ringkasan per MENIT, disimpan HISTORY_MINUTE_DAYS (bawaan 31 hari)
 *  - metrics_1h : ringkasan per JAM, disimpan HISTORY_DAYS (bawaan 400 hari) → laporan bulanan/tahunan
 * Kolom n = jumlah menit berisi data dalam satu jam (untuk rata-rata terbobot & cakupan data).
 */
const MINUTE = 60_000;
const HOUR = 3600_000;
const MINUTE_RETENTION_MS = HISTORY_MINUTE_DAYS * 86400_000;
const HOUR_RETENTION_MS = HISTORY_DAYS * 86400_000;

const db = new DatabaseSync(join(DATA_DIR, 'metrics.sqlite'));
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS metrics_1m (
    conn_id TEXT NOT NULL,
    ts      INTEGER NOT NULL,
    qps REAL, qps_max REAL, tps REAL,
    lat_avg REAL, lat_max REAL,
    active REAL, total REAL, max_conn REAL,
    reads REAL, writes REAL,
    sel REAL, ins REAL, upd REAL, del REAL,
    cpu REAL, mem REAL,
    PRIMARY KEY (conn_id, ts)
  ) WITHOUT ROWID
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS metrics_1h (
    conn_id TEXT NOT NULL,
    ts      INTEGER NOT NULL,
    n INTEGER NOT NULL,
    qps REAL, qps_max REAL, tps REAL,
    lat_avg REAL, lat_max REAL,
    active REAL, total REAL, max_conn REAL,
    reads REAL, writes REAL,
    sel REAL, ins REAL, upd REAL, del REAL,
    cpu REAL, mem REAL,
    PRIMARY KEY (conn_id, ts)
  ) WITHOUT ROWID
`);

/** Kolom yang dirata-ratakan per menit, beserta cara mengambil nilainya dari titik. */
const AVG_FIELDS: [string, (p: MetricPoint) => number | null | undefined][] = [
  ['qps', (p) => p.qps],
  ['tps', (p) => p.tps],
  ['lat_avg', (p) => p.latencyAvgMs],
  ['active', (p) => p.activeConnections],
  ['total', (p) => p.totalConnections],
  ['max_conn', (p) => p.maxConnections],
  ['reads', (p) => p.reads],
  ['writes', (p) => p.writes],
  ['sel', (p) => p.ops?.select],
  ['ins', (p) => p.ops?.insert],
  ['upd', (p) => p.ops?.update],
  ['del', (p) => p.ops?.delete],
  ['cpu', (p) => p.host?.cpuPct],
  ['mem', (p) => p.host?.memPct],
];
const MAX_FIELDS: [string, (p: MetricPoint) => number | null | undefined][] = [
  ['qps_max', (p) => p.qps],
  ['lat_max', (p) => p.latencyMaxMs],
];
const ALL = [...AVG_FIELDS, ...MAX_FIELDS].map(([k]) => k);

const insertStmt = db.prepare(
  `INSERT OR REPLACE INTO metrics_1m (conn_id, ts, ${ALL.join(', ')})
   VALUES (@conn_id, @ts, ${ALL.map((k) => '@' + k).join(', ')})`,
);

interface Acc {
  minute: number;
  sum: Record<string, number>;
  n: Record<string, number>;
  max: Record<string, number>;
}
const accs = new Map<string, Acc>();

function flush(connId: string, a: Acc) {
  const row: Record<string, number | string | null> = { conn_id: connId, ts: a.minute };
  for (const [k] of AVG_FIELDS) row[k] = a.n[k] ? a.sum[k] / a.n[k] : null;
  for (const [k] of MAX_FIELDS) row[k] = k in a.max ? a.max[k] : null;
  try {
    insertStmt.run(row);
  } catch (e) {
    console.error('[dbmon] gagal menyimpan riwayat:', (e as Error).message);
  }
}

/** Tambahkan satu titik per-detik ke ringkasan menit berjalan. */
export function record(p: MetricPoint) {
  const minute = Math.floor(p.ts / MINUTE) * MINUTE;
  let a = accs.get(p.connId);
  if (a && a.minute !== minute) {
    flush(p.connId, a);
    a = undefined;
  }
  if (!a) {
    a = { minute, sum: {}, n: {}, max: {} };
    accs.set(p.connId, a);
  }
  for (const [k, get] of AVG_FIELDS) {
    const v = get(p);
    if (v != null && Number.isFinite(v)) {
      a.sum[k] = (a.sum[k] ?? 0) + v;
      a.n[k] = (a.n[k] ?? 0) + 1;
    }
  }
  for (const [k, get] of MAX_FIELDS) {
    const v = get(p);
    if (v != null && Number.isFinite(v)) a.max[k] = Math.max(a.max[k] ?? -Infinity, v);
  }
}

/** Simpan menit yang sedang berjalan (dipanggil saat shutdown). */
export function flushAll() {
  for (const [id, a] of accs) flush(id, a);
}

export function forget(connId: string) {
  accs.delete(connId);
  db.prepare('DELETE FROM metrics_1m WHERE conn_id = ?').run(connId);
  db.prepare('DELETE FROM metrics_1h WHERE conn_id = ?').run(connId);
}

/** Titik riwayat dalam format yang sama dengan titik live (agar grafik bisa memakai keduanya). */
export interface HistoryPoint {
  ts: number;
  qps: number | null;
  qpsMax: number | null;
  tps: number | null;
  latencyAvgMs: number | null;
  latencyMaxMs: number | null;
  activeConnections: number | null;
  totalConnections: number | null;
  maxConnections: number | null;
  reads: number | null;
  writes: number | null;
  ops: { select: number | null; insert: number | null; update: number | null; delete: number | null };
  cpuPct: number | null;
  memPct: number | null;
}

const AVG_COLS = ['qps', 'tps', 'lat_avg', 'active', 'total', 'reads', 'writes', 'sel', 'ins', 'upd', 'del', 'cpu', 'mem'];
const MAX_COLS = ['qps_max', 'lat_max', 'max_conn'];
const COLS = ['conn_id', 'ts', 'n', ...AVG_COLS, ...MAX_COLS];

/**
 * Sumber baris untuk rentang [from, to): tabel jam untuk data lama / resolusi kasar,
 * ditambah tabel menit untuk jam berjalan yang belum diringkas.
 */
function sourceSql(from: number, to: number, bucketMs: number) {
  const hourDone = Math.floor(Date.now() / HOUR) * HOUR - HOUR; // jam yang pasti sudah diringkas
  const useHourly = bucketMs >= HOUR || from < Date.now() - MINUTE_RETENTION_MS + HOUR;
  const m = `SELECT conn_id, ts, 1 AS n, ${[...AVG_COLS, ...MAX_COLS].join(', ')} FROM metrics_1m`;
  if (!useHourly) return { sql: `${m} WHERE conn_id = ? AND ts >= ? AND ts < ?`, args: (id: string) => [id, from, to] };
  const split = Math.max(from, Math.min(to, hourDone));
  return {
    sql: `SELECT ${COLS.join(', ')} FROM metrics_1h WHERE conn_id = ? AND ts >= ? AND ts < ?
          UNION ALL ${m} WHERE conn_id = ? AND ts >= ? AND ts < ?`,
    args: (id: string) => [id, from, split, id, split, to],
  };
}

const w = (c: string) => `SUM(${c} * n) / NULLIF(SUM(CASE WHEN ${c} IS NULL THEN 0 ELSE n END), 0) AS ${c}`;

export function query(connId: string, fromTs: number, bucketMs: number, toTs = Date.now() + MINUTE): HistoryPoint[] {
  const b = Math.max(MINUTE, bucketMs);
  const src = sourceSql(fromTs, toTs, b);
  const rows = db
    .prepare(
      `SELECT (ts / ${b}) * ${b} AS bucket, ${AVG_COLS.map(w).join(', ')}, ${MAX_COLS.map((c) => `MAX(${c}) AS ${c}`).join(', ')}
         FROM (${src.sql}) GROUP BY bucket ORDER BY bucket`,
    )
    .all(...src.args(connId)) as Record<string, number | null>[];
  const r1 = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10);
  return rows.map((r) => ({
    ts: Number(r.bucket),
    qps: r1(r.qps),
    qpsMax: r1(r.qps_max),
    tps: r1(r.tps),
    latencyAvgMs: r1(r.lat_avg),
    latencyMaxMs: r1(r.lat_max),
    activeConnections: r1(r.active),
    totalConnections: r1(r.total),
    maxConnections: r.max_conn,
    reads: r1(r.reads),
    writes: r1(r.writes),
    ops: { select: r1(r.sel), insert: r1(r.ins), update: r1(r.upd), delete: r1(r.del) },
    cpuPct: r1(r.cpu),
    memPct: r1(r.mem),
  }));
}

/** Ringkasan satu periode untuk laporan: rata-rata, maksimum, total query & cakupan data. */
export function summary(connId: string, from: number, to: number) {
  const src = sourceSql(from, to, HOUR);
  const r = db
    .prepare(
      `SELECT SUM(n) AS minutes, ${AVG_COLS.map(w).join(', ')}, ${MAX_COLS.map((c) => `MAX(${c}) AS ${c}`).join(', ')},
              MAX(cpu) AS cpu_max, MAX(mem) AS mem_max, MAX(active) AS active_max, MAX(total) AS total_max, MAX(tps) AS tps_max,
              SUM(qps * n * 60) AS queries, SUM(tps * n * 60) AS txs
         FROM (${src.sql})`,
    )
    .get(...src.args(connId)) as Record<string, number | null>;
  return r;
}

/** Ringkas menit → jam (jam yang sudah lewat; 2 jam terakhir diulang untuk data yang telat). */
function rollup() {
  const hourDone = Math.floor(Date.now() / HOUR) * HOUR;
  const last = (db.prepare('SELECT MAX(ts) AS t FROM metrics_1h').get() as { t: number | null }).t;
  const first = (db.prepare('SELECT MIN(ts) AS t FROM metrics_1m').get() as { t: number | null }).t;
  if (first == null) return;
  const from = Math.min(last != null ? last + HOUR : first, hourDone - 2 * HOUR);
  db.prepare(
    `INSERT OR REPLACE INTO metrics_1h (${COLS.join(', ')})
     SELECT conn_id, (ts / ${HOUR}) * ${HOUR} AS h, COUNT(*),
            ${AVG_COLS.map((c) => `AVG(${c})`).join(', ')}, ${MAX_COLS.map((c) => `MAX(${c})`).join(', ')}
       FROM metrics_1m WHERE ts >= ? AND ts < ? GROUP BY conn_id, h`,
  ).run(Math.floor(from / HOUR) * HOUR, hourDone);
}

export function maintain() {
  try {
    rollup();
    db.prepare('DELETE FROM metrics_1m WHERE ts < ?').run(Date.now() - MINUTE_RETENTION_MS);
    db.prepare('DELETE FROM metrics_1h WHERE ts < ?').run(Date.now() - HOUR_RETENTION_MS);
  } catch (e) {
    console.error('[dbmon] gagal meringkas riwayat:', (e as Error).message);
  }
}
maintain();
setInterval(maintain, 10 * 60_000).unref();
