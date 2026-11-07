import { HttpError, requestJson } from '../http.js';
import { ThreatCollector } from './fortiThreats.js';
import * as threatStore from './threatStore.js';
import { level, r1, type Check, type DeviceConfig, type DeviceSample, type DeviceSource } from './types.js';

interface FgResp<T> {
  results: T;
  version?: string;
  serial?: string;
  build?: number;
  status?: string;
}

interface FgIface {
  id?: string;
  name: string;
  alias?: string;
  ip?: string;
  mask?: number;
  link?: boolean;
  speed?: number;
  duplex?: number;
  rx_bytes?: number;
  tx_bytes?: number;
  rx_errors?: number;
  tx_errors?: number;
}

interface FgSlaMember {
  status?: string;
  latency?: number;
  jitter?: number;
  packet_loss?: number;
  sla_targets_met?: number[];
  state_changed?: number;
}

interface FgTunnel {
  name: string;
  rgwy?: string;
  incoming_bytes?: number;
  outgoing_bytes?: number;
  proxyid?: { status?: string; p2name?: string }[];
}

type Usage = Record<string, { current?: number }[] | undefined>;

const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/**
 * FortiGate lewat REST API (FortiOS 6.4 / 7.x).
 * Login: REST API Admin (System → Administrators → Create New → REST API Admin) dengan profil
 * hanya-baca. Token disimpan sebagai "password". IP komputer Dashboard harus ada di Trusted Hosts.
 *
 * Yang dibaca: status sistem, CPU/RAM/sesi, interface (trafik WAN), SD-WAN Performance SLA
 * (latency/jitter/loss per ISP), dan tunnel IPsec.
 */
export class FortiGateSource implements DeviceSource {
  readonly intervalMs = 10_000;
  private base: string;
  private lastRaw: unknown;
  private prev = new Map<string, { ts: number; rx: number; tx: number }>();
  private roles: { ts: number; map: Map<string, { role?: string; alias?: string; type?: string }> } | null = null;
  private everUp = new Set<string>();

  private threats: ThreatCollector;

  constructor(private cfg: DeviceConfig) {
    const scheme = cfg.options.https === false ? 'http' : 'https';
    this.base = `${scheme}://${cfg.host}:${cfg.port ?? 443}/api/v2`;
    // Log ancaman: kesalahan HTTP diteruskan apa adanya (kode status dipakai untuk mencari path log)
    this.threats = new ThreatCollector(cfg.id, (path) => {
      const vdom = cfg.options.vdom?.trim();
      const sep = path.includes('?') ? '&' : '?';
      return requestJson(`${this.base}${path}${vdom ? `${sep}vdom=${encodeURIComponent(vdom)}` : ''}`, {
        headers: { Authorization: `Bearer ${cfg.password ?? ''}` },
      });
    });
  }

