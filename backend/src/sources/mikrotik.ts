import { HttpError, requestJson } from '../http.js';
import { level, pct, r1, type Check, type DeviceConfig, type DeviceSample, type DeviceSource } from './types.js';

/** RouterOS REST mengembalikan semua nilai sebagai teks */
type Rec = Record<string, string | undefined>;

const n = (x: string | undefined) => {
  if (x == null || x === '') return null;
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
};
const yes = (x: string | undefined) => x === 'true' || x === 'yes';

/** "1w2d03:04:05" / "3d4h5m6s" → detik */
export function parseUptime(s: string | undefined): number | null {
  if (!s) return null;
  let total = 0;
  let matched = false;
  const units: Record<string, number> = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 };
  for (const m of s.matchAll(/(\d+)([wdhms])/g)) {
    total += Number(m[1]) * units[m[2]];
    matched = true;
  }
  const hms = s.match(/(\d+):(\d+):(\d+)$/);
  if (hms) {
    total += Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]);
    matched = true;
  }
  return matched ? total : null;
}

/**
 * MikroTik RouterOS v7 lewat REST API (/rest, RouterOS 7.1+).
 * Aktifkan service "www-ssl" (https) atau "www" (http) di IP → Services, dan buat user
 * grup "read" khusus pemantauan. RouterOS v6 belum punya REST API.
 *
 * Yang dibaca: resource (CPU/RAM/disk/uptime), health (suhu), interface (trafik),
 * default route (ISP mana yang aktif / failover), Netwatch, jumlah klien DHCP.
 */
export class MikrotikSource implements DeviceSource {
  readonly intervalMs = 10_000;
  private base: string;
  private auth: string;
  private lastRaw: unknown;
  private prev = new Map<string, { ts: number; rx: number; tx: number }>();
  private everRunning = new Set<string>();

  constructor(private cfg: DeviceConfig) {
    const https = cfg.options.https === true;
    this.base = `${https ? 'https' : 'http'}://${cfg.host}:${cfg.port ?? (https ? 443 : 80)}/rest`;
    this.auth = 'Basic ' + Buffer.from(`${cfg.username ?? ''}:${cfg.password ?? ''}`).toString('base64');
  }

