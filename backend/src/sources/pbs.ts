import { HttpError, requestJson } from '../http.js';
import { level, pct, r1, type Check, type DeviceConfig, type DeviceSample, type DeviceSource } from './types.js';

interface DsUsage {
  store: string;
  total?: number;
  used?: number;
  avail?: number;
  'estimated-full-date'?: number;
  error?: string;
}
interface Group {
  'backup-type': string; // vm | ct | host
  'backup-id': string;
  'last-backup'?: number; // detik epoch
  'backup-count'?: number;
  owner?: string;
  comment?: string;
}
interface Task {
  upid: string;
  worker_type: string;
  worker_id?: string;
  starttime: number;
  endtime?: number;
  status?: string; // OK | WARNINGS: n | pesan error | (kosong = berjalan)
  user?: string;
}

const TYPE_LABEL: Record<string, string> = {
  backup: 'Backup',
  verify: 'Verifikasi',
  verificationjob: 'Verifikasi',
  garbage_collection: 'Garbage collection',
  prune: 'Prune',
  prunejob: 'Prune',
  syncjob: 'Sinkronisasi',
  'tape-backup-job': 'Tape backup',
  reader: 'Restore',
};
const IGNORED = new Set(['reader', 'termproxy', 'logrotate', 'aptupdate', 'acme-renew']);

/** OK / WARNINGS / ERROR / RUNNING dari status tugas PBS */
function resultOf(t: Task): 'running' | 'ok' | 'warning' | 'error' {
  if (!t.endtime || !t.status) return 'running';
  if (t.status === 'OK') return 'ok';
  if (t.status.startsWith('WARNINGS')) return 'warning';
  return 'error';
}

/**
 * Proxmox Backup Server lewat API resmi (https://<host>:8007/api2/json).
 * Login: API token (Configuration → Access Control → API Token) dengan role Audit di path "/".
 *   username = token ID lengkap, mis. monitor@pbs!dashboard
 *   password = secret token
 */
export class PbsSource implements DeviceSource {
  readonly intervalMs = 15_000;
  private base: string;
  private lastRaw: unknown;
  private groupsCache: { ts: number; byStore: Record<string, Group[]> } | null = null;

  constructor(private cfg: DeviceConfig) {
    const scheme = cfg.options.https === false ? 'http' : 'https';
    this.base = `${scheme}://${cfg.host}:${cfg.port ?? 8007}/api2/json`;
  }

  private async get<T>(path: string): Promise<T> {
    try {
      const r = await requestJson<{ data: T }>(`${this.base}${path}`, {
        headers: { Authorization: `PBSAPIToken=${this.cfg.username}:${this.cfg.password}` },
      });
      return r.data;
    } catch (e) {
      if (e instanceof HttpError && (e.status === 401 || e.status === 400)) {
        throw new Error('Token ditolak. Periksa Token ID (user@realm!nama) dan secret');
      }
      if (e instanceof HttpError && e.status === 403) {
        throw new Error('Akses ditolak (403). Beri token ini role Audit pada path "/" (Access Control → Permissions → Add → API Token Permission)');
      }
      throw e;
    }
  }

  async test() {
    const v = await this.get<{ version: string; release?: string }>('/version');
    const ds = await this.get<DsUsage[]>('/status/datastore-usage');
    if (!ds.length) throw new Error('Token tidak bisa melihat datastore. Beri role Audit pada path "/" untuk token ini');
    return `Proxmox Backup Server ${v.version}${v.release ? '.' + v.release : ''} · ${ds.length} datastore`;
  }

  /** Daftar grup backup per datastore (diperbarui tiap 2 menit; bisa banyak) */
  private async groups(stores: string[]) {
    if (this.groupsCache && Date.now() - this.groupsCache.ts < 120_000) return this.groupsCache.byStore;
    const byStore: Record<string, Group[]> = {};
    await Promise.all(
      stores.map(async (s) => {
        byStore[s] = await this.get<Group[]>(`/admin/datastore/${encodeURIComponent(s)}/groups`).catch(() => []);
      }),
    );
    this.groupsCache = { ts: Date.now(), byStore };
    return byStore;
  }