  private async get<T>(path: string): Promise<FgResp<T>> {
    const vdom = this.cfg.options.vdom?.trim();
    const sep = path.includes('?') ? '&' : '?';
    const url = `${this.base}${path}${vdom ? `${sep}vdom=${encodeURIComponent(vdom)}` : ''}`;
    try {
      return await requestJson<FgResp<T>>(url, { headers: { Authorization: `Bearer ${this.cfg.password ?? ''}` } });
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) {
        throw new Error('Token ditolak (401). Periksa API key, dan pastikan IP komputer Dashboard ada di Trusted Hosts REST API Admin');
      }
      if (e instanceof HttpError && e.status === 403) {
        throw new Error('Akses ditolak (403). Beri profil admin hak baca (read) untuk System, Network & VPN');
      }
      throw e;
    }
  }

  async test() {
    const s = await this.get<{ model_name?: string; model_number?: string; hostname?: string }>('/monitor/system/status');
    const model = [s.results?.model_name, s.results?.model_number].filter(Boolean).join(' ') || 'FortiGate';
    const sd = await this.get<Record<string, unknown>>('/monitor/virtual-wan/health-check').catch(() => null);
    const sla = sd?.results ? Object.keys(sd.results).length : 0;
    return `${model} · ${s.version ?? ''} · ${s.results?.hostname ?? this.cfg.host}${sla ? ` · ${sla} Performance SLA` : ''}`;
  }

  /** Peran interface (wan/lan/dmz) dari konfigurasi; diperbarui tiap 10 menit */
  private async loadRoles() {
    if (this.roles && Date.now() - this.roles.ts < 600_000) return this.roles.map;
    const r = await this.get<{ name: string; role?: string; alias?: string; type?: string }[]>(
      '/cmdb/system/interface?format=name|role|alias|type',
    ).catch(() => null);
    const map = new Map((Array.isArray(r?.results) ? r.results : []).map((i) => [i.name, { role: i.role, alias: i.alias, type: i.type }]));
    this.roles = { ts: Date.now(), map };
    return map;
  }

  async sample(): Promise<DeviceSample> {
    const [status, usage, ifaces, sdwan, vpn, perf, roles] = await Promise.all([
      this.get<{ model_name?: string; model_number?: string; hostname?: string }>('/monitor/system/status'),
      this.get<Usage>('/monitor/system/resource/usage?interval=1-min'),
      this.get<Record<string, FgIface>>('/monitor/system/interface'),
      this.get<Record<string, Record<string, FgSlaMember>>>('/monitor/virtual-wan/health-check').catch(() => null),
      this.get<FgTunnel[]>('/monitor/vpn/ipsec').catch(() => null),
      this.get<Record<string, unknown>>('/monitor/system/performance/status').catch(() => null),
      this.loadRoles(),
    ]);
    this.lastRaw = { status, usage: trimUsage(usage.results), interfaces: ifaces.results, sdwan: sdwan?.results, vpn: vpn?.results, performance: perf?.results };

    const cur = (k: string) => num(usage.results?.[k]?.[0]?.current);
    const cpuPct = cur('cpu');
    const memPct = cur('mem');
    const sessions = cur('session');

    // ── SD-WAN Performance SLA: satu baris per (health-check, anggota) ──
    const sla: { sla: string; iface: string; status: string; latencyMs: number | null; jitterMs: number | null; lossPct: number | null; slaMet: boolean | null; since: number | null }[] = [];
    for (const [name, members] of Object.entries(sdwan?.results ?? {})) {
      if (!members || typeof members !== 'object') continue;
      for (const [iface, m] of Object.entries(members)) {
        if (!m || typeof m !== 'object') continue;
        const up = m.status === 'up';
        sla.push({
          sla: name,
          iface,
          status: m.status ?? 'unknown',
          latencyMs: up ? r1(num(m.latency)) : null,
          jitterMs: up ? r1(num(m.jitter)) : null,
          lossPct: up ? r1(num(m.packet_loss)) : null,
          slaMet: Array.isArray(m.sla_targets_met) ? m.sla_targets_met.length > 0 : null,
          since: num(m.state_changed) ? num(m.state_changed)! * 1000 : null,
        });
      }
    }
    const members = new Set(sla.map((s) => s.iface));

    // ── Interface & laju trafik (selisih counter) ──
    const now = Date.now();
    const list = Object.values(ifaces.results ?? {}).map((i) => {
      const prev = this.prev.get(i.name);
      const rx = num(i.rx_bytes);
      const tx = num(i.tx_bytes);
      let rxBps: number | null = null;
      let txBps: number | null = null;
      if (prev && rx != null && tx != null && now > prev.ts) {
        const dt = (now - prev.ts) / 1000;
        rxBps = rx >= prev.rx ? r1((rx - prev.rx) / dt) : null; // counter reset → lewati
        txBps = tx >= prev.tx ? r1((tx - prev.tx) / dt) : null;
      }
      if (rx != null && tx != null) this.prev.set(i.name, { ts: now, rx, tx });
      const role = roles.get(i.name);
      return {
        name: i.name,
        alias: i.alias || role?.alias || '',
        ip: i.ip && i.ip !== '0.0.0.0' ? `${i.ip}${i.mask != null ? `/${i.mask}` : ''}` : '',
        link: i.link !== false,
        speed: num(i.speed),
        rxBps,
        txBps,
        wan: members.has(i.name) || role?.role === 'wan',
        role: role?.role ?? '',
      };
    });
    // Tidak ada SD-WAN & role → tebak dari nama (wan1, wan2)
    if (!list.some((i) => i.wan)) for (const i of list) if (/^wan\d*$/i.test(i.name)) i.wan = true;
    const wans = list.filter((i) => i.wan).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const others = list
      .filter((i) => !i.wan && i.link && ((i.rxBps ?? 0) > 0 || (i.txBps ?? 0) > 0 || i.ip))
      .sort((a, b) => (b.rxBps ?? 0) + (b.txBps ?? 0) - ((a.rxBps ?? 0) + (a.txBps ?? 0)))
      .slice(0, 20);
    const sumOf = (k: 'rxBps' | 'txBps') => (wans.some((w) => w[k] != null) ? r1(wans.reduce((a, w) => a + (w[k] ?? 0), 0)) : null);

    // ── Tunnel IPsec ──
    const tunnels = (Array.isArray(vpn?.results) ? vpn.results : []).map((t) => {
      const p2 = t.proxyid ?? [];
      const up = p2.filter((p) => p.status === 'up').length;
      return { name: t.name, remote: t.rgwy ?? '', up, total: p2.length, rxBytes: num(t.incoming_bytes), txBytes: num(t.outgoing_bytes) };
    });
    for (const t of tunnels) if (t.up) this.everUp.add(`vpn:${t.name}`);
    for (const w of wans) if (w.link) this.everUp.add(`if:${w.name}`);

    // Latency per anggota SD-WAN (rata-rata dari semua health-check yang "up") → seri grafik
    const latSeries: Record<string, number | null> = {};
    for (const iface of members) {
      const xs = sla.filter((s) => s.iface === iface && s.latencyMs != null).map((s) => s.latencyMs!);
      latSeries[`lat.${iface}`] = xs.length ? r1(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
    }

    const uptime = findUptime(perf?.results);

    // ── Alert ──
    const checks: Check[] = [];
    const cpuLv = level(cpuPct, 80, 90);
    checks.push({ rule: 'fg_cpu', raiseAfter: 3, hit: cpuLv && { severity: cpuLv, title: `CPU FortiGate ${Math.round(cpuPct!)}%`, message: 'Rata-rata semua core' } });
    const memLv = level(memPct, 80, 90);
    checks.push({ rule: 'fg_mem', raiseAfter: 3, hit: memLv && { severity: memLv, title: `Memory FortiGate ${Math.round(memPct!)}%`, message: 'Di atas 90% FortiGate masuk conserve mode' } });

    const downMembers = [...members].filter((iface) => sla.filter((s) => s.iface === iface).every((s) => s.status !== 'up'));
    const downWans = sla.length ? downMembers : wans.filter((w) => !w.link && this.everUp.has(`if:${w.name}`)).map((w) => w.name);
    const label = (n: string) => {
      const a = list.find((i) => i.name === n)?.alias;
      return a ? `${a} (${n})` : n;
    };
    checks.push({
      rule: 'fg_wan_down',
      raiseAfter: 2,
      clearAfter: 1,
      hit: downWans.length ? { severity: 'critical', title: `Link WAN putus: ${downWans.map(label).join(', ')}`, message: sla.length ? 'Performance SLA SD-WAN: anggota mati' : 'Link interface terputus' } : null,
    });
    const missed = sla.filter((s) => s.status === 'up' && s.slaMet === false);
    checks.push({
      rule: 'fg_sla',
      raiseAfter: 3,
      hit: missed.length
        ? { severity: 'warning', title: `SLA tidak terpenuhi: ${[...new Set(missed.map((s) => label(s.iface)))].join(', ')}`, message: missed.map((s) => `${s.sla}/${s.iface} ${s.latencyMs ?? '—'} ms, loss ${s.lossPct ?? '—'}%`).join(' · ') }
        : null,
    });
    const vpnDown = tunnels.filter((t) => !t.up && this.everUp.has(`vpn:${t.name}`));
    checks.push({
      rule: 'fg_vpn',
      raiseAfter: 3,
      hit: vpnDown.length ? { severity: 'warning', title: `${vpnDown.length} tunnel VPN putus`, message: vpnDown.map((t) => t.name).join(', ') } : null,
    });

    // ── Peta serangan (log IPS / DoS / antivirus) ──
    const threatsOn = this.cfg.options.threats !== false;
    let threatData: Record<string, unknown> | null = null;
    if (threatsOn) {
      await this.threats.tick().catch(() => {});
      const now = Date.now();
      const st = this.threats.status;
      threatData = {
        ...st,
        site: { lat: this.cfg.options.siteLat ?? -6.2, lon: this.cfg.options.siteLon ?? 106.82, label: this.cfg.options.siteLabel || 'Kantor' },
        ...threatStore.summary(this.cfg.id, now - 86400_000),
      };
      if (st.ok) {
        const unblocked = threatStore.recentRows(this.cfg.id, now - 15 * 60_000, "dir = 'in' AND blocked = 0 AND severity IN ('critical','high')");
        checks.push({
          rule: 'fg_threat_unblocked',
          clearAfter: 1,
          hit: unblocked.length
            ? { severity: 'critical', title: `Serangan berbahaya TIDAK diblokir (${unblocked.reduce((a, r) => a + r.n, 0)}×)`, message: unblocked.map((r) => `${r.name} dari ${r.remoteIp}${r.country ? ` (${r.country})` : ''} → ${r.localIp}`).join(' · ') }
            : null,
        });
        const infected = threatStore.recentRows(this.cfg.id, now - 30 * 60_000, "dir = 'out' AND severity IN ('critical','high')");
        checks.push({
          rule: 'fg_infected',
          clearAfter: 1,
          hit: infected.length
            ? { severity: 'critical', title: `Perangkat kantor terindikasi malware/botnet: ${[...new Set(infected.map((r) => r.localIp))].slice(0, 3).join(', ')}`, message: infected.map((r) => `${r.localIp} → ${r.remoteIp} (${r.name})`).join(' · ') }
            : null,
        });
        const burst = threatStore.recentCount(this.cfg.id, now - 10 * 60_000, "dir = 'in'");
        const limit = this.cfg.options.threatSpike ?? 300;
        checks.push({
          rule: 'fg_threat_spike',
          raiseAfter: 1,
          clearAfter: 3,
          hit: burst >= limit ? { severity: 'warning', title: `Lonjakan serangan: ${burst} dalam 10 menit`, message: 'Lihat Peta Serangan untuk asal & jenisnya' } : null,
        });
      }
    }

    return {
      series: {
        cpu: cpuPct,
        mem: memPct,
        sessions,
        ...(threatsOn ? { threats: this.threats.status.perMinute } : {}),
        rx: sumOf('rxBps'),
        tx: sumOf('txBps'),
        wanUp: sla.length ? members.size - downMembers.length : wans.filter((w) => w.link).length,
        ...latSeries,
      },
      data: {
        hostname: status.results?.hostname ?? null,
        model: [status.results?.model_name, status.results?.model_number].filter(Boolean).join(' ') || null,
        version: status.version ?? null,
        serial: status.serial ?? null,
        uptime,
        sessions,
        wans,
        interfaces: others,
        sla,
        tunnels,
        threats: threatData,
      },
      checks,
    };
  }

  raw() {
    return this.lastRaw;
  }

  async close() {}
}

/** Riwayat (historical) dibuang dari data mentah agar dialog "data mentah" tetap ringkas */
function trimUsage(u: Usage | undefined) {
  if (!u) return u;
  return Object.fromEntries(Object.entries(u).map(([k, v]) => [k, v?.map((x) => ({ current: x.current }))]));
}

/** Uptime (detik) bila FortiOS menyediakannya di performance/status */
function findUptime(r: Record<string, unknown> | undefined): number | null {
  if (!r) return null;
  const u = r.uptime ?? (r.system as Record<string, unknown> | undefined)?.uptime;
  return typeof u === 'number' && u > 0 ? u : null;
}
