import { requestJson } from '../http.js';
import { level, pct, r1, type Check, type DeviceConfig, type DeviceSample, type DeviceSource } from './types.js';

interface Resource {
  type: 'node' | 'qemu' | 'lxc' | 'storage' | 'sdn' | 'pool';
  id: string;
  node?: string;
  status?: string;
  name?: string;
  vmid?: number;
  storage?: string;
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  uptime?: number;
  template?: number;
  shared?: number;
}

/**
 * Proxmox VE lewat API resmi (https://<host>:8006/api2/json).
 * Login: API token (Datacenter → Permissions → API Tokens), cukup role PVEAuditor (hanya baca).
 *   username = token ID lengkap, mis. monitor@pve!dbmon
 *   password = secret token (UUID)
 */
export class ProxmoxSource implements DeviceSource {
  readonly intervalMs = 5000;
  private base: string;
  private lastRaw: unknown;
  /** VM/CT yang pernah terlihat berjalan → bila berhenti, muncul alert */
  private everRunning = new Set<string>();

  constructor(private cfg: DeviceConfig) {
    const scheme = cfg.options.https === false ? 'http' : 'https';
    this.base = `${scheme}://${cfg.host}:${cfg.port ?? 8006}/api2/json`;
  }

  private get<T>(path: string) {
    return requestJson<{ data: T }>(`${this.base}${path}`, {
      headers: { Authorization: `PVEAPIToken=${this.cfg.username}=${this.cfg.password}` },
    }).then((r) => r.data);
  }

  async test() {
    const v = await this.get<{ version: string; release?: string }>('/version');
    const res = await this.get<Resource[]>('/cluster/resources');
    const nodes = res.filter((r) => r.type === 'node').length;
    const guests = res.filter((r) => (r.type === 'qemu' || r.type === 'lxc') && !r.template).length;
    if (!nodes) throw new Error('Token tidak bisa membaca node. Beri role PVEAuditor pada path "/" untuk token ini.');
    return `Proxmox VE ${v.version} · ${nodes} node · ${guests} VM/CT`;
  }

