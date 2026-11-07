export type DbEngine = 'mariadb' | 'postgres' | 'mssql' | 'sqlite';
export type DeviceKind = 'proxmox' | 'pbs' | 'synology' | 'abb' | 'isp' | 'fortigate' | 'mikrotik';
/** Jenis sumber: database (4 engine) atau perangkat */
export type Engine = DbEngine | DeviceKind;
const DEVICE_KINDS: readonly string[] = ['proxmox', 'pbs', 'synology', 'abb', 'isp', 'fortigate', 'mikrotik'];
export const isDevice = (e: Engine): e is DeviceKind => DEVICE_KINDS.includes(e);

export interface DeviceOptions {
  https?: boolean;
  node?: string;
  provider?: string;
  slaTarget?: number;
  intervalSec?: number;
  method?: 'ping' | 'tcp';
  tcpPort?: number;
  latencyWarnMs?: number;
  staleHours?: number;
  vdom?: string;
  threats?: boolean;
  siteLat?: number;
  siteLon?: number;
  siteLabel?: string;
  threatSpike?: number;
}
export type ConnStatus = 'connecting' | 'up' | 'error';

export interface Connection {
  id: string;
  name: string;
  engine: Engine;
  host?: string;
  port?: number;
  username?: string;
  database?: string;
  filePath?: string;
  agentUrl?: string;
  hasAgent?: boolean;
  options?: DeviceOptions;
  status?: ConnStatus;
  message?: string;
}

export interface QueryOps {
  select: number | null;
  insert: number | null;
  update: number | null;
  delete: number | null;
}

export interface HostMetrics {
  cpuPct: number | null;
  memPct: number | null;
  memUsedBytes?: number;
  memTotalBytes?: number;
  diskPct?: number | null;
  hostname?: string;
}

/** Titik per-detik (mode Live). */
export interface MetricPoint {
  connId: string;
  ts: number;
  qps: number | null;
  tps: number | null;
  activeConnections: number | null;
  totalConnections: number | null;
  maxConnections: number | null;
  ops: QueryOps | null;
  opsUnit?: 'statements' | 'rows';
  reads: number | null;
  writes: number | null;
  rwUnit: 'statements' | 'rows' | 'pages' | null;
  latencyAvgMs: number | null;
  latencyMaxMs: number | null;
  latencySource?: 'stats' | 'running';
  host: HostMetrics | null;
  agentStatus: 'none' | 'ok' | 'error';
  extra?: Record<string, number>;
}

/** Titik ringkasan (rentang 15 menit – 24 jam). */
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
  ops: QueryOps;
  cpuPct: number | null;
  memPct: number | null;
}

export type ChartPoint = MetricPoint | HistoryPoint;

export const cpuOf = (p: ChartPoint) => ('host' in p ? p.host?.cpuPct : p.cpuPct) ?? null;
export const memOf = (p: ChartPoint) => ('host' in p ? p.host?.memPct : p.memPct) ?? null;

export interface SessionInfo {
  id: string;
  user: string;
  database: string;
  state: 'running' | 'waiting' | 'blocked';
  durationMs: number;
  query: string;
  lock: string | null;
}

export interface SlowQuery {
  query: string;
  calls: number | null;
  avgMs: number | null;
  totalMs: number | null;
  maxMs: number | null;
}

export interface Details {
  connId: string;
  ts: number;
  sessions: SessionInfo[];
  slowQueries: SlowQuery[];
  slowSource: 'stats' | 'observed' | 'none';
}

export type Severity = 'critical' | 'warning';

export interface Alert {
  id: string;
  connId: string;
  rule: string;
  severity: Severity;
  title: string;
  message: string;
  since: number;
  resolvedAt?: number;
}

export interface AlertSnapshot {
  connId: string;
  active: Alert[];
  recent: Alert[];
}

export type RangeKey = 'live' | '15m' | '1h' | '6h' | '24h' | '7d' | '30d';
export const RANGES: { key: RangeKey; label: string }[] = [
  { key: 'live', label: 'Live (5 menit)' },
  { key: '15m', label: '15 menit terakhir' },
  { key: '1h', label: '1 jam terakhir' },
  { key: '6h', label: '6 jam terakhir' },
  { key: '24h', label: '24 jam terakhir' },
  { key: '7d', label: '7 hari terakhir' },
  { key: '30d', label: '30 hari terakhir' },
];

