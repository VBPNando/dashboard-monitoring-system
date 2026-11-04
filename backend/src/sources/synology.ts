import { requestJson } from '../http.js';
import { level, pct, r1, type Check, type DeviceConfig, type DeviceSample, type DeviceSource } from './types.js';

interface SynoResp<T> {
  success: boolean;
  data?: T;
  error?: { code: number; errors?: unknown };
}

const LOGIN_ERRORS: Record<number, string> = {
  400: 'Username atau password salah',
  401: 'Akun dinonaktifkan',
  402: 'Akun tidak punya izin (gunakan akun grup administrators)',
  403: 'Akun memakai verifikasi 2 langkah (2FA). Buat akun khusus monitoring tanpa 2FA',
  404: 'Kode 2FA salah',
  406: 'Akun wajib memakai 2FA. Buat akun khusus monitoring tanpa 2FA',
  407: 'IP komputer Dashboard Monitoring System diblokir DSM (terlalu banyak gagal login). Buka blokir di DSM → Keamanan → Proteksi',
  408: 'Password kedaluwarsa, ganti password akun di DSM',
  409: 'Password kedaluwarsa, ganti password akun di DSM',
  410: 'Password wajib diganti, login sekali ke DSM dengan akun ini',
};
const SESSION_ERRORS = new Set([105, 106, 107, 119]);
const LOGIN_BACKOFF_MS = 5 * 60_000;

/**
 * Sesi DSM Web API (dipakai bersama panel NAS & Active Backup).
 * - Lokasi & versi tiap API diambil dari SYNO.API.Info (tidak di-hardcode).
 * - Sesi kedaluwarsa → login ulang otomatis.
 * - Login gagal (password salah dsb.) → jeda 5 menit, agar IP tidak diblokir Auto Block DSM.
 */
export class SynologySession {
  private base: string;
  private sid: string | null = null;
  private info: Record<string, { path: string; minVersion: number; maxVersion: number }> | null = null;
  private loginBlockedUntil = 0;
  private loginError = '';
  private loginP: Promise<void> | null = null;

  constructor(private cfg: DeviceConfig) {
    const https = cfg.options.https !== false;
    this.base = `${https ? 'https' : 'http'}://${cfg.host}:${cfg.port ?? (https ? 5001 : 5000)}/webapi`;
  }

  private async apiInfo() {
    if (!this.info) {
      const r = await requestJson<SynoResp<typeof this.info>>(
        `${this.base}/query.cgi?api=SYNO.API.Info&version=1&method=query&query=all`,
      );
      if (!r.success || !r.data) throw new Error('Tidak bisa membaca daftar API DSM (cek alamat & port NAS)');
      this.info = r.data;
    }
    return this.info!;
  }

  /** true bila paket/API tersedia di NAS (mis. Active Backup terpasang) */
  async has(api: string) {
    return !!(await this.apiInfo())[api];
  }

  private async login() {
    if (Date.now() < this.loginBlockedUntil) {
      const mins = Math.ceil((this.loginBlockedUntil - Date.now()) / 60_000);
      throw new Error(`${this.loginError} (dicoba lagi dalam ${mins} menit)`);
    }
    const info = await this.apiInfo();
    const auth = info['SYNO.API.Auth'];
    if (!auth) throw new Error('API login DSM tidak ditemukan');
    const r = await requestJson<SynoResp<{ sid: string }>>(`${this.base}/${auth.path}`, {
      form: {
        api: 'SYNO.API.Auth',
        version: String(Math.min(6, auth.maxVersion)),
        method: 'login',
        account: this.cfg.username ?? '',
        passwd: this.cfg.password ?? '',
        session: 'DBMonitor',
        format: 'sid',
      },
    });
    if (!r.success || !r.data?.sid) {
      const code = r.error?.code ?? 0;
      this.loginError = LOGIN_ERRORS[code] ?? `Login DSM gagal (kode ${code})`;
      this.loginBlockedUntil = Date.now() + LOGIN_BACKOFF_MS;
      throw new Error(this.loginError);
    }
    this.sid = r.data.sid;
  }