  private async get<T>(path: string): Promise<T> {
    try {
      return await requestJson<T>(`${this.base}${path}`, { headers: { Authorization: this.auth } });
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) throw new Error('Login ditolak (401): periksa username & password MikroTik');
      if (e instanceof HttpError && e.status === 404) throw new Error('REST API tidak ditemukan (404). Butuh RouterOS v7.1+ dan service www/www-ssl aktif');
      throw e;
    }
  }

  async test() {
    const [res, id] = await Promise.all([this.get<Rec>('/system/resource'), this.get<Rec>('/system/identity')]);
    return `${id.name ?? 'MikroTik'} · ${res['board-name'] ?? ''} · RouterOS ${res.version ?? ''}`;
  }

  async sample(): Promise<DeviceSample> {
    const [res, id, ifaces, routes, netwatch, health, leases] = await Promise.all([
      this.get<Rec>('/system/resource'),
      this.get<Rec>('/system/identity'),
      this.get<Rec[]>('/interface'),
      this.get<Rec[]>('/ip/route?dst-address=0.0.0.0/0').catch(() => [] as Rec[]),
      this.get<Rec[]>('/tool/netwatch').catch(() => [] as Rec[]),
      this.get<Rec[] | Rec>('/system/health').catch(() => [] as Rec[]),
      this.get<Rec[]>('/ip/dhcp-server/lease?.proplist=status').catch(() => null),
    ]);
    this.lastRaw = { resource: res, identity: id, interfaces: ifaces, routes, netwatch, health };

    const memTotal = n(res['total-memory']);
    const memFree = n(res['free-memory']);
    const memUsed = memTotal != null && memFree != null ? memTotal - memFree : null;
    const hddTotal = n(res['total-hdd-space']);
    const hddFree = n(res['free-hdd-space']);
    const cpuPct = n(res['cpu-load']);
    const memPct = pct(memUsed, memTotal);

    // Suhu: v7 = daftar {name, value}, v6 = satu objek
    const hl = Array.isArray(health) ? health : [];
    const hv = (re: RegExp) => n(hl.find((h) => re.test(h.name ?? ''))?.value) ?? (!Array.isArray(health) ? n(Object.entries(health).find(([k]) => re.test(k))?.[1]) : null);
    const temp = hv(/^(cpu-)?temperature$/) ?? hv(/temperature/);
    const voltage = hv(/^voltage$/);

    // ── Default route: gateway, interface, jarak, aktif ──
    const rts = routes
      .filter((r) => !yes(r.disabled) && (r['dst-address'] ?? '0.0.0.0/0') === '0.0.0.0/0' && (!r['routing-table'] || r['routing-table'] === 'main'))
      .map((r) => {
        const imm = r['immediate-gw'] ?? '';
        const gw = r.gateway ?? '';
        const iface = imm.includes('%') ? imm.split('%')[1] : /^[\d.]+$/.test(gw) ? imm || '' : gw;
        return { gateway: gw, iface, distance: n(r.distance) ?? 1, active: yes(r.active), comment: r.comment ?? '' };
      })
      .sort((a, b) => a.distance - b.distance);
    const wanNames = new Set(rts.map((r) => r.iface).filter(Boolean));

    // ── Interface & laju trafik ──
    const now = Date.now();
    const list = ifaces
      .filter((i) => i.name)
      .map((i) => {
        const name = i.name!;
        const rx = n(i['rx-byte']);
        const tx = n(i['tx-byte']);
        const prev = this.prev.get(name);
        let rxBps: number | null = null;
        let txBps: number | null = null;
        if (prev && rx != null && tx != null && now > prev.ts) {
          const dt = (now - prev.ts) / 1000;
          rxBps = rx >= prev.rx ? r1((rx - prev.rx) / dt) : null;
          txBps = tx >= prev.tx ? r1((tx - prev.tx) / dt) : null;
        }
        if (rx != null && tx != null) this.prev.set(name, { ts: now, rx, tx });
        return {
          name,
          type: i.type ?? '',
          comment: i.comment ?? '',
          running: yes(i.running),
          disabled: yes(i.disabled),
          rxBps,
          txBps,
          wan: wanNames.has(name),
        };
      });
    // Tanpa default route yang bisa dipetakan → anggap interface bernama wan/isp sebagai WAN
    if (!list.some((i) => i.wan)) for (const i of list) if (/wan|isp|internet|pppoe-out/i.test(`${i.name} ${i.comment}`)) i.wan = true;
    for (const i of list) if (i.wan && i.running) this.everRunning.add(i.name);
    const wans = list.filter((i) => i.wan);
    const shown = list
      .filter((i) => !i.disabled && (i.wan || /ether|sfp|pppoe|lte|wlan|wifi|vlan|bridge|bond|wg|l2tp|ovpn|sstp|gre|eoip/.test(i.type)))
      .sort((a, b) => Number(b.wan) - Number(a.wan) || (b.rxBps ?? 0) + (b.txBps ?? 0) - ((a.rxBps ?? 0) + (a.txBps ?? 0)))
      .slice(0, 30);
    const sumOf = (k: 'rxBps' | 'txBps') => (wans.some((w) => w[k] != null) ? r1(wans.reduce((a, w) => a + (w[k] ?? 0), 0)) : null);

    const nw = netwatch
      .filter((x) => !yes(x.disabled))
      .map((x) => ({ host: x.host ?? '', status: x.status ?? 'unknown', since: x.since ?? '', comment: x.comment ?? x.name ?? '' }));
    const nwDown = nw.filter((x) => x.status === 'down');
    const dhcpBound = leases ? leases.filter((l) => l.status === 'bound').length : null;

    // ── Alert ──
    const checks: Check[] = [];
    const cpuLv = level(cpuPct, 80, 90);
    checks.push({ rule: 'mt_cpu', raiseAfter: 3, hit: cpuLv && { severity: cpuLv, title: `CPU MikroTik ${Math.round(cpuPct!)}%`, message: `${res['cpu-count'] ?? '?'} core` } });
    const memLv = level(memPct, 85, 95);
    checks.push({ rule: 'mt_mem', raiseAfter: 3, hit: memLv && { severity: memLv, title: `Memory MikroTik ${Math.round(memPct!)}%`, message: '' } });
    const tLv = level(temp, 70, 80);
    checks.push({ rule: 'mt_temp', raiseAfter: 3, hit: tLv && { severity: tLv, title: `Suhu MikroTik ${temp}°C`, message: 'Periksa ventilasi perangkat' } });
    checks.push({
      rule: 'mt_netwatch',
      clearAfter: 1,
      hit: nwDown.length
        ? { severity: 'critical', title: `Netwatch down: ${nwDown.map((x) => x.comment || x.host).join(', ')}`, message: nwDown.map((x) => `${x.host} sejak ${x.since || '?'}`).join(' · ') }
        : null,
    });
    const wanDown = wans.filter((w) => !w.running && this.everRunning.has(w.name));
    checks.push({
      rule: 'mt_wan_down',
      raiseAfter: 2,
      clearAfter: 1,
      hit: wanDown.length ? { severity: 'critical', title: `Interface WAN putus: ${wanDown.map((w) => w.comment ? `${w.comment} (${w.name})` : w.name).join(', ')}`, message: 'Interface tidak running' } : null,
    });
    // Failover: route dengan distance terkecil tidak aktif, tapi route cadangan aktif
    const primary = rts[0];
    const activeRt = rts.find((r) => r.active);
    const failover = rts.length > 1 && primary && !primary.active && activeRt;
    checks.push({
      rule: 'mt_failover',
      raiseAfter: 2,
      clearAfter: 2,
      hit: failover
        ? { severity: 'warning', title: `Failover ke ${activeRt!.comment || activeRt!.gateway}`, message: `Jalur utama ${primary.comment || primary.gateway} (${primary.iface || '-'}) tidak aktif` }
        : null,
    });

    return {
      series: {
        cpu: cpuPct,
        mem: memPct,
        temp,
        rx: sumOf('rxBps'),
        tx: sumOf('txBps'),
        wanUp: wans.filter((w) => w.running).length,
      },
      data: {
        identity: id.name ?? null,
        board: res['board-name'] ?? null,
        version: res.version ?? null,
        arch: res['architecture-name'] ?? null,
        cpuCount: n(res['cpu-count']),
        uptime: parseUptime(res.uptime),
        memUsed,
        memTotal,
        hddPct: pct(hddTotal != null && hddFree != null ? hddTotal - hddFree : null, hddTotal),
        temp,
        voltage,
        routes: rts,
        interfaces: shown,
        netwatch: nw,
        dhcpBound,
      },
      checks,
    };
  }

  raw() {
    return this.lastRaw;
  }

  async close() {}
}
