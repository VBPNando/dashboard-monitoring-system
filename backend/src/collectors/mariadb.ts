import mysql from 'mysql2/promise';
import type { Collector, ConnConfig, Details, RawSample, SessionInfo, SlowQuery } from './types.js';
import { ObservedSlowQueries, SerialQueue } from './observed.js';

const STATUS_VARS = [
  'Queries',
  'Threads_connected',
  'Threads_running',
  'Handler_commit',
  'Handler_rollback',
  'Com_select',
  'Qcache_hits', // SELECT yang dijawab query cache tidak masuk Com_select
  'Com_insert',
  'Com_insert_select',
  'Com_replace',
  'Com_replace_select',
  'Com_update',
  'Com_update_multi',
  'Com_delete',
  'Com_delete_multi',
];

const BUSY = `COMMAND NOT IN ('Sleep', 'Daemon', 'Binlog Dump', 'Binlog Dump GTID')`;

/**
 * MariaDB / MySQL.
 * - QPS      : Δ Queries
 * - TPS      : Δ (Handler_commit + Handler_rollback) — termasuk transaksi autocommit
 * - Jenis    : Δ Com_select (+Qcache_hits), Com_insert (+insert_select, replace), Com_update (+multi), Com_delete (+multi)
 * - Active   : PROCESSLIST yang sedang mengeksekusi (bukan Sleep / thread internal). Butuh hak PROCESS.
 * - Total    : Threads_connected;  Max: @@max_connections
 * - Latency  : performance_schema aktif & bisa dibaca → rata-rata semua statement (akurat);
 *              jika tidak → durasi query yang sedang berjalan (perkiraan)
 * - Slow     : performance_schema digest; jika tidak → dikumpulkan dari query berjalan yang teramati
 * Semua query milik Dashboard Monitoring System dikurangkan dari QPS & SELECT.
 */
export class MariaDbCollector implements Collector {
  private pool?: mysql.Pool;
  private queue = new SerialQueue();
  private ownTotal = 0;
  private ownSelect = 0;
  private canReadProcesslist = true;
  private hasTimeMs = true; // kolom TIME_MS hanya ada di MariaDB (MySQL: TIME dalam detik)
  private psStatements = false;
  private psDigest = false;
  private hasInnodbLockWaits = true;
  private maxConnections: number | null = null;
  private sampleCount = 0;
  private observed = new ObservedSlowQueries();

  constructor(private cfg: ConnConfig) {}

  /** Semua query lewat sini: dihitung sebagai query milik monitor, dijalankan berurutan. */
  private q<T extends mysql.RowDataPacket[]>(sql: string, params?: unknown[]) {
    return this.queue.run(async () => {
      this.ownTotal += 1;
      if (/^\s*select/i.test(sql)) this.ownSelect += 1;
      const [rows] = await this.pool!.query<T>(sql, params);
      return rows;
    });
  }

  async connect() {
    this.pool = mysql.createPool({
      host: this.cfg.host,
      port: this.cfg.port ?? 3306,
      user: this.cfg.username,
      password: this.cfg.password,
      database: this.cfg.database || undefined,
      connectionLimit: 1, // monitoring cukup 1 koneksi, jangan membebani server
      connectTimeout: 5000,
    });
    // Cegah crash seluruh server saat koneksi putus; sample() berikutnya akan gagal & disambung ulang.
    this.pool.on('connection', (conn) => conn.on('error', () => {}));
    await this.q('SELECT 1');
    await this.refreshMaxConnections();
    try {
      await this.q(`SELECT 1 FROM performance_schema.events_statements_summary_global_by_event_name LIMIT 1`);
      const [r] = await this.q(
        `SELECT COUNT(*) AS n FROM performance_schema.events_statements_summary_global_by_event_name WHERE COUNT_STAR > 0`,
      );
      this.psStatements = Number(r.n) > 0; // performance_schema OFF → tabel ada tapi kosong
    } catch {
      this.psStatements = false;
    }
    if (this.psStatements) {
      try {
        await this.q(`SELECT 1 FROM performance_schema.events_statements_summary_by_digest LIMIT 1`);
        this.psDigest = true;
      } catch {
        this.psDigest = false;
      }
    }
  }