  async sample(): Promise<DeviceSample> {
    const all = await this.get<Resource[]>('/cluster/resources');
    const only = this.cfg.options.node?.trim();
    const res = only ? all.filter((r) => r.node === only) : all;
    const nodes = res.filter((r) => r.type === 'node');
    const guests = res.filter((r) => (r.type === 'qemu' || r.type === 'lxc') && !r.template);
    const storages = res.filter((r) => r.type === 'storage' && r.maxdisk);

    // Detail node (load, iowait, versi) & trafik jaringan dari rrd menit terakhir
    const online = nodes.filter((n) => n.status === 'online');
    const details = await Promise.all(
      online.map(async (n) => {
        const [status, rrd] = await Promise.all([
          this.get<{
            cpu: number;
            wait?: number;
            loadavg?: string[];
            memory: { used: number; total: number };
            rootfs?: { used: number; total: number };
            uptime: number;
            pveversion?: string;
            cpuinfo?: { model?: string; cpus?: number };
          }>(`/nodes/${encodeURIComponent(n.node!)}/status`).catch(() => null),
          this.get<{ time: number; netin?: number; netout?: number }[]>(
            `/nodes/${encodeURIComponent(n.node!)}/rrddata?timeframe=hour&cf=AVERAGE`,
          ).catch(() => []),
        ]);
        const lastNet = [...rrd].reverse().find((x) => x.netin != null);
        return { node: n.node!, status, netIn: lastNet?.netin ?? null, netOut: lastNet?.netout ?? null };
      }),
    );
    this.lastRaw = { resources: all, nodeStatus: details };

    const sum = (xs: Resource[], f: (r: Resource) => number | undefined) => xs.reduce((a, r) => a + (f(r) ?? 0), 0);
    const cpuPct = pct(sum(online, (n) => (n.cpu ?? 0) * (n.maxcpu ?? 0)), sum(online, (n) => n.maxcpu));
    const memPct = pct(sum(online, (n) => n.mem), sum(online, (n) => n.maxmem));
    const storageList = storages
      .map((s) => ({
        name: s.storage ?? s.id,
        node: s.node ?? '',
        status: s.status ?? '',
        shared: !!s.shared,
        used: s.disk ?? 0,
        total: s.maxdisk ?? 0,
        pct: pct(s.disk, s.maxdisk),
      }))
      // storage bersama (shared) muncul sekali per node → tampilkan sekali
      .filter((s, i, arr) => !s.shared || arr.findIndex((x) => x.shared && x.name === s.name) === i)
      .sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0));
    const worstStorage = storageList[0];

    const guestList = guests
      .map((g) => ({
        id: `${g.type}/${g.vmid}`,
        vmid: g.vmid,
        name: g.name ?? `${g.type}-${g.vmid}`,
        type: g.type === 'qemu' ? 'VM' : 'CT',
        node: g.node ?? '',
        status: g.status ?? 'unknown',
        cpuPct: r1((g.cpu ?? 0) * 100),
        memPct: pct(g.mem, g.maxmem),
        memUsed: g.mem ?? 0,
        uptime: g.uptime ?? 0,
      }))
      .sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || (b.cpuPct ?? 0) - (a.cpuPct ?? 0));
    for (const g of guestList) if (g.status === 'running') this.everRunning.add(g.id);

    const vm = guestList.filter((g) => g.type === 'VM');
    const ct = guestList.filter((g) => g.type === 'CT');
    const netIn = details.reduce((a, d) => a + (d.netIn ?? 0), 0);
    const netOut = details.reduce((a, d) => a + (d.netOut ?? 0), 0);
    const iowait = details.length ? r1((details.reduce((a, d) => a + (d.status?.wait ?? 0), 0) / details.length) * 100) : null;

    const checks: Check[] = [];
    const offline = nodes.filter((n) => n.status !== 'online');
    checks.push({
      rule: 'pve_node_offline',
      raiseAfter: 2,
      hit: offline.length
        ? { severity: 'critical', title: `${offline.length} node offline`, message: offline.map((n) => n.node).join(', ') }
        : null,
    });
    const cpuLv = level(cpuPct, 80, 90);
    checks.push({ rule: 'pve_cpu', raiseAfter: 6, hit: cpuLv && { severity: cpuLv, title: `CPU tinggi (${Math.round(cpuPct!)}%)`, message: 'Rata-rata semua node' } });
    const memLv = level(memPct, 85, 95);
    checks.push({ rule: 'pve_mem', raiseAfter: 6, hit: memLv && { severity: memLv, title: `RAM tinggi (${Math.round(memPct!)}%)`, message: 'Rata-rata semua node' } });
    const stLv = level(worstStorage?.pct, 85, 95);
    checks.push({
      rule: 'pve_storage',
      raiseAfter: 2,
      hit: stLv && { severity: stLv, title: `Storage ${worstStorage!.name} ${Math.round(worstStorage!.pct!)}%`, message: `Node ${worstStorage!.node || '-'}` },
    });
    const stopped = guestList.filter((g) => g.status !== 'running' && this.everRunning.has(g.id));
    checks.push({
      rule: 'pve_guest_stopped',
      raiseAfter: 2,
      hit: stopped.length
        ? { severity: 'warning', title: `${stopped.length} VM/CT berhenti`, message: stopped.map((g) => `${g.vmid} ${g.name}`).join(', ') }
        : null,
    });

    return {
      series: {
        cpu: cpuPct,
        mem: memPct,
        storage: worstStorage?.pct ?? null,
        netIn: r1(netIn),
        netOut: r1(netOut),
        iowait,
        vmRunning: vm.filter((g) => g.status === 'running').length,
        ctRunning: ct.filter((g) => g.status === 'running').length,
      },
      data: {
        nodes: nodes.map((n) => {
          const d = details.find((x) => x.node === n.node);
          return {
            name: n.node,
            status: n.status,
            cpuPct: r1((n.cpu ?? 0) * 100),
            memPct: pct(n.mem, n.maxmem),
            cores: n.maxcpu,
            memTotal: n.maxmem,
            uptime: n.uptime ?? 0,
            version: d?.status?.pveversion ?? null,
            load: d?.status?.loadavg?.[0] ?? null,
          };
        }),
        guests: guestList,
        storages: storageList,
        counts: {
          vmTotal: vm.length,
          vmRunning: vm.filter((g) => g.status === 'running').length,
          ctTotal: ct.length,
          ctRunning: ct.filter((g) => g.status === 'running').length,
        },
        memUsed: sum(online, (n) => n.mem),
        memTotal: sum(online, (n) => n.maxmem),
        uptime: Math.max(0, ...online.map((n) => n.uptime ?? 0)),
      },
      checks,
    };
  }

  raw() {
    return this.lastRaw;
  }

  async close() {}
}
