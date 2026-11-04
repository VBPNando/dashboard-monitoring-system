import { acquireSession } from './synology.js';
import type { Check, DeviceConfig, DeviceSample, DeviceSource } from './types.js';

/**
 * Active Backup for Business (paket di NAS Synology).
 * Catatan: API Active Backup TIDAK didokumentasikan resmi oleh Synology. Struktur di bawah mengikuti
 * pustaka komunitas (synology-api / N4S4). Field dibaca secara defensif; bila ada yang berbeda
 * di NAS Anda, menu ⋯ → "Lihat data mentah" menampilkan respons asli untuk penyesuaian.
 */

const TYPE: Record<number, string> = { 1: 'VM', 2: 'PC', 3: 'Server fisik', 4: 'File server', 5: 'NAS' };

/** Kode status hasil backup (mengikuti riwayat tugas Active Backup) */
const RESULT: Record<number, Result> = {
  1: 'running',
  2: 'success',
  3: 'partial',
  4: 'failed',
  5: 'canceled',
};
export type Result = 'running' | 'success' | 'partial' | 'failed' | 'canceled' | 'none' | 'unknown';

interface RawTask {
  task_id: number;
  task_name?: string;
  backup_type?: number;
  device_count?: number;
  devices?: { host_name?: string; host_ip?: string; agent_status?: string; status?: string; os_name?: string }[];
  last_result?: {
    status?: number;
    job_action?: number;
    time_start?: number;
    time_end?: number;
    transfered_bytes?: number;
    transferred_bytes?: number;
    success_count?: number;
    warning_count?: number;
    error_count?: number;
  } | null;
  next_trigger_time?: number;
  version_count?: number;
  target_status?: string;
  status?: number | string;
}

const toMs = (sec?: number) => (sec && sec > 0 ? (sec < 1e12 ? sec * 1000 : sec) : null);

export class AbbSource implements DeviceSource {
  readonly intervalMs = 60_000;
  private lease: ReturnType<typeof acquireSession>;
  private lastRaw: unknown;

  constructor(private cfg: DeviceConfig) {
    this.lease = acquireSession(cfg);
  }

  private list() {
    return this.lease.session.call<{ tasks?: RawTask[]; total?: number }>('SYNO.ActiveBackup.Task', 'list', 1, {
      load_status: 'true',
      load_result: 'true',
      load_devices: 'true',
      load_versions: 'false',
      offset: '0',
      limit: '500',
    });
  }

  async test() {
    if (!(await this.lease.session.has('SYNO.ActiveBackup.Task'))) {
      throw new Error('Paket Active Backup for Business tidak ditemukan di NAS ini');
    }
    const r = await this.list();
    return `Active Backup for Business · ${r.tasks?.length ?? 0} tugas`;
  }

  async sample(): Promise<DeviceSample> {
    const r = await this.list();
    this.lastRaw = r;
    const staleMs = (this.cfg.options.staleHours ?? 26) * 3600_000;
    const now = Date.now();

    const tasks = (r.tasks ?? []).map((t) => {
      const lr = t.last_result ?? null;
      const start = toMs(lr?.time_start);
      const end = toMs(lr?.time_end);
      let result: Result = !lr ? 'none' : (RESULT[lr.status ?? -1] ?? 'unknown');
      if (lr && start && !end && result !== 'failed' && result !== 'canceled') result = 'running';
      const devices = (t.devices ?? []).map((d) => ({
        name: d.host_name || d.host_ip || '-',
        ip: d.host_ip ?? '',
        os: d.os_name ?? '',
        online: (d.agent_status ?? d.status ?? 'online').toLowerCase() === 'online',
      }));
      return {
        id: t.task_id,
        name: t.task_name ?? `Tugas ${t.task_id}`,
        type: TYPE[t.backup_type ?? 0] ?? 'Lainnya',
        devices,
        deviceCount: t.device_count ?? devices.length,
        result,
        resultCode: lr?.status ?? null,
        start,
        end,
        durationMs: start && end ? end - start : start && result === 'running' ? now - start : null,
        bytes: lr?.transfered_bytes ?? lr?.transferred_bytes ?? null,
        counts: lr ? { ok: lr.success_count ?? 0, warn: lr.warning_count ?? 0, err: lr.error_count ?? 0 } : null,
        next: toMs(t.next_trigger_time),
        versions: t.version_count ?? null,
        targetOnline: t.target_status ? t.target_status === 'online' : null,
      };
    });

    // Urutan: gagal → sebagian → berjalan → lainnya; lalu paling baru
    const rank: Record<Result, number> = { failed: 0, partial: 1, running: 2, unknown: 3, canceled: 4, none: 5, success: 6 };
    tasks.sort((a, b) => rank[a.result] - rank[b.result] || (b.end ?? b.start ?? 0) - (a.end ?? a.start ?? 0));

    const by = (x: Result) => tasks.filter((t) => t.result === x);
    const failed = by('failed');
    const partial = by('partial');
    const stale = tasks.filter((t) => t.result === 'success' && t.end && now - t.end > staleMs);
    const offline = tasks.flatMap((t) => t.devices.filter((d) => !d.online).map((d) => `${d.name} (${t.name})`));
    const lastEnd = tasks.reduce<number | null>((m, t) => (t.end && (!m || t.end > m) ? t.end : m), null);

    const checks: Check[] = [
      {
        rule: 'abb_failed',
        clearAfter: 1,
        hit: failed.length
          ? { severity: 'critical', title: `${failed.length} backup gagal`, message: failed.map((t) => t.name).join(', ') }
          : null,
      },
      {
        rule: 'abb_partial',
        clearAfter: 1,
        hit: partial.length
          ? { severity: 'warning', title: `${partial.length} backup sebagian berhasil`, message: partial.map((t) => t.name).join(', ') }
          : null,
      },
      {
        rule: 'abb_stale',
        clearAfter: 1,
        hit: stale.length
          ? {
              severity: 'warning',
              title: `${stale.length} tugas tidak backup > ${this.cfg.options.staleHours ?? 26} jam`,
              message: stale.map((t) => t.name).join(', '),
            }
          : null,
      },
      {
        rule: 'abb_device_offline',
        raiseAfter: 2,
        hit: offline.length ? { severity: 'warning', title: `${offline.length} perangkat offline`, message: offline.join(', ') } : null,
      },
    ];

    return {
      series: {
        success: by('success').length,
        failed: failed.length,
        partial: partial.length,
        running: by('running').length,
      },
      data: {
        tasks,
        total: tasks.length,
        devicesTotal: tasks.reduce((a, t) => a + t.devices.length, 0),
        devicesOnline: tasks.reduce((a, t) => a + t.devices.filter((d) => d.online).length, 0),
        lastEnd,
        bytes24h: tasks.filter((t) => t.end && now - t.end < 86400_000).reduce((a, t) => a + (t.bytes ?? 0), 0),
      },
      checks,
    };
  }

  raw() {
    return this.lastRaw;
  }

  async close() {
    await this.lease.release();
  }
}
