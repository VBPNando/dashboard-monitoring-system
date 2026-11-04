import pg from 'pg';
import type { Collector, ConnConfig, Details, RawSample, SessionInfo, SlowQuery } from './types.js';
import { ObservedSlowQueries, SerialQueue } from './observed.js';

/**
 * PostgreSQL.
 * Dengan ekstensi pg_stat_statements (disarankan):
 *   - QPS / jenis query : Δ calls (dikelompokkan menurut kata pertama query)
 *   - Latency rata-rata : Δ total_exec_time / Δ calls (akurat)
 *   - Slow queries      : urut total_exec_time
 * Tanpa pg_stat_statements (fallback):
 *   - QPS = TPS, jenis query dihitung per BARIS, latency = durasi query berjalan, slow = teramati
 * - TPS    : Δ xact_commit + xact_rollback (semua database)
 * - Active : pg_stat_activity state = 'active';  Max: max_connections
 * - Sesi & lock: pg_stat_activity + pg_blocking_pids()
 * Hak akses yang disarankan: GRANT pg_monitor TO <user_monitoring>;
 */
export class PostgresCollector implements Collector {
  private pool?: pg.Pool;
  private queue = new SerialQueue();
  private hasPgss = false;
  /** PostgreSQL 13+ memakai total_exec_time; versi lama total_time */
  private execCol = 'total_exec_time';
  private meanCol = 'mean_exec_time';
  private maxCol = 'max_exec_time';
  /** Jumlah query milik collector ini (masing-masing juga 1 transaksi & 1 calls di pgss) */
  private own = 0;
  private maxConnections: number | null = null;
  private observed = new ObservedSlowQueries();

  constructor(private cfg: ConnConfig) {}

  private q(sql: string) {
    return this.queue.run(async () => {
      this.own += 1;
      const { rows } = await this.pool!.query(sql);
      return rows as Record<string, unknown>[];
    });
  }

  async connect() {
    this.pool = new pg.Pool({
      host: this.cfg.host,
      port: this.cfg.port ?? 5432,
      user: this.cfg.username,
      password: this.cfg.password,
      database: this.cfg.database || 'postgres',
      max: 1,
      connectionTimeoutMillis: 5000,
      application_name: 'dbmon',
    });
    // Tanpa listener ini, koneksi idle yang putus (DB restart/jaringan) membuat seluruh server crash.
    this.pool.on('error', () => {});
    const [r] = await this.q(`SELECT current_setting('max_connections')::int AS m`);
    this.maxConnections = Number(r.m);
    try {
      await this.q('SELECT 1 FROM pg_stat_statements LIMIT 1');
      this.hasPgss = true;
      try {
        await this.q('SELECT total_exec_time FROM pg_stat_statements LIMIT 0');
      } catch {
        this.execCol = 'total_time';
        this.meanCol = 'mean_time';
        this.maxCol = 'max_time';
      }
    } catch {
      this.hasPgss = false;
    }
  }

