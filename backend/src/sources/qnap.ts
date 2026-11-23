import { HttpError, requestText } from '../http.js';
import { level, pct, r1, type Check, type DeviceConfig, type DeviceSample, type DeviceSource } from './types.js';

/**
 * QNAP NAS (QTS / QuTS hero) lewat antarmuka CGI resmi yang dipakai web QTS sendiri
 * (sama dengan library python-qnapstats / integrasi Home Assistant):
 *   authLogin.cgi                                   → login, dapat sid
 *   management/manaRequest.cgi?subfunc=sysinfo      → CPU, RAM, suhu, uptime, NIC, kipas
 *   management/manaRequest.cgi?…&sysHealth=1        → kesehatan sistem
 *   management/chartReq.cgi?chart_func=disk_usage   → volume
 *   disk/qsmart.cgi?func=all_hd_data                → disk & S.M.A.R.T.
 *   management/chartReq.cgi?chart_func=QSM40bandwidth → trafik jaringan
 * Semua respons berupa XML. Akun cukup anggota grup administrators, TANPA verifikasi 2 langkah.
 */

// ── Pembaca XML kecil (respons QNAP sederhana & datar) ──
const unwrap = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .trim();

/** Isi elemen pertama <name>…</name> (CDATA dibuka), atau null */
export function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? unwrap(m[1]) : null;
}
/** Isi mentah semua elemen <name>…</name> */
export function blocks(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'g'))].map((m) => m[1]);
}
const num = (s: string | null | undefined) => {
  if (s == null) return null;
  const v = parseFloat(s.replace(/[^\d.+-]/g, ''));
  return Number.isFinite(v) ? v : null;
};

/** "894.25 GB" / "10.91 TB" → byte */
function sizeOf(s: string | null): number | null {
  if (!s) return null;
  const m = s.match(/([\d.]+)\s*([KMGTP]?)B/i);
  if (!m) return num(s);
  const mult: Record<string, number> = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 };
  return Math.round(parseFloat(m[1]) * mult[m[2].toUpperCase()]);
}

/** Suhu masuk akal saja (sensor rusak bisa melapor 32763 atau -1) */
const temp = (v: number | null) => (v != null && v > 0 && v < 120 ? v : null);

const LOGIN_BACKOFF_MS = 5 * 60_000;

export class QnapSource implements DeviceSource {
  readonly intervalMs = 5_000;
  private base: string;
  private sid: string | null = null;
  private loginP: Promise<string> | null = null;
  private loginBlockedUntil = 0;
  private loginError = '';
  private lastRaw: unknown;
  private slow: { ts: number; volumes: string; smart: string; health: string } | null = null;

  constructor(private cfg: DeviceConfig) {
    const https = cfg.options.https === true;
    this.base = `${https ? 'https' : 'http'}://${cfg.host}:${cfg.port ?? (https ? 443 : 8080)}/cgi-bin/`;
  }

  /** Login; gagal → tunggu 5 menit agar IP komputer Dashboard tidak diblokir "Network Access Protection" QNAP */
  private login(): Promise<string> {
    if (Date.now() < this.loginBlockedUntil) {
      return Promise.reject(new Error(`${this.loginError} (login dicoba lagi ${Math.ceil((this.loginBlockedUntil - Date.now()) / 60000)} menit lagi agar IP tidak diblokir QNAP)`));
    }
    this.loginP ??= (async () => {
      try {
        const xml = await requestText(`${this.base}authLogin.cgi`, {
          form: { user: this.cfg.username ?? '', pwd: Buffer.from(this.cfg.password ?? '', 'utf8').toString('base64'), serviceKey: '1' },
        });
        const sid = tag(xml, 'authSid');
        if (tag(xml, 'authPassed') === '1' && sid) return sid;
        const twoStep = /need_2sv|2sv|emergency/i.test(xml) || tag(xml, 'need_2sv') === '1';
        throw new Error(
          twoStep
            ? 'Akun memakai verifikasi 2 langkah (2-step verification). Buat akun khusus monitoring tanpa 2SV.'
            : 'Login QNAP ditolak: periksa username & password (akun harus anggota grup administrators)',
        );
      } catch (e) {
        this.loginError = (e as Error).message;
        if (!(e instanceof HttpError) || e.status) this.loginBlockedUntil = Date.now() + LOGIN_BACKOFF_MS;
        throw e;
      } finally {
        this.loginP = null;
      }
    })();
    return this.loginP.then((sid) => (this.sid = sid));
  }