  private async refreshMaxConnections() {
    try {
      const [r] = await this.q('SELECT @@max_connections AS m');
      this.maxConnections = Number(r.m);
    } catch {
      /* biarkan nilai lama */
    }
  }

  async sample(): Promise<RawSample> {
    if (++this.sampleCount % 60 === 0) await this.refreshMaxConnections();

    // 1) Query yang sedang berjalan: jumlah + durasi
    let active: number | null = null;
    let runMax: number | null = null;
    let runAvg: number | null = null;
    if (this.canReadProcesslist) {
      try {
        const t = this.hasTimeMs ? 'TIME_MS' : 'TIME * 1000';
        const [r] = await this.q(
          `SELECT COUNT(*) AS n, COALESCE(MAX(${t}), 0) AS mx, COALESCE(AVG(${t}), 0) AS av
             FROM information_schema.PROCESSLIST WHERE ${BUSY} AND ID <> CONNECTION_ID()`,
        );
        active = Number(r.n);
        runMax = Number(r.mx);
        runAvg = Number(r.av);
      } catch (e) {
        if (this.hasTimeMs && /TIME_MS/i.test(String((e as Error).message))) this.hasTimeMs = false;
        else this.canReadProcesslist = false;
      }
    }

    // 2) Statistik latency (performance_schema)
    let latTime: number | null = null;
    let latCount: number | null = null;
    if (this.psStatements) {
      try {
        const [r] = await this.q(
          `SELECT COALESCE(SUM(COUNT_STAR), 0) AS c, COALESCE(SUM(SUM_TIMER_WAIT), 0) / 1000000000 AS ms
             FROM performance_schema.events_statements_summary_global_by_event_name
            WHERE EVENT_NAME LIKE 'statement/sql/%'`,
        );
        latCount = Number(r.c);
        latTime = Number(r.ms);
      } catch {
        this.psStatements = false;
      }
    }

    // 3) Counter status global (terakhir, agar query di atas ikut terhitung)
    const rows = await this.q(
      `SHOW GLOBAL STATUS WHERE Variable_name IN (${STATUS_VARS.map(() => '?').join(',')})`,
      STATUS_VARS,
    );
    const m: Record<string, number> = {};
    for (const r of rows) m[String(r.Variable_name).toLowerCase()] = Number(r.Value);
    const v = (k: string) => m[k.toLowerCase()] ?? 0;
    const has = (k: string) => k.toLowerCase() in m;

    if (active == null && has('Threads_running')) active = Math.max(0, v('Threads_running') - 1);

    return {
      ts: Date.now(),
      queriesTotal: has('Queries') ? v('Queries') - this.ownTotal : null,
      txTotal: has('Handler_commit') ? v('Handler_commit') + v('Handler_rollback') : null,
      activeConnections: active,
      totalConnections: has('Threads_connected') ? v('Threads_connected') : null,
      maxConnections: this.maxConnections,
      ops: has('Com_select')
        ? {
            select: v('Com_select') + v('Qcache_hits') - this.ownSelect,
            insert: v('Com_insert') + v('Com_insert_select') + v('Com_replace') + v('Com_replace_select'),
            update: v('Com_update') + v('Com_update_multi'),
            delete: v('Com_delete') + v('Com_delete_multi'),
          }
        : null,
      opsUnit: 'statements',
      latencyTimeTotalMs: latTime,
      latencyCountTotal: latCount,
      latencyAvgMs: latTime == null ? runAvg : null,
      latencyMaxMs: runMax,
      latencySource: latTime != null ? 'stats' : 'running',
    };
  }