/** Warna status (khusus status, tidak dipakai untuk seri data) */
export const STATUS = {
  good: '#0ca30c',
  warning: '#d97706',
  critical: '#dc2626',
} as const;

export const ENGINE_META: Record<Engine, { label: string; port?: number; color: string }> = {
  mariadb: { label: 'MariaDB', port: 3306, color: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200' },
  postgres: { label: 'PostgreSQL', port: 5432, color: 'bg-sky-50 text-sky-800 ring-1 ring-sky-200' },
  mssql: { label: 'SQL Server', port: 1433, color: 'bg-rose-50 text-rose-800 ring-1 ring-rose-200' },
  sqlite: { label: 'SQLite', color: 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200' },
  proxmox: { label: 'Proxmox VE', port: 8006, color: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200' },
  pbs: { label: 'Proxmox Backup', port: 8007, color: 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200' },
  synology: { label: 'Synology NAS', port: 5001, color: 'bg-sky-50 text-sky-800 ring-1 ring-sky-200' },
  abb: { label: 'Active Backup', port: 5001, color: 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200' },
  isp: { label: 'ISP', color: 'bg-rose-50 text-rose-800 ring-1 ring-rose-200' },
  fortigate: { label: 'FortiGate', port: 443, color: 'bg-rose-50 text-rose-800 ring-1 ring-rose-200' },
  mikrotik: { label: 'MikroTik', port: 80, color: 'bg-sky-50 text-sky-800 ring-1 ring-sky-200' },
};

/** Tab kategori */
export type Category = 'database' | 'proxmox' | 'synology' | 'abb' | 'fortigate' | 'mikrotik' | 'isp';
/** Proxmox Backup Server ikut tab Backup bersama Active Backup */
export const categoryOf = (e: Engine): Category => (e === 'pbs' ? 'abb' : isDevice(e) ? e : 'database');
export const CATEGORIES: { key: Category; label: string; icon: string }[] = [
  { key: 'database', label: 'Database', icon: '🗄' },
  { key: 'proxmox', label: 'Proxmox', icon: '🖥' },
  { key: 'synology', label: 'NAS', icon: '💾' },
  { key: 'abb', label: 'Backup', icon: '🛡' },
  { key: 'fortigate', label: 'Firewall', icon: '🔥' },
  { key: 'mikrotik', label: 'MikroTik', icon: '📡' },
  { key: 'isp', label: 'ISP', icon: '🌐' },
];

// ─────────── Perangkat ───────────

/** Titik deret waktu perangkat: v = nilai per kunci (cpu, mem, latency, ...) */
export interface DevicePoint {
  ts: number;
  v: Record<string, number | null>;
}

export interface DeviceUpdate<D = unknown> {
  connId: string;
  kind: DeviceKind;
  ts: number;
  series: Record<string, number | null>;
  data: D;
}

export interface ProxmoxData {
  nodes: { name: string; status: string; cpuPct: number | null; memPct: number | null; cores?: number; memTotal?: number; uptime: number; version: string | null; load: string | null }[];
  guests: { id: string; vmid: number; name: string; type: 'VM' | 'CT'; node: string; status: string; cpuPct: number | null; memPct: number | null; memUsed: number; uptime: number }[];
  storages: { name: string; node: string; status: string; shared: boolean; used: number; total: number; pct: number | null }[];
  counts: { vmTotal: number; vmRunning: number; ctTotal: number; ctRunning: number };
  memUsed: number;
  memTotal: number;
  uptime: number;
}

export interface NasData {
  model: string | null;
  version: string | null;
  uptime: number | null;
  sysTemp: number | null;
  memUsed: number | null;
  memTotal: number | null;
  volumes: { id: string; name: string; status: string; fs: string; total: number | null; used: number | null; pct: number | null }[];
  disks: { id: string; name: string; model: string; temp: number | null; status: string; smart: string; size: number | null }[];
  pools: { id: string; status: string; raid: string }[];
}

export type BackupResult = 'running' | 'success' | 'partial' | 'failed' | 'canceled' | 'none' | 'unknown';
export interface AbbData {
  tasks: {
    id: number;
    name: string;
    type: string;
    devices: { name: string; ip: string; os: string; online: boolean }[];
    deviceCount: number;
    result: BackupResult;
    start: number | null;
    end: number | null;
    durationMs: number | null;
    bytes: number | null;
    counts: { ok: number; warn: number; err: number } | null;
    next: number | null;
  }[];
  total: number;
  devicesTotal: number;
  devicesOnline: number;
  lastEnd: number | null;
  bytes24h: number;
}

export interface SlaStat {
  key: string;
  label: string;
  uptimePct: number | null;
  downtimeMs: number;
  incidents: number;
  coveragePct: number;
  lossPct: number | null;
  latencyAvg: number | null;
}
export interface IspData {
  target: string;
  provider: string;
  method: 'ping' | 'tcp';
  tcpPort: number | null;
  slaTarget: number;
  down: boolean;
  downSince: number | null;
  lastOk: boolean;
  lastMs: number | null;
  lastError: string | null;
  latencyAvg: number | null;
  jitter: number | null;
  lossPct: number | null;
  sla: SlaStat[];
  budgetMs: number;
  budgetUsedMs: number;
  budgetLeftMs: number;
  incidents: { id: number; start: number; end: number | null; reason: string | null; durationMs: number; ongoing: boolean }[];
  intervalSec: number;
}

export interface FortiIface {
  name: string;
  alias: string;
  ip: string;
  link: boolean;
  speed: number | null;
  rxBps: number | null;
  txBps: number | null;
  wan: boolean;
  role: string;
}
export interface FortiData {
  hostname: string | null;
  model: string | null;
  version: string | null;
  serial: string | null;
  uptime: number | null;
  sessions: number | null;
  wans: FortiIface[];
  interfaces: FortiIface[];
  sla: { sla: string; iface: string; status: string; latencyMs: number | null; jitterMs: number | null; lossPct: number | null; slaMet: boolean | null; since: number | null }[];
  tunnels: { name: string; remote: string; up: number; total: number; rxBytes: number | null; txBytes: number | null }[];
  /** Peta serangan (null bila dimatikan) */
  threats?: FortiThreats | null;
}

export type ThreatDir = 'in' | 'out' | 'lan';
export interface ThreatRow {
  ts: number;
  kind: 'IPS' | 'DoS' | 'Malware';
  dir: ThreatDir;
  name: string;
  severity: string;
  blocked: number;
  action: string;
  remoteIp: string;
  country: string;
  localIp: string;
  port: number | null;
  count: number;
}
export interface ThreatTop {
  k: string;
  n: number;
  sev: number;
}
export interface FortiThreats {
  ok: boolean;
  message: string | null;
  device: string | null;
  lastFetch: number | null;
  perMinute: number | null;
  site: { lat: number; lon: number; label: string };
  totals: { dir: ThreatDir; severity: string; blocked: number; n: number }[];
  topCountries: ThreatTop[];
  topAttacks: ThreatTop[];
  topTargets: ThreatTop[];
  infected: ThreatTop[];
  countries: { dir: ThreatDir; country: string; n: number; sev: number; last: number }[];
  recent: ThreatRow[];
}

export interface MikrotikIface {
  name: string;
  type: string;
  comment: string;
  running: boolean;
  disabled: boolean;
  rxBps: number | null;
  txBps: number | null;
  wan: boolean;
}
export interface MikrotikData {
  identity: string | null;
  board: string | null;
  version: string | null;
  arch: string | null;
  cpuCount: number | null;
  uptime: number | null;
  memUsed: number | null;
  memTotal: number | null;
  hddPct: number | null;
  temp: number | null;
  voltage: number | null;
  routes: { gateway: string; iface: string; distance: number; active: boolean; comment: string }[];
  interfaces: MikrotikIface[];
  netwatch: { host: string; status: string; since: string; comment: string }[];
  dhcpBound: number | null;
}

export type PbsResult = 'running' | 'ok' | 'warning' | 'error';
export interface PbsData {
  version: string | null;
  uptime: number | null;
  load: number | null;
  memUsed: number | null;
  memTotal: number | null;
  rootPct: number | null;
  datastores: { name: string; used: number | null; total: number | null; pct: number | null; fullAt: number | null; error: string | null }[];
  groups: { id: string; store: string; type: string; backupId: string; comment: string; last: number | null; count: number | null; stale: boolean }[];
  tasks: { upid: string; type: string; typeLabel: string; store: string; target: string; start: number; end: number | null; durationMs: number; result: PbsResult; status: string }[];
  counts: { backups24: number; ok24: number; failedOpen: number; running: number; groups: number; stale: number };
  lastBackup: number | null;
  staleHours: number;
}
