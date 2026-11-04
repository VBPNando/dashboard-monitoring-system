export type Engine = 'mariadb' | 'postgres' | 'mssql' | 'sqlite';

/** Konfigurasi koneksi yang sudah didekripsi (hanya hidup di memori server). */
export interface ConnConfig {
  id: string;
  name: string;
  engine: Engine;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
  /** Khusus SQLite: path file .db di server (SQLite tidak punya host/port/user). */
  filePath?: string;
  /** Agen CPU & RAM opsional di server database, mis. http://192.168.10.20:9187 */
  agentUrl?: string;
  agentToken?: string;
}

/** Jenis perintah SQL yang dihitung terpisah. null = engine tidak menyediakan data itu. */
export interface QueryOps {
  select: number | null;
  insert: number | null;
  update: number | null;
  delete: number | null;
}

/** 'statements' = jumlah perintah SQL, 'rows' = jumlah baris (PostgreSQL tanpa pg_stat_statements) */
export type OpsUnit = 'statements' | 'rows';

/**
 * Sumber angka latency:
 *  - 'stats'   : rata-rata SEMUA query yang selesai (performance_schema / pg_stat_statements) → akurat
 *  - 'running' : durasi query yang sedang berjalan saat dicek (perkiraan; statistik tidak aktif)
 */
export type LatencySource = 'stats' | 'running';

/** Sampel mentah dari database. Counter bersifat kumulatif; laju per detik dihitung dari selisihnya. */
export interface RawSample {
  ts: number;
  /** Counter kumulatif jumlah query; null jika engine tidak menyediakannya. */
  queriesTotal: number | null;
  /** Counter kumulatif jumlah transaksi (commit + rollback). */
  txTotal?: number | null;
  activeConnections: number | null;
  totalConnections: number | null;
  maxConnections?: number | null;
  ops?: QueryOps | null;
  opsUnit?: OpsUnit;
  /** Counter kumulatif read/write I/O (dipakai bila ops tidak tersedia, mis. SQL Server: halaman) */
  rwTotals?: { reads: number; writes: number } | null;
  /** Counter kumulatif total waktu eksekusi (ms) & jumlah query yang selesai → latency rata-rata */
  latencyTimeTotalMs?: number | null;
  latencyCountTotal?: number | null;
  /** Latency langsung (bila tidak ada counter kumulatif) */
  latencyAvgMs?: number | null;
  latencyMaxMs?: number | null;
  latencySource?: LatencySource;
  extra?: Record<string, number>;
}

/** Data host dari agen. */
export interface HostMetrics {
  cpuPct: number | null;
  memPct: number | null;
  memUsedBytes?: number;
  memTotalBytes?: number;
  diskPct?: number | null;
  hostname?: string;
}

/** Titik metrik yang dikirim ke browser. */
export interface MetricPoint {
  connId: string;
  ts: number;
  qps: number | null;
  tps: number | null;
  activeConnections: number | null;
  totalConnections: number | null;
  maxConnections: number | null;
  ops: QueryOps | null;
  opsUnit?: OpsUnit;
  /** Read = SELECT/dtk, Write = INSERT+UPDATE+DELETE/dtk (SQL Server: halaman I/O per dtk) */
  reads: number | null;
  writes: number | null;
  rwUnit: OpsUnit | 'pages' | null;
  latencyAvgMs: number | null;
  latencyMaxMs: number | null;
  latencySource?: LatencySource;
  /** null = agen belum dipasang / tidak terjangkau */
  host: HostMetrics | null;
  agentStatus: 'none' | 'ok' | 'error';
  extra?: Record<string, number>;
}

/** Sesi yang sedang bekerja (bukan idle). */
export interface SessionInfo {
  id: string;
  user: string;
  database: string;
  /** running = sedang eksekusi, waiting = menunggu lock, blocked = diblok sesi lain */
  state: 'running' | 'waiting' | 'blocked';
  durationMs: number;
  query: string;
  /** Keterangan lock/wait, mis. "Row lock (diblok sesi 5910)" */
  lock: string | null;
}

export interface SlowQuery {
  query: string;
  calls: number | null;
  avgMs: number | null;
  totalMs: number | null;
  /** Durasi terlama yang teramati (dipakai saat statistik query tidak aktif) */
  maxMs: number | null;
}

export interface Details {
  sessions: SessionInfo[];
  slowQueries: SlowQuery[];
  /**
   * 'stats'    = dari statistik database (performance_schema / pg_stat_statements / DMV)
   * 'observed' = dikumpulkan Dashboard Monitoring System dari query berjalan yang teramati (statistik tidak aktif)
   * 'none'     = tidak tersedia
   */
  slowSource: 'stats' | 'observed' | 'none';
}

export interface Collector {
  connect(): Promise<void>;
  sample(): Promise<RawSample>;
  /** Data rinci yang lebih berat (sesi, lock, slow query); dipanggil lebih jarang. */
  details?(): Promise<Details>;
  close(): Promise<void>;
}
