import * as syslog from './syslog.js';
import type { Check, DeviceConfig, DeviceSample, DeviceSource } from './types.js';

/**
 * Backup QNAP: Hybrid Backup Sync 3, Hyper Data Protector & NetBak Replicator.
 * Ketiganya tidak punya API resmi, jadi statusnya dibaca dari log yang dikirim NAS ke Dashboard
 * (QuLog Center → Log Sender → Send to Syslog Server, port 514):
 *  - HBS 3 & Hyper Data Protector menulis event log tiap tugas mulai / selesai / gagal.
 *  - NetBak Replicator berjalan di PC Windows dan tidak menulis log di NAS; yang terlihat adalah
 *    aktivitas tulis file dari tiap PC ke folder tujuan backup (access log SMB). Bila sebuah PC tidak
 *    menulis ke folder itu lebih dari batas jam → dianggap backup-nya berhenti.
 * Tampilan memakai bentuk data yang sama dengan Active Backup (panel Backup).
 */
type Result = 'running' | 'success' | 'partial' | 'failed' | 'canceled' | 'none' | 'unknown';
const RESULT: Record<syslog.JobStatus, Result> = {
  running: 'running',
  success: 'success',
  warning: 'partial',
  failed: 'failed',
  stopped: 'canceled',
  info: 'unknown',
};
const SHORT = (app: string) =>
  /hybrid backup|hbs/i.test(app) ? 'HBS 3' : /hyper data|hdp/i.test(app) ? 'Hyper Data Protector' : /netbak/i.test(app) ? 'NetBak' : app;

interface Task {
  id: number;
  name: string;
  type: string;
  devices: { name: string; ip: string; os: string; online: boolean }[];
  deviceCount: number;
  result: Result;
  start: number | null;
  end: number | null;
  durationMs: number | null;
  bytes: number | null;
  counts: null;
  next: null;
  note: string | null;
  lastSuccess: number | null;
}

export class QnapBackupSource implements DeviceSource {
  readonly intervalMs = 30_000;
  private host: string;
  private lastRaw: unknown;

  constructor(private cfg: DeviceConfig) {
    this.host = cfg.host.trim().toLowerCase();
    syslog.watch(this.host);
  }

  async test() {
    await syslog.ensureListener();
    const err = syslog.listenerError();
    if (err) throw new Error(err);
    const s = syslog.seen(this.host);
    return s.last
      ? `Penerima log aktif (port ${syslog.SYSLOG_PORT}) · ${s.n} log diterima dari ${this.cfg.host}`
      : `Penerima log aktif di port ${syslog.SYSLOG_PORT} (UDP/TCP). Belum ada log dari ${this.cfg.host} — atur QuLog Center → Log Sender ke IP komputer Dashboard`;
  }

