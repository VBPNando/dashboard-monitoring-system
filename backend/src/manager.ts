import { alertLog } from './alertLog.js';
import { EventEmitter } from 'node:events';
import {
  createCollector,
  type Collector,
  type ConnConfig,
  type Details,
  type HostMetrics,
  type MetricPoint,
  type QueryOps,
  type RawSample,
} from './collectors/index.js';
import { AlertEngine } from './alerts.js';
import { agentErrorMessage, fetchAgent } from './agent.js';
import * as history from './history.js';
import type { HistoryPoint } from './history.js';

export type ConnStatus = 'connecting' | 'up' | 'error';

interface Running {
  cfg: ConnConfig;
  collector: Collector;
  prev?: RawSample;
  /** Ring buffer per-detik di memori (15 menit) */
  points: MetricPoint[];
  details?: Details & { ts: number };
  host: HostMetrics | null;
  agentStatus: MetricPoint['agentStatus'];
  agentError?: string;
  timers: NodeJS.Timeout[];
  stopped: boolean;
  status: ConnStatus;
  lastError?: string;
}

const MEMORY_POINTS = 900; // 15 menit @1 detik
const DETAILS_MS = 3000;
const AGENT_MS = 2000;

/**
 * Mengelola banyak koneksi secara simultan. Tiap koneksi punya 3 loop independen:
 *  - metrik  (tiap interval, default 1 dtk)
 *  - detail  (sesi, lock, slow query; tiap 3 dtk)
 *  - agen    (CPU/RAM/disk; tiap 2 dtk, bila agen dipasang)
 * Satu DB/agen yang lambat atau mati tidak menghambat yang lain.
 *
 * Event: 'metric' (MetricPoint) · 'status' · 'details' · 'alerts'
 */
export class MonitorManager extends EventEmitter {
  private running = new Map<string, Running>();
  readonly alerts = new AlertEngine(alertLog);

  constructor(private intervalMs = 1000) {
    super();
  }

  /** Uji koneksi tanpa mendaftarkan (dipakai tombol "Tes koneksi"). */
  async test(cfg: ConnConfig) {
    const c = createCollector(cfg);
    try {
      await c.connect();
      await c.sample();
    } finally {
      await c.close().catch(() => {});
    }
  }

  async start(cfg: ConnConfig) {
    await this.stop(cfg.id);
    const r: Running = {
      cfg,
      collector: createCollector(cfg),
      points: [],
      host: null,
      agentStatus: cfg.agentUrl ? 'error' : 'none',
      timers: [],
      stopped: false,
      status: 'connecting',
    };
    this.running.set(cfg.id, r);
    this.setStatus(r, 'connecting');
    try {
      await r.collector.connect();
      this.setStatus(r, 'up');
    } catch (e) {
      this.setStatus(r, 'error', errMsg(e));
    }
    this.schedule(r, 0, this.intervalMs, () => this.tick(r));
    this.schedule(r, 1, DETAILS_MS, () => this.tickDetails(r));
    if (cfg.agentUrl) {
      void this.tickAgent(r);
      this.schedule(r, 2, AGENT_MS, () => this.tickAgent(r));
    }
  }

  /** setTimeout berantai (bukan setInterval) → tidak ada eksekusi yang tumpang tindih. */
  private schedule(r: Running, slot: number, ms: number, fn: () => Promise<void>) {
    if (r.stopped) return;
    r.timers[slot] = setTimeout(async () => {
      await fn().catch(() => {});
      this.schedule(r, slot, ms, fn);
    }, ms);
  }

  private async tick(r: Running) {
    try {
      if (r.status === 'error') {
        // Coba sambung ulang secara otomatis
        await r.collector.close().catch(() => {});
        r.collector = createCollector(r.cfg);
        await r.collector.connect();
        r.prev = undefined;
        this.setStatus(r, 'up');
      }
      const s = await r.collector.sample();
      if (r.stopped) return;
      const point = this.toPoint(r, s);
      r.prev = s;
      r.points.push(point);
      if (r.points.length > MEMORY_POINTS) r.points.shift();
      history.record(point);
      this.emit('metric', point);
      if (this.alerts.evaluate(r.cfg.id, { status: r.status, point }, 'point')) this.emitAlerts(r);
    } catch (e) {
      this.setStatus(r, 'error', errMsg(e));
    }
  }

  private async tickDetails(r: Running) {
    if (r.status !== 'up' || !r.collector.details) return;
    try {
      const d = await r.collector.details();
      if (r.stopped) return;
      r.details = { ...d, ts: Date.now() };
      this.emit('details', { connId: r.cfg.id, ...r.details });
      if (this.alerts.evaluate(r.cfg.id, { status: r.status, details: d }, 'details')) this.emitAlerts(r);
    } catch {
      /* kegagalan detail tidak membuat koneksi dianggap error; metrik utama tetap jalan */
    }
  }

