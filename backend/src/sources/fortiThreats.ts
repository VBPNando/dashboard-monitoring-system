import { HttpError } from '../http.js';
import { isPrivateIp } from '../net.js';
import * as store from './threatStore.js';
import type { ThreatEvent } from './threatStore.js';

/**
 * Pengambil log ancaman FortiGate (IPS, DoS/anomaly, antivirus) untuk "Peta Serangan".
 * Dibaca dari log disk FortiGate bila ada, bila tidak dari log memory. Profil admin API butuh
 * akses baca "Log & Report".
 *
 * FortiOS memakai dua bentuk path tergantung versi:  /log/<disk|memory>/<tipe>  atau
 * /log/<disk|memory>/utm/<tipe>. Keduanya dicoba, yang berhasil diingat.
 */
type Fetch = (path: string) => Promise<{ results?: unknown; session_id?: number; completed?: number }>;
type Log = Record<string, unknown>;

const LOGS = [
  { id: 'ips', kind: 'IPS' },
  { id: 'anomaly', kind: 'DoS' },
  { id: 'virus', kind: 'Malware' },
] as const;

const FETCH_EVERY = 30_000;
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info']);

const str = (x: unknown) => (x == null ? '' : String(x));
const num = (x: unknown) => {
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
};

/** eventtime FortiOS bisa detik, milidetik, mikrodetik, atau nanodetik */
function tsOf(l: Log): number {
  const e = num(l.eventtime);
  if (e && e > 0) {
    if (e > 1e17) return Math.floor(e / 1e6);
    if (e > 1e14) return Math.floor(e / 1e3);
    if (e > 1e11) return Math.floor(e);
    return Math.floor(e * 1000);
  }
  const it = num(l.itime);
  if (it && it > 1e9) return it * 1000;
  const d = str(l.date);
  const t = str(l.time);
  const parsed = d && t ? new Date(`${d}T${t}`).getTime() : NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function blockedOf(action: string) {
  return /block|drop|reset|clear|deny|quarantin|reject/i.test(action);
}

export function normalize(l: Log, kind: ThreatEvent['kind']): ThreatEvent {
  const src = str(l.srcip);
  const dst = str(l.dstip);
  const action = str(l.action);
  let sev = str(l.severity).toLowerCase();
  if (!SEVERITIES.has(sev)) sev = kind === 'Malware' ? 'high' : str(l.level).toLowerCase() === 'alert' ? 'high' : 'medium';
  if (kind === 'Malware' && !blockedOf(action)) sev = 'critical';
  const srcPublic = src && !isPrivateIp(src);
  const dstPublic = dst && !isPrivateIp(dst);
  // Masuk: penyerang dari internet → server kantor. Keluar: perangkat kantor → internet (malware/botnet).
  const dir: ThreatEvent['dir'] = srcPublic ? 'in' : dstPublic ? 'out' : 'lan';
  const country = dir === 'in' ? str(l.srccountry) : dir === 'out' ? str(l.dstcountry) : '';
  return {
    ts: tsOf(l),
    kind,
    dir,
    name: str(l.attack) || str(l.virus) || str(l.msg) || kind,
    severity: sev,
    blocked: blockedOf(action),
    action,
    remoteIp: dir === 'in' ? src : dir === 'out' ? dst : src,
    country: /^reserved$/i.test(country) ? '' : country,
    localIp: dir === 'in' ? dst : dir === 'out' ? src : dst,
    port: num(l.dstport),
    count: Math.max(1, num(l.count) ?? 1),
  };
}

const keyOf = (l: Log) => [l.eventtime ?? l.itime ?? `${str(l.date)} ${str(l.time)}`, l.logid, l.sessionid, l.attackid ?? l.virusid ?? l.attack ?? l.virus, l.srcip, l.dstip].join('|');

export class ThreatCollector {
  private lastFetch = 0;
  private path: { device: 'disk' | 'memory'; utm: boolean } | null = null;
  private seen = new Map<string, Map<string, number>>(); // log → kunci kejadian yang sudah dibaca (2 menit terakhir)
  status: { ok: boolean; message: string | null; device: string | null; lastFetch: number | null; perMinute: number | null } = {
    ok: false,
    message: null,
    device: null,
    lastFetch: null,
    perMinute: null,
  };

  constructor(
    private sourceId: string,
    private fetch: Fetch,
  ) {}

  /** Dipanggil setiap sampel; benar-benar mengambil log tiap 30 detik */
  async tick() {
    if (Date.now() - this.lastFetch < FETCH_EVERY) return;
    const prevFetch = this.lastFetch;
    this.lastFetch = Date.now();
    try {
      if (!this.path) this.path = await this.detect();
      let added = 0;
      for (const l of LOGS) {
        const rows = await this.read(l.id);
        added += this.ingest(l.id, l.kind, rows);
      }
      const dt = prevFetch ? (Date.now() - prevFetch) / 60_000 : null;
      this.status = { ok: true, message: null, device: this.path.device, lastFetch: Date.now(), perMinute: dt ? Math.round((added / dt) * 10) / 10 : null };
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 0;
      const message =
        status === 403 || status === 401
          ? 'Akses log ditolak. Beri profil admin API hak baca "Log & Report" (System → Admin Profiles).'
          : status === 404
            ? 'Log tidak ditemukan. Pastikan logging ke memory/disk aktif (Log & Report → Log Settings).'
            : `Gagal membaca log: ${(e as Error).message}`;
      this.status = { ...this.status, ok: false, message, perMinute: null };
      if (status === 404) this.path = null;
    }
  }

  /** Cari lokasi log yang berfungsi: disk dulu (lebih panjang), lalu memory */
  private async detect() {
    let lastErr: unknown = null;
    for (const device of ['disk', 'memory'] as const) {
      for (const utm of [false, true]) {
        try {
          const r = await this.fetch(`/log/${device}/${utm ? 'utm/' : ''}ips?rows=1`);
          if (Array.isArray(r.results)) return { device, utm };
        } catch (e) {
          lastErr = e;
          if (e instanceof HttpError && (e.status === 401 || e.status === 403)) throw e;
        }
      }
    }
    throw lastErr ?? new HttpError('not found', 404);
  }

  private async read(log: string): Promise<Log[]> {
    const p = this.path!;
    const base = `/log/${p.device}/${p.utm ? 'utm/' : ''}${log}?rows=500`;
    try {
      let r = await this.fetch(base);
      // Pencarian log disk bisa bertahap (completed < 100): lanjutkan dengan session_id
      for (let i = 0; i < 4 && r.completed != null && r.completed < 100 && r.session_id; i++) {
        await new Promise((res) => setTimeout(res, 400));
        r = await this.fetch(`${base}&session_id=${r.session_id}`);
      }
      return Array.isArray(r.results) ? (r.results as Log[]) : [];
    } catch (e) {
      // Jenis log tertentu (mis. anomaly) bisa tidak ada di sebagian model → lewati
      if (e instanceof HttpError && e.status === 404 && log !== 'ips') return [];
      throw e;
    }
  }

  /**
   * Simpan hanya kejadian yang belum pernah dibaca. Log yang datang sedikit terlambat (waktu lebih
   * awal dari kejadian terakhir) tetap diterima selama masih dalam jendela 2 menit.
   */
  private ingest(log: string, kind: ThreatEvent['kind'], rows: Log[]) {
    const OVERLAP = 120_000;
    let cur = store.cursor(this.sourceId, log);
    if (!cur) cur = Date.now() - 86400_000; // pertama kali: maksimal 24 jam ke belakang
    const warm = this.seen.has(log); // false tepat setelah server dinyalakan
    const seen = this.seen.get(log) ?? new Map<string, number>();
    const fresh: ThreatEvent[] = [];
    let maxTs = cur;
    for (const l of rows) {
      const ts = tsOf(l);
      const k = keyOf(l);
      const ok = warm ? ts > cur - OVERLAP && !seen.has(k) : ts > cur;
      if (!ok) continue;
      seen.set(k, ts);
      fresh.push(normalize(l, kind));
      if (ts > maxTs) maxTs = ts;
    }
    for (const [k, ts] of seen) if (ts < maxTs - OVERLAP * 1.5) seen.delete(k);
    this.seen.set(log, seen);
    if (fresh.length) {
      store.add(this.sourceId, fresh);
      if (maxTs > cur) store.setCursor(this.sourceId, log, maxTs);
    }
    return fresh.reduce((a, e) => a + e.count, 0);
  }
}