  async sample(): Promise<RawSample> {
    const common = `
      (SELECT COALESCE(sum(xact_commit + xact_rollback), 0) FROM pg_stat_database)::float8 AS xacts,
      (SELECT count(*) FROM pg_stat_activity WHERE state = 'active' AND pid <> pg_backend_pid())::int AS active,
      (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend')::int AS total,
      (SELECT COALESCE(max(extract(epoch FROM now() - query_start)) * 1000, 0) FROM pg_stat_activity
        WHERE state = 'active' AND pid <> pg_backend_pid() AND backend_type = 'client backend')::float8 AS run_max,
      (SELECT COALESCE(avg(extract(epoch FROM now() - query_start)) * 1000, 0) FROM pg_stat_activity
        WHERE state = 'active' AND pid <> pg_backend_pid() AND backend_type = 'client backend')::float8 AS run_avg`;

    if (this.hasPgss) {
      const [r] = await this.q(`
        WITH s AS (
          SELECT calls, ${this.execCol} AS exec_ms, lower(substring(ltrim(query) from '^[A-Za-z]+')) AS kw
          FROM pg_stat_statements
        )
        SELECT
          (SELECT COALESCE(sum(calls), 0) FROM s)::float8 AS total_calls,
          (SELECT COALESCE(sum(exec_ms), 0) FROM s)::float8 AS exec_ms,
          (SELECT COALESCE(sum(calls), 0) FROM s WHERE kw IN ('select', 'with', 'table', 'values'))::float8 AS sel,
          (SELECT COALESCE(sum(calls), 0) FROM s WHERE kw = 'insert')::float8 AS ins,
          (SELECT COALESCE(sum(calls), 0) FROM s WHERE kw = 'update')::float8 AS upd,
          (SELECT COALESCE(sum(calls), 0) FROM s WHERE kw = 'delete')::float8 AS del,
          ${common}
      `);
      // Query monitor tercatat di pgss setelah selesai → saat ini tercatat own - 1 query sebelumnya
      const ownDone = this.own - 1;
      return {
        ts: Date.now(),
        queriesTotal: Number(r.total_calls) - ownDone,
        txTotal: Number(r.xacts) - ownDone,
        activeConnections: Number(r.active),
        totalConnections: Number(r.total),
        maxConnections: this.maxConnections,
        ops: {
          select: Number(r.sel) - ownDone,
          insert: Number(r.ins),
          update: Number(r.upd),
          delete: Number(r.del),
        },
        opsUnit: 'statements',
        latencyTimeTotalMs: Number(r.exec_ms),
        latencyCountTotal: Number(r.total_calls) - ownDone,
        latencyMaxMs: Number(r.run_max),
        latencySource: 'stats',
        extra: { qpsSourceIsTps: 0 },
      };
    }

    const [r] = await this.q(`
      SELECT
        COALESCE(sum(tup_returned), 0)::float8 AS sel,
        COALESCE(sum(tup_inserted), 0)::float8 AS ins,
        COALESCE(sum(tup_updated), 0)::float8 AS upd,
        COALESCE(sum(tup_deleted), 0)::float8 AS del,
        ${common}
      FROM pg_stat_database
    `);
    const ownDone = this.own - 1;
    return {
      ts: Date.now(),
      queriesTotal: Number(r.xacts) - ownDone, // tanpa pgss: QPS ≈ TPS
      txTotal: Number(r.xacts) - ownDone,
      activeConnections: Number(r.active),
      totalConnections: Number(r.total),
      maxConnections: this.maxConnections,
      ops: { select: Number(r.sel), insert: Number(r.ins), update: Number(r.upd), delete: Number(r.del) },
      opsUnit: 'rows',
      latencyAvgMs: Number(r.run_avg),
      latencyMaxMs: Number(r.run_max),
      latencySource: 'running',
      extra: { qpsSourceIsTps: 1 },
    };
  }

  async details(): Promise<Details> {
    const rows = await this.q(`
      SELECT pid, usename, datname, state, wait_event_type, wait_event,
             (extract(epoch FROM now() - query_start) * 1000)::float8 AS ms,
             left(query, 500) AS query, pg_blocking_pids(pid) AS blockers
        FROM pg_stat_activity
       WHERE backend_type = 'client backend' AND state <> 'idle' AND pid <> pg_backend_pid()
       ORDER BY query_start NULLS LAST
       LIMIT 20`);
    const sessions: SessionInfo[] = rows.map((r) => {
      const blockers = (r.blockers as number[] | null) ?? [];
      let state: SessionInfo['state'] = 'running';
      let lock: string | null = null;
      if (blockers.length) {
        state = 'blocked';
        lock = `${r.wait_event ?? 'Lock'} — diblok sesi ${blockers.join(', ')}`;
      } else if (r.wait_event_type === 'Lock') {
        state = 'waiting';
        lock = `Lock: ${r.wait_event}`;
      } else if (r.state === 'idle in transaction') {
        lock = 'Idle in transaction (menahan lock)';
      }
      return {
        id: String(r.pid),
        user: String(r.usename ?? ''),
        database: String(r.datname ?? ''),
        state,
        durationMs: Math.max(0, Number(r.ms ?? 0)),
        query: String(r.query ?? ''),
        lock,
      };
    });

    if (this.hasPgss) {
      const slow = await this.q(`
        SELECT query, calls, ${this.execCol}::float8 AS total_ms, ${this.meanCol}::float8 AS avg_ms,
               ${this.maxCol}::float8 AS max_ms
          FROM pg_stat_statements
         WHERE query NOT ILIKE '%pg_stat_statements%' AND query NOT ILIKE '%pg_stat_activity%'
         ORDER BY ${this.execCol} DESC
         LIMIT 5`);
      const slowQueries: SlowQuery[] = slow.map((r) => ({
        query: String(r.query),
        calls: Number(r.calls),
        totalMs: Number(r.total_ms),
        avgMs: Number(r.avg_ms),
        maxMs: Number(r.max_ms),
      }));
      return { sessions, slowQueries, slowSource: 'stats' };
    }
    this.observed.observe(sessions);
    return { sessions, slowQueries: this.observed.top(5), slowSource: 'observed' };
  }

  async close() {
    await this.pool?.end();
  }
}