  /** Panggil API DSM; versi = min(versi yang diinginkan, versi maksimum di NAS). */
  async call<T>(api: string, method: string, version: number, params: Record<string, string> = {}, retried = false): Promise<T> {
    const info = await this.apiInfo();
    const meta = info[api];
    if (!meta) throw new Error(`API ${api} tidak tersedia di NAS ini`);
    if (!this.sid) {
      // Beberapa panggilan paralel (NAS + Active Backup) cukup memicu satu login
      this.loginP ??= this.login().finally(() => (this.loginP = null));
      await this.loginP;
    }
    const v = Math.max(meta.minVersion, Math.min(version, meta.maxVersion));
    const r = await requestJson<SynoResp<T>>(`${this.base}/${meta.path}`, {
      form: { api, method, version: String(v), _sid: this.sid!, ...params },
    });
    if (r.success) return r.data as T;
    const code = r.error?.code ?? 0;
    if (SESSION_ERRORS.has(code) && !retried) {
      this.sid = null;
      return this.call(api, method, version, params, true);
    }
    if (code === 105) throw new Error(`Akun tidak punya izin untuk ${api} (gunakan akun grup administrators)`);
    throw new Error(`${api} gagal (kode ${code})`);
  }

  async logout() {
    if (!this.sid) return;
    const auth = this.info?.['SYNO.API.Auth'];
    if (auth)
      await requestJson(`${this.base}/${auth.path}`, {
        form: { api: 'SYNO.API.Auth', version: '6', method: 'logout', session: 'DBMonitor', _sid: this.sid },
        timeoutMs: 3000,
      }).catch(() => {});
    this.sid = null;
  }
}

/** Sesi dibagi per NAS (host:port:user) agar panel NAS & Active Backup tidak login dua kali. */
const sessions = new Map<string, { s: SynologySession; refs: number }>();
export function acquireSession(cfg: DeviceConfig) {
  const key = `${cfg.host}:${cfg.port ?? ''}:${cfg.options.https !== false}:${cfg.username}:${cfg.password}`;
  let e = sessions.get(key);
  if (!e) {
    e = { s: new SynologySession(cfg), refs: 0 };
    sessions.set(key, e);
  }
  e.refs++;
  const entry = e;
  return {
    session: entry.s,
    release: async () => {
      if (--entry.refs <= 0) {
        sessions.delete(key);
        await entry.s.logout();
      }
    },
  };
}

const num = (v: unknown) => (v == null || v === '' ? null : Number(v));

interface Utilization {
  cpu?: { user_load?: number; system_load?: number; other_load?: number };
  memory?: { real_usage?: number; total_real?: number; avail_real?: number; memory_size?: number };
  network?: { device: string; rx: number; tx: number }[];
  disk?: { total?: { read_byte?: number; write_byte?: number; utilization?: number } };
}
interface StorageInfo {
  volumes?: { id: string; vol_path?: string; display_name?: string; desc?: string; status?: string; fs_type?: string; size?: { total?: string; used?: string } }[];
  disks?: { id: string; name?: string; longName?: string; model?: string; temp?: number; status?: string; smart_status?: string; size_total?: string }[];
  storagePools?: { id: string; status?: string; raidType?: string; device_type?: string }[];
}
interface DsmInfo {
  model?: string;
  version_string?: string;
  uptime?: number;
  temperature?: number;
  temperature_warn?: boolean;
  ram?: number;
}

const OK_STATUS = new Set(['normal', 'background', 'initialized', '']);

/**
 * NAS Synology lewat DSM Web API.
 * Akun: anggota grup administrators (dibutuhkan untuk data storage & utilisasi), tanpa 2FA.
 * Disarankan akun khusus, mis. "monitor", dengan izin aplikasi lain dinonaktifkan.
 */
export class SynologySource implements DeviceSource {
  readonly intervalMs = 5000;
  private lease: ReturnType<typeof acquireSession>;
  private lastRaw: unknown;

  constructor(private cfg: DeviceConfig) {
    this.lease = acquireSession(cfg);
  }

  async test() {
    const s = this.lease.session;
    const info = await s.call<DsmInfo>('SYNO.DSM.Info', 'getinfo', 2);
    await s.call<Utilization>('SYNO.Core.System.Utilization', 'get', 1);
    await s.call<StorageInfo>('SYNO.Storage.CGI.Storage', 'load_info', 1);
    return `${info.model ?? 'Synology'} · ${info.version_string ?? 'DSM'}`;
  }

