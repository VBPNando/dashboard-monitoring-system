import sql from 'mssql';
import type { Collector, ConnConfig, Details, RawSample, SessionInfo } from './types.js';
import { SerialQueue } from './observed.js';

/**
 * Microsoft SQL Server.
 * - QPS    : Δ 'Batch Requests/sec' (counter kumulatif)
 * - TPS    : Δ 'Transactions/sec' (_Total)
 * - R/W    : Δ 'Page reads/sec' & 'Page writes/sec' (I/O halaman fisik)
 * - Active : request user yang sedang berjalan;  Total: sesi user;  Max: @@MAX_CONNECTIONS
 * - Latency: durasi request yang sedang berjalan
 * - Slow   : sys.dm_exec_query_stats (bawaan, tanpa konfigurasi)
 * Hak akses: GRANT VIEW SERVER STATE TO <login>;
 */
export class MssqlCollector implements Collector {
  private pool?: sql.ConnectionPool;
  private queue = new SerialQueue();
  private own = 0;
  private maxConnections: number | null = null;

  constructor(private cfg: ConnConfig) {}

  private q(text: string) {
    return this.queue.run(async () => {
      this.own += 1;
      const res = await this.pool!.request().query(text);
      return res.recordset as Record<string, unknown>[];
    });
  }

  async connect() {
    this.pool = new sql.ConnectionPool({
      server: this.cfg.host!,
      port: this.cfg.port ?? 1433,
      user: this.cfg.username,
      password: this.cfg.password,
      database: this.cfg.database || 'master',
      pool: { max: 1, min: 0 },
      connectionTimeout: 5000,
      options: {
        encrypt: true,
        // Set false di production dan pasang sertifikat yang valid
        trustServerCertificate: true,
        appName: 'dbmon',
      },
    });
    // Cegah crash seluruh server saat koneksi putus; sample() berikutnya akan gagal & disambung ulang.
    this.pool.on('error', () => {});
    await this.pool.connect();
    const [r] = await this.q('SELECT @@MAX_CONNECTIONS AS m');
    this.maxConnections = Number(r.m);
  }

  async sample(): Promise<RawSample> {
    const [r] = await this.q(`
      SELECT
        (SELECT cntr_value FROM sys.dm_os_performance_counters
          WHERE counter_name = 'Batch Requests/sec' AND object_name LIKE '%SQL Statistics%') AS batches,
        (SELECT cntr_value FROM sys.dm_os_performance_counters
          WHERE counter_name = 'Transactions/sec' AND object_name LIKE '%:Databases%' AND instance_name = '_Total') AS xacts,
        (SELECT cntr_value FROM sys.dm_os_performance_counters
          WHERE counter_name = 'Page reads/sec' AND object_name LIKE '%Buffer Manager%') AS page_reads,
        (SELECT cntr_value FROM sys.dm_os_performance_counters
          WHERE counter_name = 'Page writes/sec' AND object_name LIKE '%Buffer Manager%') AS page_writes,
        (SELECT COUNT(*) FROM sys.dm_exec_requests r JOIN sys.dm_exec_sessions s ON s.session_id = r.session_id
          WHERE s.is_user_process = 1 AND r.session_id <> @@SPID) AS active,
        (SELECT COALESCE(MAX(r.total_elapsed_time), 0) FROM sys.dm_exec_requests r
           JOIN sys.dm_exec_sessions s ON s.session_id = r.session_id
          WHERE s.is_user_process = 1 AND r.session_id <> @@SPID) AS run_max,
        (SELECT COALESCE(AVG(CAST(r.total_elapsed_time AS float)), 0) FROM sys.dm_exec_requests r
           JOIN sys.dm_exec_sessions s ON s.session_id = r.session_id
          WHERE s.is_user_process = 1 AND r.session_id <> @@SPID) AS run_avg,
        (SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE is_user_process = 1) AS total
    `);
    const n = (v: unknown) => (v == null ? null : Number(v)); // bigint dikembalikan sebagai string
    const batches = n(r.batches);
    const reads = n(r.page_reads);
    const writes = n(r.page_writes);
    return {
      ts: Date.now(),
      queriesTotal: batches == null ? null : batches - this.own,
      txTotal: n(r.xacts),
      activeConnections: Number(r.active),
      totalConnections: Number(r.total),
      maxConnections: this.maxConnections,
      ops: null,
      rwTotals: reads != null && writes != null ? { reads, writes } : null,
      latencyAvgMs: Number(r.run_avg),
      latencyMaxMs: Number(r.run_max),
      latencySource: 'running',
    };
  }

  async details(): Promise<Details> {
    const rows = await this.q(`
      SELECT TOP 20 r.session_id, s.login_name, DB_NAME(r.database_id) AS db, r.wait_type,
             r.blocking_session_id, r.total_elapsed_time AS ms, LEFT(t.text, 500) AS query
        FROM sys.dm_exec_requests r
        JOIN sys.dm_exec_sessions s ON s.session_id = r.session_id
        OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
       WHERE s.is_user_process = 1 AND r.session_id <> @@SPID
       ORDER BY r.total_elapsed_time DESC`);
    const sessions: SessionInfo[] = rows.map((r) => {
      const blocker = Number(r.blocking_session_id ?? 0);
      const wait = r.wait_type ? String(r.wait_type) : '';
      let state: SessionInfo['state'] = 'running';
      let lock: string | null = null;
      if (blocker > 0) {
        state = 'blocked';
        lock = `${wait || 'Lock'} — diblok sesi ${blocker}`;
      } else if (wait.startsWith('LCK')) {
        state = 'waiting';
        lock = wait;
      }
      return {
        id: String(r.session_id),
        user: String(r.login_name ?? ''),
        database: String(r.db ?? ''),
        state,
        durationMs: Number(r.ms ?? 0),
        query: String(r.query ?? ''),
        lock,
      };
    });

    const slow = await this.q(`
      SELECT TOP 5
        SUBSTRING(st.text, (qs.statement_start_offset / 2) + 1,
          ((CASE qs.statement_end_offset WHEN -1 THEN DATALENGTH(st.text) ELSE qs.statement_end_offset END
            - qs.statement_start_offset) / 2) + 1) AS query,
        qs.execution_count AS calls,
        qs.total_elapsed_time / 1000.0 AS total_ms,
        qs.total_elapsed_time / 1000.0 / NULLIF(qs.execution_count, 0) AS avg_ms,
        qs.max_elapsed_time / 1000.0 AS max_ms
      FROM sys.dm_exec_query_stats qs
      CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
      WHERE st.text NOT LIKE '%dm_exec_%' AND st.text NOT LIKE '%dm_os_performance_counters%'
      ORDER BY qs.total_elapsed_time DESC`);
    return {
      sessions,
      slowQueries: slow.map((r) => ({
        query: String(r.query ?? '').trim(),
        calls: Number(r.calls),
        totalMs: Number(r.total_ms),
        avgMs: Number(r.avg_ms),
        maxMs: Number(r.max_ms),
      })),
      slowSource: 'stats',
    };
  }

  async close() {
    await this.pool?.close();
  }
}
