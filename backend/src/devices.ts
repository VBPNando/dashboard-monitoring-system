import { EventEmitter } from 'node:events';
import type { AlertEngine } from './alerts.js';
import * as hist from './deviceHistory.js';
import type { DevicePoint } from './deviceHistory.js';
import { ProxmoxSource } from './sources/proxmox.js';
import { SynologySource } from './sources/synology.js';
import { AbbSource } from './sources/abb.js';
import { IspSource } from './sources/isp.js';
import { FortiGateSource } from './sources/fortigate.js';
import { MikrotikSource } from './sources/mikrotik.js';
import { PbsSource } from './sources/pbs.js';
import * as ispStore from './sources/ispStore.js';
import type { DeviceConfig, DeviceKind, DeviceSource } from './sources/types.js';

export function createSource(cfg: DeviceConfig): DeviceSource {
  switch (cfg.kind) {
    case 'proxmox':
      return new ProxmoxSource(cfg);
    case 'synology':
      return new SynologySource(cfg);
    case 'abb':
      return new AbbSource(cfg);
    case 'isp':
      return new IspSource(cfg);
    case 'fortigate':
      return new FortiGateSource(cfg);
    case 'mikrotik':
      return new MikrotikSource(cfg);
    case 'pbs':
      return new PbsSource(cfg);
  }
}

export const DEVICE_KINDS: DeviceKind[] = ['proxmox', 'pbs', 'synology', 'abb', 'isp', 'fortigate', 'mikrotik'];

type Status = 'connecting' | 'up' | 'error';

interface Running {
  cfg: DeviceConfig;
  src: DeviceSource;
  points: DevicePoint[];
  last?: { ts: number; data: Record<string, unknown> };
  timer?: NodeJS.Timeout;
  stopped: boolean;
  status: Status;
  lastError?: string;
  failures: number;
}

const MEMORY_POINTS = 360;

/**
 * Pemantauan perangkat non-database. Satu loop per perangkat (interval sesuai jenis:
 * Proxmox/NAS 5 dtk, ISP/FortiGate/MikroTik 10 dtk, Active Backup 60 dtk). Gagal → status error + alert,
 * dicoba lagi otomatis dengan jeda yang makin panjang (maks 60 dtk).
 *
 * Event: 'device' {connId, kind, ts, series, data} · 'status' · 'alerts'
 */
export class DeviceManager extends EventEmitter {
  private running = new Map<string, Running>();

  constructor(private alerts: AlertEngine) {
    super();
  }

  async test(cfg: DeviceConfig) {
    const src = createSource(cfg);
    try {
      return await src.test();
    } finally {
      await src.close().catch(() => {});
    }
  }

  start(cfg: DeviceConfig) {
    void this.stop(cfg.id).then(() => {
      const r: Running = { cfg, src: createSource(cfg), points: [], stopped: false, status: 'connecting', failures: 0 };
      this.running.set(cfg.id, r);
      this.setStatus(r, 'connecting');
      void this.tick(r);
    });
  }

  private schedule(r: Running) {
    if (r.stopped) return;
    // Gagal berulang → jeda bertambah (interval × 2^n, maks 60 dtk) agar perangkat tidak dibanjiri permintaan
    const wait = r.failures ? Math.min(60_000, r.src.intervalMs * 2 ** Math.min(r.failures, 4)) : r.src.intervalMs;
    r.timer = setTimeout(() => void this.tick(r), wait);
  }

  private async tick(r: Running) {
    try {
      const s = await r.src.sample();
      if (r.stopped) return;
      const ts = Date.now();
      r.failures = 0;
      this.setStatus(r, 'up');
      r.last = { ts, data: s.data };
      r.points.push({ ts, v: s.series });
      if (r.points.length > MEMORY_POINTS) r.points.shift();
      hist.record(r.cfg.id, ts, s.series);
      this.emit('device', { connId: r.cfg.id, kind: r.cfg.kind, ts, series: s.series, data: s.data });
      if (this.alerts.evaluateChecks(r.cfg.id, s.checks)) this.emitAlerts(r.cfg.id);
    } catch (e) {
      if (r.stopped) return;
      r.failures++;
      this.setStatus(r, 'error', e instanceof Error ? e.message : String(e));
    } finally {
      this.schedule(r);
    }
  }

  private setStatus(r: Running, status: Status, message?: string) {
    const changed = r.status !== status || r.lastError !== message;
    r.status = status;
    r.lastError = message;
    if (changed) this.emit('status', { connId: r.cfg.id, status, message });
    const hit =
      status === 'error'
        ? { severity: 'critical' as const, title: `${r.cfg.name} tidak bisa dihubungi`, message: message ?? '' }
        : null;
    if (this.alerts.evaluateChecks(r.cfg.id, [{ rule: 'conn_down', raiseAfter: 2, clearAfter: 1, hit: status === 'connecting' ? null : hit }]))
      this.emitAlerts(r.cfg.id);
  }

  private emitAlerts(id: string) {
    this.emit('alerts', this.alerts.snapshot(id));
  }

  async stop(id: string) {
    const r = this.running.get(id);
    if (!r) return;
    r.stopped = true;
    clearTimeout(r.timer);
    this.running.delete(id);
    await r.src.close().catch(() => {});
  }

  async remove(id: string) {
    const kind = this.running.get(id)?.cfg.kind;
    await this.stop(id);
    this.alerts.forget(id);
    hist.forget(id);
    if (kind === 'isp') ispStore.forget(id);
  }

  has(id: string) {
    return this.running.has(id);
  }

  /** Kondisi terbaru (untuk tampilan awal) */
  snapshot(id: string) {
    const r = this.running.get(id);
    if (!r?.last) return null;
    return { connId: id, kind: r.cfg.kind, ts: r.last.ts, series: r.points.at(-1)?.v ?? {}, data: r.last.data };
  }

  /** Titik riwayat: ≤ 30 menit dari memori, lebih lama dari ringkasan per menit. */
  range(id: string, rangeMs: number): DevicePoint[] {
    const from = Date.now() - rangeMs;
    const r = this.running.get(id);
    if (rangeMs <= 30 * 60_000 && r) {
      const pts = r.points.filter((p) => p.ts >= from);
      if (pts.length && pts[0].ts - from < r.src.intervalMs * 3) return pts;
    }
    const bucket = bucketFor(rangeMs);
    const stored = hist.query(id, from, bucket);
    // Sambungkan dengan titik terbaru di memori agar grafik sampai "sekarang"
    const lastStored = stored.at(-1)?.ts ?? 0;
    const tail = (r?.points ?? []).filter((p) => p.ts > lastStored + bucket);
    return [...stored, ...tail];
  }

  statusOf(id: string) {
    const r = this.running.get(id);
    return r ? { status: r.status, message: r.lastError } : { status: 'error' as Status, message: 'not running' };
  }

  raw(id: string) {
    return this.running.get(id)?.src.raw?.() ?? null;
  }

  async stopAll() {
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
    hist.flushAll();
  }
}

/** Resolusi grafik per rentang: ±60–360 titik */
export function bucketFor(rangeMs: number) {
  if (rangeMs <= 3600_000) return 60_000;
  if (rangeMs <= 6 * 3600_000) return 5 * 60_000;
  if (rangeMs <= 24 * 3600_000) return 15 * 60_000;
  if (rangeMs <= 7 * 86400_000) return 3600_000;
  return 3 * 3600_000;
}