  async sample(): Promise<DeviceSample> {
    const s = this.lease.session;
    const [util, storage, info] = await Promise.all([
      s.call<Utilization>('SYNO.Core.System.Utilization', 'get', 1),
      s.call<StorageInfo>('SYNO.Storage.CGI.Storage', 'load_info', 1),
      s.call<DsmInfo>('SYNO.DSM.Info', 'getinfo', 2).catch(() => ({}) as DsmInfo),
    ]);
    this.lastRaw = { util, storage, info };

    const cpu = util.cpu ? r1((util.cpu.user_load ?? 0) + (util.cpu.system_load ?? 0) + (util.cpu.other_load ?? 0)) : null;
    const mem = num(util.memory?.real_usage);
    const memTotal = util.memory?.total_real != null ? util.memory.total_real * 1024 : null;
    const memUsed = memTotal != null && util.memory?.avail_real != null ? memTotal - util.memory.avail_real * 1024 : null;
    const netTotal = util.network?.find((n) => n.device === 'total');

    const volumes = (storage.volumes ?? []).map((v) => {
      const total = num(v.size?.total);
      const used = num(v.size?.used);
      return {
        id: v.id,
        name: v.display_name || v.vol_path?.replace('/', '') || v.id,
        status: (v.status ?? '').toLowerCase(),
        fs: v.fs_type ?? '',
        total,
        used,
        pct: pct(used, total),
      };
    });
    const disks = (storage.disks ?? []).map((d) => ({
      id: d.id,
      name: d.longName || d.name || d.id,
      model: (d.model ?? '').trim(),
      temp: num(d.temp),
      status: (d.status ?? '').toLowerCase(),
      smart: (d.smart_status ?? '').toLowerCase(),
      size: num(d.size_total),
    }));
    const pools = (storage.storagePools ?? []).map((p) => ({ id: p.id, status: (p.status ?? '').toLowerCase(), raid: p.raidType ?? p.device_type ?? '' }));

    const worstVol = [...volumes].sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))[0];
    const maxTemp = disks.reduce<number | null>((m, d) => (d.temp != null && d.temp > 0 ? Math.max(m ?? 0, d.temp) : m), null);

    const checks: Check[] = [];
    const cpuLv = level(cpu, 80, 90);
    checks.push({ rule: 'nas_cpu', raiseAfter: 6, hit: cpuLv && { severity: cpuLv, title: `CPU NAS tinggi (${Math.round(cpu!)}%)`, message: info.model ?? '' } });
    const memLv = level(mem, 85, 95);
    checks.push({ rule: 'nas_mem', raiseAfter: 6, hit: memLv && { severity: memLv, title: `RAM NAS tinggi (${Math.round(mem!)}%)`, message: info.model ?? '' } });
    const volLv = level(worstVol?.pct, 85, 95);
    checks.push({ rule: 'nas_volume_full', raiseAfter: 2, hit: volLv && { severity: volLv, title: `${worstVol!.name} terisi ${Math.round(worstVol!.pct!)}%`, message: 'Kapasitas volume' } });
    const badVol = [...volumes.filter((v) => !OK_STATUS.has(v.status)), ...pools.filter((p) => !OK_STATUS.has(p.status))];
    checks.push({
      rule: 'nas_volume_status',
      raiseAfter: 1,
      hit: badVol.length
        ? {
            severity: badVol.some((v) => /crash|degrad|fail/.test(v.status)) ? 'critical' : 'warning',
            title: `Volume/pool bermasalah: ${badVol.map((v) => ('name' in v ? v.name : v.id)).join(', ')}`,
            message: `Status: ${[...new Set(badVol.map((v) => v.status))].join(', ')}`,
          }
        : null,
    });
    const badDisk = disks.filter((d) => !OK_STATUS.has(d.status) || (d.smart && !OK_STATUS.has(d.smart)));
    checks.push({
      rule: 'nas_disk_health',
      raiseAfter: 1,
      hit: badDisk.length
        ? {
            severity: badDisk.some((d) => /crash|fail|abnormal|not_?use/.test(d.status + d.smart)) ? 'critical' : 'warning',
            title: `${badDisk.length} disk bermasalah`,
            message: badDisk.map((d) => `${d.name}: ${d.status || '-'}/${d.smart || '-'}`).join(', '),
          }
        : null,
    });
    const tLv = level(maxTemp, 55, 60);
    checks.push({ rule: 'nas_disk_temp', raiseAfter: 6, hit: tLv && { severity: tLv, title: `Suhu disk ${maxTemp}°C`, message: 'Periksa pendinginan NAS' } });
    checks.push({
      rule: 'nas_sys_temp',
      raiseAfter: 3,
      hit: info.temperature_warn ? { severity: 'warning', title: `Suhu sistem tinggi (${info.temperature}°C)`, message: info.model ?? '' } : null,
    });

    return {
      series: {
        cpu,
        mem,
        netRx: netTotal ? r1(netTotal.rx) : null,
        netTx: netTotal ? r1(netTotal.tx) : null,
        volume: worstVol?.pct ?? null,
        diskTemp: maxTemp,
        diskRead: num(util.disk?.total?.read_byte),
        diskWrite: num(util.disk?.total?.write_byte),
      },
      data: {
        model: info.model ?? null,
        version: info.version_string ?? null,
        uptime: info.uptime ?? null,
        sysTemp: info.temperature ?? null,
        memUsed,
        memTotal,
        volumes,
        disks,
        pools,
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