  private async tickAgent(r: Running) {
    const { agentUrl, agentToken } = r.cfg;
    if (!agentUrl) return;
    try {
      r.host = await fetchAgent(agentUrl, agentToken ?? '');
      r.agentStatus = 'ok';
      r.agentError = undefined;
    } catch (e) {
      r.host = null;
      r.agentStatus = 'error';
      r.agentError = agentErrorMessage(e);
    }
    if (r.stopped) return;
    if (this.alerts.evaluate(r.cfg.id, { status: r.status, agentError: r.agentError }, 'agent')) this.emitAlerts(r);
  }

  private toPoint(r: Running, s: RawSample): MetricPoint {
    const p = r.prev;
    const dt = p ? (s.ts - p.ts) / 1000 : 0;

    let ops: QueryOps | null = null;
    if (s.ops) {
      ops = {
        select: rate(p?.ops?.select, s.ops.select, dt),
        insert: rate(p?.ops?.insert, s.ops.insert, dt),
        update: rate(p?.ops?.update, s.ops.update, dt),
        delete: rate(p?.ops?.delete, s.ops.delete, dt),
      };
    }

    // Read / Write
    let reads: number | null = null;
    let writes: number | null = null;
    let rwUnit: MetricPoint['rwUnit'] = null;
    if (ops) {
      reads = ops.select;
      const w = [ops.insert, ops.update, ops.delete];
      writes = w.every((x) => x == null) ? null : Math.round(w.reduce<number>((a, b) => a + (b ?? 0), 0) * 10) / 10;
      rwUnit = s.opsUnit ?? 'statements';
    } else if (s.rwTotals) {
      reads = rate(p?.rwTotals?.reads, s.rwTotals.reads, dt);
      writes = rate(p?.rwTotals?.writes, s.rwTotals.writes, dt);
      rwUnit = 'pages';
    }

    // Latency: dari counter kumulatif (akurat) atau langsung dari collector (perkiraan)
    let latencyAvgMs = s.latencyAvgMs ?? null;
    if (s.latencyTimeTotalMs != null && s.latencyCountTotal != null) {
      latencyAvgMs = null;
      if (p?.latencyTimeTotalMs != null && p.latencyCountTotal != null) {
        const dc = s.latencyCountTotal - p.latencyCountTotal;
        const dtm = s.latencyTimeTotalMs - p.latencyTimeTotalMs;
        if (dc > 0 && dtm >= 0) latencyAvgMs = round1(dtm / dc);
        else if (dc === 0) latencyAvgMs = 0;
      }
    }

    return {
      connId: r.cfg.id,
      ts: s.ts,
      qps: rate(p?.queriesTotal, s.queriesTotal, dt),
      tps: rate(p?.txTotal, s.txTotal, dt),
      activeConnections: s.activeConnections,
      totalConnections: s.totalConnections,
      maxConnections: s.maxConnections ?? null,
      ops,
      opsUnit: s.opsUnit,
      reads,
      writes,
      rwUnit,
      latencyAvgMs: latencyAvgMs == null ? null : round1(latencyAvgMs),
      latencyMaxMs: s.latencyMaxMs == null ? null : round1(s.latencyMaxMs),
      latencySource: s.latencySource,
      host: r.host,
      agentStatus: r.agentStatus,
      extra: s.extra,
    };
  }

  private setStatus(r: Running, status: ConnStatus, message?: string) {
    const changed = r.status !== status || r.lastError !== message;
    r.status = status;
    r.lastError = message;
    if (changed) this.emit('status', { connId: r.cfg.id, status, message });
    if (this.alerts.evaluate(r.cfg.id, { status, statusMessage: message }, 'status')) this.emitAlerts(r);
  }

  private emitAlerts(r: Running) {
    this.emit('alerts', this.alerts.snapshot(r.cfg.id));
  }

  /** Ganti pengaturan agen tanpa memutus koneksi database. */
  setAgent(id: string, agentUrl?: string, agentToken?: string) {
    const r = this.running.get(id);
    if (!r) return;
    r.cfg = { ...r.cfg, agentUrl, agentToken };
    clearTimeout(r.timers[2]);
    r.host = null;
    r.agentError = undefined;
    r.agentStatus = agentUrl ? 'error' : 'none';
    if (this.alerts.evaluate(id, { status: r.status }, 'agent')) this.emitAlerts(r);
    if (agentUrl) {
      void this.tickAgent(r);
      this.schedule(r, 2, AGENT_MS, () => this.tickAgent(r));
    }
  }