  async sample(): Promise<DeviceSample> {
    const since = Math.floor(Date.now() / 1000) - 26 * 3600;
    const [node, usage, tasks, version] = await Promise.all([
      this.get<{
        cpu?: number;
        wait?: number;
        memory?: { used: number; total: number };
        root?: { used: number; total: number };
        uptime?: number;
        loadavg?: number[];
        info?: { fingerprint?: string };
      }>('/nodes/localhost/status'),
      this.get<DsUsage[]>('/status/datastore-usage'),
      this.get<Task[]>(`/nodes/localhost/tasks?since=${since}&limit=500`).catch(() => [] as Task[]),
      this.get<{ version: string; release?: string }>('/version').catch(() => null),
    ]);
    const stores = usage.map((d) => d.store);
    const groupsBy = await this.groups(stores);
    this.lastRaw = { node, usage, tasks: tasks.slice(0, 50), groups: groupsBy };

    const cpuPct = node.cpu != null ? r1(node.cpu * 100) : null;
    const memPct = pct(node.memory?.used, node.memory?.total);
    const datastores = usage
      .map((d) => ({
        name: d.store,
        used: d.used ?? null,
        total: d.total ?? null,
        pct: pct(d.used, d.total),
        fullAt: d['estimated-full-date'] && d['estimated-full-date'] > 0 ? d['estimated-full-date'] * 1000 : null,
        error: d.error ?? null,
      }))
      .sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0));
    const worst = datastores[0];

    // Tugas 24 jam terakhir (tanpa tugas rutin yang tidak penting)
    const list = tasks
      .filter((t) => !IGNORED.has(t.worker_type))
      .map((t) => {
        const [store, target] = (t.worker_id ?? '').includes(':') ? t.worker_id!.split(/:(.+)/) : ['', t.worker_id ?? ''];
        return {
          upid: t.upid,
          type: t.worker_type,
          typeLabel: TYPE_LABEL[t.worker_type] ?? t.worker_type,
          store,
          target: target ?? '',
          start: t.starttime * 1000,
          end: t.endtime ? t.endtime * 1000 : null,
          durationMs: t.endtime ? (t.endtime - t.starttime) * 1000 : Date.now() - t.starttime * 1000,
          result: resultOf(t),
          status: t.status ?? '',
        };
      })
      .sort((a, b) => b.start - a.start);
    const day = Date.now() - 86400_000;
    const backups24 = list.filter((t) => t.type === 'backup' && t.start >= day);
    const okCount = backups24.filter((t) => t.result === 'ok' || t.result === 'warning').length;

    // Backup gagal yang BELUM disusul backup sukses untuk VM/CT yang sama
    const failedOpen = list.filter(
      (t) =>
        t.type === 'backup' &&
        t.result === 'error' &&
        t.start >= day &&
        !list.some((o) => o.type === 'backup' && o.target === t.target && o.store === t.store && o.start > t.start && (o.result === 'ok' || o.result === 'warning')),
    );
    const otherFailed = list.filter((t) => t.type !== 'backup' && t.result === 'error' && t.start >= day);

    // Grup backup (per VM/CT/host): kapan terakhir dibackup
    const staleMs = (this.cfg.options.staleHours ?? 26) * 3600_000;
    const groups = Object.entries(groupsBy)
      .flatMap(([store, gs]) =>
        gs.map((g) => {
          const last = g['last-backup'] ? g['last-backup'] * 1000 : null;
          return {
            id: `${store}/${g['backup-type']}/${g['backup-id']}`,
            store,
            type: g['backup-type'],
            backupId: g['backup-id'],
            comment: g.comment ?? '',
            last,
            count: g['backup-count'] ?? null,
            stale: last != null && Date.now() - last > staleMs,
          };
        }),
      )
      .sort((a, b) => Number(b.stale) - Number(a.stale) || (a.last ?? 0) - (b.last ?? 0));
    const stale = groups.filter((g) => g.stale);
    const lastBackup = Math.max(0, ...groups.map((g) => g.last ?? 0), ...backups24.filter((t) => t.end && t.result !== 'error').map((t) => t.end!)) || null;

    const checks: Check[] = [];
    const cpuLv = level(cpuPct, 80, 90);
    checks.push({ rule: 'pbs_cpu', raiseAfter: 4, hit: cpuLv && { severity: cpuLv, title: `CPU PBS ${Math.round(cpuPct!)}%`, message: '' } });
    const memLv = level(memPct, 85, 95);
    checks.push({ rule: 'pbs_mem', raiseAfter: 4, hit: memLv && { severity: memLv, title: `RAM PBS ${Math.round(memPct!)}%`, message: '' } });
    const dsLv = level(worst?.pct, 85, 95);
    checks.push({
      rule: 'pbs_datastore',
      raiseAfter: 2,
      hit: dsLv && { severity: dsLv, title: `Datastore ${worst!.name} terisi ${Math.round(worst!.pct!)}%`, message: worst!.fullAt ? `Perkiraan penuh ${new Date(worst!.fullAt).toLocaleDateString('id-ID')}` : '' },
    });
    const soon = datastores.filter((d) => d.fullAt && d.fullAt - Date.now() < 30 * 86400_000);
    checks.push({
      rule: 'pbs_full_soon',
      raiseAfter: 2,
      hit: soon.length && !dsLv ? { severity: 'warning', title: `Datastore ${soon[0].name} diperkirakan penuh < 30 hari`, message: new Date(soon[0].fullAt!).toLocaleDateString('id-ID') } : null,
    });
    checks.push({
      rule: 'pbs_backup_failed',
      clearAfter: 1,
      hit: failedOpen.length
        ? { severity: 'critical', title: `${failedOpen.length} backup gagal`, message: failedOpen.map((t) => `${t.target} (${t.status.slice(0, 60)})`).join(', ') }
        : null,
    });
    checks.push({
      rule: 'pbs_task_failed',
      clearAfter: 1,
      hit: otherFailed.length
        ? { severity: 'warning', title: `${otherFailed.length} tugas ${[...new Set(otherFailed.map((t) => t.typeLabel.toLowerCase()))].join('/')} gagal`, message: otherFailed.map((t) => `${t.typeLabel} ${t.store}`).join(', ') }
        : null,
    });
    checks.push({
      rule: 'pbs_stale',
      clearAfter: 1,
      hit: stale.length
        ? { severity: 'warning', title: `${stale.length} VM/CT tidak dibackup > ${this.cfg.options.staleHours ?? 26} jam`, message: stale.slice(0, 8).map((g) => `${g.type}/${g.backupId}`).join(', ') }
        : null,
    });

    return {
      series: {
        cpu: cpuPct,
        mem: memPct,
        datastore: worst?.pct ?? null,
        iowait: node.wait != null ? r1(node.wait * 100) : null,
        ...Object.fromEntries(datastores.slice(0, 4).map((d) => [`ds.${d.name}`, d.pct])),
        backupOk: okCount,
        backupFailed: failedOpen.length,
      },
      data: {
        version: version ? `${version.version}${version.release ? '.' + version.release : ''}` : null,
        uptime: node.uptime ?? null,
        load: node.loadavg?.[0] ?? null,
        memUsed: node.memory?.used ?? null,
        memTotal: node.memory?.total ?? null,
        rootPct: pct(node.root?.used, node.root?.total),
        datastores,
        groups,
        tasks: list.slice(0, 80),
        counts: {
          backups24: backups24.length,
          ok24: okCount,
          failedOpen: failedOpen.length,
          running: list.filter((t) => t.result === 'running').length,
          groups: groups.length,
          stale: stale.length,
        },
        lastBackup,
        staleHours: this.cfg.options.staleHours ?? 26,
      },
      checks,
    };
  }

  raw() {
    return this.lastRaw;
  }

  async close() {}
}