  async details(): Promise<Details> {
    const sessions = await this.sessions();
    let slowQueries: SlowQuery[] = [];
    let slowSource: Details['slowSource'] = 'none';
    if (this.psDigest) {
      try {
        const rows = await this.q(
          `SELECT DIGEST_TEXT AS q, COUNT_STAR AS calls, SUM_TIMER_WAIT / 1000000000 AS total_ms,
                  AVG_TIMER_WAIT / 1000000000 AS avg_ms, MAX_TIMER_WAIT / 1000000000 AS max_ms
             FROM performance_schema.events_statements_summary_by_digest
            WHERE DIGEST_TEXT IS NOT NULL
              AND DIGEST_TEXT NOT LIKE '%performance_schema%'
              AND DIGEST_TEXT NOT LIKE '%information_schema%'
              AND DIGEST_TEXT NOT LIKE 'SHOW%'
            ORDER BY SUM_TIMER_WAIT DESC LIMIT 5`,
        );
        slowQueries = rows.map((r) => ({
          query: String(r.q),
          calls: Number(r.calls),
          totalMs: Number(r.total_ms),
          avgMs: Number(r.avg_ms),
          maxMs: Number(r.max_ms),
        }));
        slowSource = 'stats';
      } catch {
        this.psDigest = false;
      }
    }
    if (slowSource === 'none' && this.canReadProcesslist) {
      this.observed.observe(sessions);
      slowQueries = this.observed.top(5);
      slowSource = 'observed';
    }
    return { sessions, slowQueries, slowSource };
  }

  private async sessions(): Promise<SessionInfo[]> {
    if (!this.canReadProcesslist) return [];
    const t = this.hasTimeMs ? 'p.TIME_MS' : 'p.TIME * 1000';
    const base = `FROM information_schema.PROCESSLIST p
      LEFT JOIN information_schema.INNODB_TRX t ON t.trx_mysql_thread_id = p.ID
      WHERE p.${BUSY} AND p.ID <> CONNECTION_ID()
      ORDER BY ${t} DESC LIMIT 20`;
    let rows: mysql.RowDataPacket[];
    try {
      rows = await this.q(
        `SELECT p.ID AS id, p.USER AS user, p.DB AS db, ${t} AS ms, p.STATE AS state, LEFT(p.INFO, 500) AS info,
                t.trx_state AS trx_state,
                ${
                  this.hasInnodbLockWaits
                    ? `(SELECT bt.trx_mysql_thread_id FROM information_schema.INNODB_LOCK_WAITS w
                         JOIN information_schema.INNODB_TRX bt ON bt.trx_id = w.blocking_trx_id
                        WHERE w.requesting_trx_id = t.trx_id LIMIT 1)`
                    : 'NULL'
                } AS blocker
         ${base}`,
      );
    } catch {
      if (this.hasInnodbLockWaits) {
        this.hasInnodbLockWaits = false; // MySQL 8 tidak punya INNODB_LOCK_WAITS
        return this.sessions();
      }
      // Tanpa INNODB_TRX
      rows = await this.q(
        `SELECT p.ID AS id, p.USER AS user, p.DB AS db, ${t} AS ms, p.STATE AS state, LEFT(p.INFO, 500) AS info,
                NULL AS trx_state, NULL AS blocker
           FROM information_schema.PROCESSLIST p WHERE p.${BUSY} AND p.ID <> CONNECTION_ID()
          ORDER BY ${t} DESC LIMIT 20`,
      );
    }
    return rows.map((r) => {
      const stateText = r.state ? String(r.state) : '';
      let state: SessionInfo['state'] = 'running';
      let lock: string | null = null;
      if (r.trx_state === 'LOCK WAIT') {
        state = 'blocked';
        lock = r.blocker ? `Row lock — diblok sesi ${r.blocker}` : 'Row lock wait';
      } else if (/lock/i.test(stateText)) {
        state = 'waiting';
        lock = stateText;
      }
      return {
        id: String(r.id),
        user: String(r.user ?? ''),
        database: String(r.db ?? ''),
        state,
        durationMs: Number(r.ms ?? 0),
        query: r.info ? String(r.info) : stateText,
        lock,
      };
    });
  }

  async close() {
    await this.pool?.end();
  }
}