  async stop(id: string) {
    const r = this.running.get(id);
    if (!r) return;
    r.stopped = true;
    r.timers.forEach((t) => clearTimeout(t));
    this.running.delete(id);
    await r.collector.close().catch(() => {});
  }

  /** Lepas koneksi sepenuhnya (dipakai saat dihapus): termasuk alert & riwayat. */
  async remove(id: string) {
    await this.stop(id);
    this.alerts.forget(id);
    history.forget(id);
  }

  /** Titik per-detik terbaru (untuk mode Live). */
  live(id: string, seconds = 300) {
    const pts = this.running.get(id)?.points ?? [];
    return pts.slice(-seconds);
  }

  /** Riwayat untuk rentang waktu tertentu, sudah diringkas per bucket. */
  range(id: string, rangeMs: number): HistoryPoint[] {
    const from = Date.now() - rangeMs;
    // ≤ 15 menit: dari memori per 10 detik; lebih lama: dari ringkasan per menit di SQLite
    if (rangeMs <= 15 * 60_000) {
      return aggregate((this.running.get(id)?.points ?? []).filter((p) => p.ts >= from), 10_000);
    }
    const bucket = bucketFor(rangeMs);
    return history.query(id, from, bucket);
  }

  detailsOf(id: string) {
    const r = this.running.get(id);
    return r?.details ? { connId: id, ...r.details } : null;
  }

  statusOf(id: string) {
    const r = this.running.get(id);
    return r ? { status: r.status, message: r.lastError } : { status: 'error' as ConnStatus, message: 'not running' };
  }

  async stopAll() {
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
    history.flushAll();
  }
}

/**
 * Laju per detik dari dua nilai counter kumulatif.
 * Turun sedikit (jitter statistik) → 0. Turun drastis (server restart / statistik direset) → titik dilewati.
 */
export function rate(prev: number | null | undefined, cur: number | null | undefined, dt: number): number | null {
  if (prev == null || cur == null || dt <= 0) return null;
  const delta = cur - prev;
  if (delta < 0) return cur < prev * 0.5 ? null : 0;
  return Math.round((delta / dt) * 10) / 10;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/** Ringkas titik per-detik menjadi bucket (rata-rata; qps & latency max memakai nilai maksimum). */
function aggregate(points: MetricPoint[], bucketMs: number): HistoryPoint[] {
  const groups = new Map<number, MetricPoint[]>();
  for (const p of points) {
    const b = Math.floor(p.ts / bucketMs) * bucketMs;
    const g = groups.get(b);
    if (g) g.push(p);
    else groups.set(b, [p]);
  }
  const avg = (g: MetricPoint[], f: (p: MetricPoint) => number | null | undefined) => {
    const v = g.map(f).filter((x): x is number => x != null);
    return v.length ? round1(v.reduce((a, b) => a + b, 0) / v.length) : null;
  };
  const max = (g: MetricPoint[], f: (p: MetricPoint) => number | null | undefined) => {
    const v = g.map(f).filter((x): x is number => x != null);
    return v.length ? Math.max(...v) : null;
  };
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, g]) => ({
      ts,
      qps: avg(g, (p) => p.qps),
      qpsMax: max(g, (p) => p.qps),
      tps: avg(g, (p) => p.tps),
      latencyAvgMs: avg(g, (p) => p.latencyAvgMs),
      latencyMaxMs: max(g, (p) => p.latencyMaxMs),
      activeConnections: avg(g, (p) => p.activeConnections),
      totalConnections: avg(g, (p) => p.totalConnections),
      maxConnections: max(g, (p) => p.maxConnections),
      reads: avg(g, (p) => p.reads),
      writes: avg(g, (p) => p.writes),
      ops: {
        select: avg(g, (p) => p.ops?.select),
        insert: avg(g, (p) => p.ops?.insert),
        update: avg(g, (p) => p.ops?.update),
        delete: avg(g, (p) => p.ops?.delete),
      },
      cpuPct: avg(g, (p) => p.host?.cpuPct),
      memPct: avg(g, (p) => p.host?.memPct),
    }));
}

function errMsg(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

/** Resolusi grafik per rentang: ±60–360 titik */
export function bucketFor(rangeMs: number) {
  if (rangeMs <= 3600_000) return 60_000;
  if (rangeMs <= 6 * 3600_000) return 5 * 60_000;
  if (rangeMs <= 24 * 3600_000) return 15 * 60_000;
  if (rangeMs <= 7 * 86400_000) return 3600_000;
  return 3 * 3600_000;
}