  async sample(): Promise<DeviceSample> {
    await syslog.ensureListener();
    const err = syslog.listenerError();
    syslog.prune();
    const now = Date.now();
    const staleH = this.cfg.options.staleHours ?? 26;
    const staleMs = staleH * 3600_000;

    // Status tiap tugas = kejadian terakhirnya (30 hari terakhir)
    const evs = syslog.events(this.host, now - 30 * 86400_000);
    const jobs = new Map<string, Task>();
    let id = 1;
    for (const e of evs) {
      if (!e.job || e.status === 'info') continue;
      const incoming = e.client ? ` ← ${e.client}` : '';
      const key = `${SHORT(e.app)}|${e.job}${incoming}`;
      let t = jobs.get(key);
      if (!t) {
        t = {
          id: id++,
          name: e.job + incoming,
          type: `${SHORT(e.app)}${e.kind ? ` · ${e.kind}` : ''}`,
          devices: [],
          deviceCount: 0,
          result: 'unknown',
          start: null,
          end: null,
          durationMs: null,
          bytes: null,
          counts: null,
          next: null,
          note: null,
          lastSuccess: null,
        };
        jobs.set(key, t);
      }
      if (e.kind && !t.type.includes('·')) t.type += ` · ${e.kind}`;
      t.note = e.message;
      if (e.status === 'running') {
        t.result = 'running';
        t.start = e.ts;
        t.end = null;
      } else {
        t.result = RESULT[e.status];
        t.end = e.ts;
        if (t.start && t.start > e.ts) t.start = null;
        if (e.status === 'success') t.lastSuccess = e.ts;
      }
      t.durationMs = t.start && t.end ? t.end - t.start : t.start ? now - t.start : null;
    }
    // "Berjalan" tanpa kabar selesai > 2 hari → kemungkinan pesan selesainya terlewat
    for (const t of jobs.values()) if (t.result === 'running' && t.start && now - t.start > 48 * 3600_000) t.result = 'unknown';

    // NetBak Replicator: aktivitas tulis per PC ke folder tujuan
    const folder = (this.cfg.options.netbakFolder ?? '').trim().replace(/^\/+|\/+$/g, '').split('/')[0];
    const pcs = folder ? syslog.access(this.host, folder) : [];
    for (const p of pcs) {
      const fresh = now - p.lastTs <= staleMs;
      jobs.set(`netbak|${p.client}`, {
        id: id++,
        name: p.client,
        type: `NetBak Replicator · ${folder}`,
        devices: [{ name: p.client, ip: p.ip ?? '', os: 'Windows', online: fresh }],
        deviceCount: 1,
        result: fresh ? 'success' : 'failed',
        start: null,
        end: p.lastTs,
        durationMs: null,
        bytes: null,
        counts: null,
        next: null,
        note: fresh
          ? `Terakhir menulis ke folder ${folder}${p.user ? ` (user ${p.user})` : ''}`
          : `Tidak ada file baru ke folder ${folder} lebih dari ${staleH} jam`,
        lastSuccess: p.lastTs,
      });
    }

    const tasks = [...jobs.values()];
    const rank: Record<Result, number> = { failed: 0, partial: 1, running: 2, unknown: 3, canceled: 4, none: 5, success: 6 };
    tasks.sort((a, b) => rank[a.result] - rank[b.result] || (b.end ?? b.start ?? 0) - (a.end ?? a.start ?? 0));

    const by = (x: Result) => tasks.filter((t) => t.result === x);
    const netbak = (t: Task) => t.type.startsWith('NetBak Replicator');
    const failed = by('failed').filter((t) => !netbak(t));
    const pcStale = by('failed').filter(netbak);
    const partial = by('partial');
    const stale = tasks.filter((t) => !netbak(t) && t.result !== 'running' && t.lastSuccess && now - t.lastSuccess > staleMs && t.result === 'success');
    const seen = syslog.seen(this.host);
    const lastEnd = tasks.reduce<number | null>((m, t) => (t.end && (!m || t.end > m) ? t.end : m), null);

    const checks: Check[] = [
      {
        rule: 'qbk_failed',
        clearAfter: 1,
        hit: failed.length ? { severity: 'critical', title: `${failed.length} backup QNAP gagal`, message: failed.map((t) => `${t.name}: ${t.note ?? ''}`).join(' · ').slice(0, 400) } : null,
      },
      {
        rule: 'qbk_partial',
        clearAfter: 1,
        hit: partial.length ? { severity: 'warning', title: `${partial.length} backup QNAP selesai dengan error`, message: partial.map((t) => t.name).join(', ') } : null,
      },
      {
        rule: 'qbk_stale',
        clearAfter: 1,
        hit: stale.length ? { severity: 'warning', title: `${stale.length} tugas tidak backup > ${staleH} jam`, message: stale.map((t) => t.name).join(', ') } : null,
      },
      {
        rule: 'qbk_netbak_stale',
        clearAfter: 1,
        hit: pcStale.length
          ? { severity: 'warning', title: `${pcStale.length} PC NetBak tidak backup > ${staleH} jam`, message: pcStale.map((t) => t.name).join(', ') }
          : null,
      },
      {
        rule: 'qbk_no_log',
        raiseAfter: 2,
        hit:
          err != null
            ? { severity: 'critical', title: 'Penerima log backup tidak aktif', message: err }
            : seen.last && now - seen.last > staleMs
              ? { severity: 'warning', title: `Tidak ada log dari NAS > ${staleH} jam`, message: 'Periksa QuLog Center → Log Sender di QNAP' }
              : null,
      },
    ];

    const recent = syslog.recent(this.host, 40).map((e) => ({ ts: e.ts, app: SHORT(e.app), job: e.job, status: e.status, message: e.message }));
    this.lastRaw = { seen, recent };

    return {
      series: { success: by('success').length, failed: by('failed').length, partial: partial.length, running: by('running').length },
      data: {
        tasks: tasks.map(({ lastSuccess: _l, ...t }) => t),
        total: tasks.length,
        devicesTotal: pcs.length,
        devicesOnline: pcs.filter((p) => now - p.lastTs <= staleMs).length,
        lastEnd,
        bytes24h: 0,
        events: recent,
        logSource: { lastLog: seen.last, logs: seen.n, port: syslog.SYSLOG_PORT, error: err },
      },
      checks,
    };
  }

  raw() {
    return this.lastRaw;
  }

  async close() {
    syslog.unwatch(this.host);
  }
}
