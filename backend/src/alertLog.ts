import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { DATA_DIR, HISTORY_DAYS } from './config.js';
import type { Alert } from './alerts.js';

/**
 * Riwayat alert permanen (data/metrics.sqlite, tabel alert_log) untuk laporan:
 * kapan alert muncul, seberapa parah, kapan selesai. Disimpan HISTORY_DAYS hari.
 */
const db = new DatabaseSync(join(DATA_DIR, 'metrics.sqlite'));
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS alert_log (
    id TEXT PRIMARY KEY,
    conn_id TEXT NOT NULL,
    rule TEXT NOT NULL,
    severity TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT,
    start INTEGER NOT NULL,
    "end" INTEGER
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS alert_log_conn ON alert_log (conn_id, start)');

// Alert yang masih terbuka dari sesi sebelumnya: ditutup saat server dinyalakan ulang
db.prepare('UPDATE alert_log SET "end" = ? WHERE "end" IS NULL').run(Date.now());

const insert = db.prepare('INSERT OR REPLACE INTO alert_log (id, conn_id, rule, severity, title, message, start, "end") VALUES (?, ?, ?, ?, ?, ?, ?, NULL)');
// Saat alert memburuk (warning → critical), catat tingkat terparah
const update = db.prepare(
  `UPDATE alert_log SET title = ?, message = ?, severity = CASE WHEN severity = 'critical' THEN 'critical' ELSE ? END WHERE id = ?`,
);
const close = db.prepare('UPDATE alert_log SET "end" = ? WHERE id = ?');

const safe = (f: () => void) => {
  try {
    f();
  } catch (e) {
    console.error('[dbmon] gagal mencatat riwayat alert:', (e as Error).message);
  }
};

export const alertLog = {
  raise: (a: Alert) => safe(() => insert.run(a.id, a.connId, a.rule, a.severity, a.title, a.message, a.since)),
  update: (a: Alert) => safe(() => update.run(a.title, a.message, a.severity, a.id)),
  resolve: (a: Alert, at: number) => safe(() => close.run(at, a.id)),
};

export interface LoggedAlert {
  id: string;
  connId: string;
  rule: string;
  severity: 'critical' | 'warning';
  title: string;
  message: string | null;
  start: number;
  end: number | null;
}

/** Alert yang aktif (sebagian) di dalam periode [from, to) */
export function alertsBetween(connId: string, from: number, to: number): LoggedAlert[] {
  return db
    .prepare(
      `SELECT id, conn_id AS connId, rule, severity, title, message, start, "end" AS end FROM alert_log
        WHERE conn_id = ? AND start < ? AND COALESCE("end", ?) >= ? ORDER BY start`,
    )
    .all(connId, to, Date.now(), from) as unknown as LoggedAlert[];
}

export function forgetAlerts(connId: string) {
  safe(() => db.prepare('DELETE FROM alert_log WHERE conn_id = ?').run(connId));
}

setInterval(() => safe(() => db.prepare('DELETE FROM alert_log WHERE "end" IS NOT NULL AND "end" < ?').run(Date.now() - HISTORY_DAYS * 86400_000)), 3600_000).unref();