  /** GET CGI dengan sid; sesi kedaluwarsa (authPassed=0) → login ulang sekali */
  private async get(path: string, retry = true): Promise<string> {
    const sid = this.sid ?? (await this.login());
    const xml = await requestText(`${this.base}${path}${path.includes('?') ? '&' : '?'}sid=${encodeURIComponent(sid)}`);
    if (tag(xml, 'authPassed') === '0') {
      this.sid = null;
      if (retry) return this.get(path, false);
      throw new Error('Sesi QNAP ditolak');
    }
    return xml;
  }

  async test() {
    this.loginBlockedUntil = 0; // tombol Tes selalu mencoba login
    this.sid = null;
    const xml = await this.get('management/manaRequest.cgi?subfunc=sysinfo&hd=no&multicpu=1');
    const model = tag(xml, 'displayModelName') || tag(xml, 'modelName') || 'QNAP';
    const ver = tag(blocks(xml, 'firmware')[0] ?? '', 'version');
    return `QNAP ${model}${ver ? ` · QTS ${ver}` : ''} · ${tag(xml, 'server_name') ?? this.cfg.host}`;
  }

  async sample(): Promise<DeviceSample> {
    const sys = await this.get('management/manaRequest.cgi?subfunc=sysinfo&hd=no&multicpu=1');
    // Volume, S.M.A.R.T. & kesehatan berubah lambat → diambil tiap 60 detik
    if (!this.slow || Date.now() - this.slow.ts > 60_000) {
      const [volumes, smart, health] = await Promise.all([
        this.get('management/chartReq.cgi?chart_func=disk_usage&disk_select=all&include=all').catch(() => ''),
        this.get('disk/qsmart.cgi?func=all_hd_data').catch(() => ''),
        this.get('management/manaRequest.cgi?subfunc=sysinfo&sysHealth=1').catch(() => ''),
      ]);
      this.slow = { ts: Date.now(), volumes, smart, health };
    }
    let bw = await this.get('management/chartReq.cgi?chart_func=QSM40bandwidth').catch(() => '');
    if (!bw.includes('bandwidth_info')) bw = await this.get('management/chartReq.cgi?chart_func=bandwidth').catch(() => '');
    this.lastRaw = { sysinfo: sys, volumes: this.slow.volumes, smart: this.slow.smart, health: this.slow.health, bandwidth: bw };

    const root = blocks(sys, 'root')[0] ?? sys;
    const model = tag(sys, 'displayModelName') || tag(sys, 'modelName');
    const fw = blocks(sys, 'firmware')[0] ?? '';
    const version = [tag(fw, 'version'), tag(fw, 'build')].filter(Boolean).join(' build ') || null;

    const cpu = num(tag(root, 'cpu_usage'));
    const memTotal = num(tag(root, 'total_memory')); // MB
    const memFree = num(tag(root, 'free_memory'));
    const mem = memTotal && memFree != null ? r1(((memTotal - memFree) / memTotal) * 100) : null;
    const sysTemp = temp(num(tag(root, 'sys_tempc')));
    const cpuTemp = temp(num(tag(root, 'cpu_tempc')));
    const uptime = ['uptime_day', 'uptime_hour', 'uptime_min', 'uptime_sec'].map((k) => num(tag(root, k)) ?? 0);
    const uptimeSec = uptime[0] * 86400 + uptime[1] * 3600 + uptime[2] * 60 + uptime[3];

    // Kipas: sysfanN (RPM) & sysfanN_stat (-1 = alarm)
    const fanCount = num(tag(root, 'sysfan_count')) ?? 0;
    const fans = Array.from({ length: fanCount }, (_, i) => ({ rpm: num(tag(root, `sysfan${i + 1}`)), alarm: tag(root, `sysfan${i + 1}_stat`) === '-1' }));

    // Volume (QTS 4.x: ukuran ada di volumeUseList; sebagian model QTS baru tidak melaporkannya)
    const use = new Map(
      blocks(this.slow.volumes, 'volumeUse').map((u) => [tag(u, 'volumeValue') ?? '', { total: num(tag(u, 'total_size')), free: num(tag(u, 'free_size')) }]),
    );
    const volumes = blocks(this.slow.volumes, 'volume').map((v) => {
      const id = tag(v, 'volumeValue') ?? '';
      const u = use.get(id);
      const total = u?.total ?? null;
      const used = u?.total != null && u.free != null ? u.total - u.free : null;
      const code = tag(v, 'volumeStatus');
      const progress = num(tag(v, 'Progress'));
      return {
        id,
        name: tag(v, 'volumeLabel') || `Volume ${id}`,
        // 0 = siap; sinkronisasi RAID berjalan dianggap normal (latar belakang)
        status: code === '0' || code == null ? (progress != null && progress < 100 ? 'background' : 'normal') : `status ${code}`,
        fs: (tag(v, 'volumeStat') ?? '').toUpperCase(),
        total,
        used,
        pct: pct(used, total),
      };
    });

    // Disk & S.M.A.R.T.
    const disks = blocks(this.slow.smart, 'entry')
      .filter((e) => (tag(e, 'Model') ?? '').trim())
      .map((e) => {
        const health = (tag(e, 'Health') ?? '').toLowerCase();
        const t = blocks(e, 'Temperature')[0] ?? '';
        return {
          id: tag(e, 'HDNo') ?? '',
          name: tag(e, 'Disk_Alias') || `Disk ${tag(e, 'HDNo')}`,
          model: (tag(e, 'Model') ?? '').trim(),
          temp: temp(num(tag(t, 'oC'))),
          status: tag(e, 'Disk_Status') === '0' || tag(e, 'Disk_Status') == null ? 'normal' : `status ${tag(e, 'Disk_Status')}`,
          smart: health === 'ok' || health === 'good' || health === '' ? 'normal' : health,
          size: sizeOf(tag(e, 'Capacity')),
        };
      });

    // Trafik: QTS melaporkan jumlah per 5 detik → dibagi 5 = byte/detik
    const items = blocks(bw, 'item').map((it) => ({ rx: (num(tag(it, 'rx')) ?? 0) / 5, tx: (num(tag(it, 'tx')) ?? 0) / 5 }));
    const legacyIds = [...(tag(bw, 'eth_index_list') ?? '').split(','), ...(tag(bw, 'wlan_index_list') ?? '').split(',')].filter(Boolean);
    if (!items.length && legacyIds.length) {
      for (const id of tag(bw, 'eth_index_list')?.split(',').filter(Boolean).map((n) => `eth${n}`) ?? []) {
        const b = blocks(bw, id)[0] ?? '';
        items.push({ rx: (num(tag(b, 'rx')) ?? 0) / 5, tx: (num(tag(b, 'tx')) ?? 0) / 5 });
      }
    }
    const netRx = items.length ? r1(items.reduce((a, i) => a + i.rx, 0)) : null;
    const netTx = items.length ? r1(items.reduce((a, i) => a + i.tx, 0)) : null;

    const sysHealth = (tag(this.slow.health, 'status') ?? '').toLowerCase();
    const worstVol = [...volumes].sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))[0];
    const maxTemp = disks.reduce<number | null>((m, d) => (d.temp != null ? Math.max(m ?? 0, d.temp) : m), null);
    const warnT = num(tag(root, 'HDTempWarnT')) ?? 55;
    const errT = num(tag(root, 'HDTempErrT')) ?? 60;
    const sysWarnT = num(tag(root, 'SysTempWarnT')) ?? 57;

    // ── Alert (aturan sama dengan Synology agar konsisten) ──
    const checks: Check[] = [];
    const cpuLv = level(cpu, 80, 90);
    checks.push({ rule: 'nas_cpu', raiseAfter: 6, hit: cpuLv && { severity: cpuLv, title: `CPU NAS tinggi (${Math.round(cpu!)}%)`, message: model ?? '' } });
    const memLv = level(mem, 85, 95);
    checks.push({ rule: 'nas_mem', raiseAfter: 6, hit: memLv && { severity: memLv, title: `RAM NAS tinggi (${Math.round(mem!)}%)`, message: model ?? '' } });
    const volLv = level(worstVol?.pct, 85, 95);
    checks.push({ rule: 'nas_volume_full', raiseAfter: 2, hit: volLv && { severity: volLv, title: `${worstVol!.name} terisi ${Math.round(worstVol!.pct!)}%`, message: 'Kapasitas volume' } });
    const badVol = volumes.filter((v) => v.status !== 'normal' && v.status !== 'background');
    checks.push({
      rule: 'nas_volume_status',
      hit: badVol.length ? { severity: 'warning', title: `Volume bermasalah: ${badVol.map((v) => v.name).join(', ')}`, message: badVol.map((v) => `${v.name}: ${v.status}`).join(', ') } : null,
    });
    const badDisk = disks.filter((d) => d.status !== 'normal' || d.smart !== 'normal');
    checks.push({
      rule: 'nas_disk_health',
      hit: badDisk.length
        ? {
            severity: badDisk.some((d) => /abnormal|error|fail|bad/.test(d.smart + d.status)) ? 'critical' : 'warning',
            title: `${badDisk.length} disk bermasalah`,
            message: badDisk.map((d) => `${d.name}: ${d.smart}`).join(', '),
          }
        : null,
    });
    const tLv = level(maxTemp, warnT, errT);
    checks.push({ rule: 'nas_disk_temp', raiseAfter: 6, hit: tLv && { severity: tLv, title: `Suhu disk ${maxTemp}°C`, message: 'Periksa pendinginan NAS' } });
    const hotSys = sysTemp != null && sysTemp >= sysWarnT;
    checks.push({ rule: 'nas_sys_temp', raiseAfter: 3, hit: hotSys ? { severity: 'warning', title: `Suhu sistem tinggi (${sysTemp}°C)`, message: model ?? '' } : null });
    checks.push({
      rule: 'qnap_health',
      raiseAfter: 2,
      hit: sysHealth && sysHealth !== 'good' ? { severity: 'warning', title: `Kesehatan sistem QNAP: ${sysHealth}`, message: 'Lihat Notification Center di QTS' } : null,
    });
    const badFans = fans.filter((f) => f.alarm);
    checks.push({ rule: 'qnap_fan', raiseAfter: 2, hit: badFans.length ? { severity: 'warning', title: `${badFans.length} kipas NAS bermasalah`, message: model ?? '' } : null });

    return {
      series: { cpu, mem, netRx, netTx, volume: worstVol?.pct ?? null, diskTemp: maxTemp },
      data: {
        model: model ? `QNAP ${model}` : 'QNAP',
        version: version ? `QTS ${version}` : null,
        uptime: uptimeSec || null,
        sysTemp: sysTemp ?? cpuTemp,
        memUsed: memTotal != null && memFree != null ? Math.round((memTotal - memFree) * 1024 * 1024) : null,
        memTotal: memTotal != null ? Math.round(memTotal * 1024 * 1024) : null,
        volumes,
        disks,
        pools: [],
      },
      checks,
    };
  }

  raw() {
    return this.lastRaw;
  }

  async close() {
    // Keluar dari sesi agar tidak menumpuk di daftar sesi QTS
    if (this.sid) await requestText(`${this.base}authLogout.cgi?sid=${encodeURIComponent(this.sid)}`).catch(() => {});
  }
}
