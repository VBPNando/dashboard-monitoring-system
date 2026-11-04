import { pingOnce, tcpProbe, type ProbeResult } from './ping.js';
import * as store from './ispStore.js';
import { r1, type Check, type DeviceConfig, type DeviceSample, type DeviceSource } from './types.js';

/** Ping gagal berturut-turut sebelum dihitung sebagai gangguan (downtime). */
const OUTAGE_AFTER = 3;
const RECENT = 360; // ±1 jam pada interval 10 detik

/**
 * SLA ISP: ping berkala ke IP yang mewakili satu link ISP (gateway/modem ISP, atau IP publik link),
 * lalu menghitung uptime, downtime, latency, packet loss & sisa "jatah downtime" sesuai target SLA.
 */
export class IspSource implements DeviceSource {
  readonly intervalMs: number;
  private failStreak = 0;
  private firstFailAt = 0;
  private incidentId: number | null = null;
  private recent: { ts: number; ok: boolean; ms: number | null }[] = [];
  private lastError = '';

  constructor(private cfg: DeviceConfig) {
    this.intervalMs = Math.max(5, cfg.options.intervalSec ?? 10) * 1000;
    store.closeDangling(cfg.id);
  }

  private probe(): Promise<ProbeResult> {
    const o = this.cfg.options;
    return o.method === 'tcp' ? tcpProbe(this.cfg.host, o.tcpPort ?? 443) : pingOnce(this.cfg.host);
  }

  async test() {
    const r = await this.probe();
    if (r.error?.includes('tidak tersedia')) throw new Error(r.error);
    if (!r.ok) throw new Error(`${this.cfg.host} tidak membalas (${r.error ?? 'timeout'}). Pastikan IP bisa di-ping dari komputer Dashboard Monitoring System`);
    return `${this.cfg.host} membalas dalam ${r.ms} ms`;
  }

  async sample(): Promise<DeviceSample> {
    const o = this.cfg.options;
    const now = Date.now();
    const r = await this.probe();
    if (r.error?.includes('tidak tersedia')) throw new Error(r.error);
    store.recordProbe(this.cfg.id, now, r.ok, r.ms);
    this.recent.push({ ts: now, ok: r.ok, ms: r.ms });
    if (this.recent.length > RECENT) this.recent.shift();
    if (!r.ok) this.lastError = r.error ?? 'Timeout';

    // Deteksi gangguan: N ping gagal berturut-turut; mulai dihitung dari ping gagal pertama
    if (r.ok) {
      if (this.incidentId != null) store.closeIncident(this.incidentId, now);
      this.incidentId = null;
      this.failStreak = 0;
    } else {
      if (this.failStreak === 0) this.firstFailAt = now;
      this.failStreak++;
      if (this.failStreak >= OUTAGE_AFTER && this.incidentId == null) {
        this.incidentId = store.openIncident(this.cfg.id, this.firstFailAt, r.error ?? 'Timeout');
      }
    }
    const down = this.incidentId != null;

    // Statistik singkat dari ping terakhir
    const last30 = this.recent.slice(-30);
    const loss = last30.length ? (last30.filter((x) => !x.ok).length / last30.length) * 100 : null;
    const okMs = last30.filter((x) => x.ok && x.ms != null).map((x) => x.ms!);
    const avg = okMs.length ? okMs.reduce((a, b) => a + b, 0) / okMs.length : null;
    const jitter = okMs.length > 1 ? okMs.slice(1).reduce((a, v, i) => a + Math.abs(v - okMs[i]), 0) / (okMs.length - 1) : null;

    // SLA
    const target = o.slaTarget ?? 99.5;
    const ws = store.windows(now);
    const stats = ws.map((w) => store.sla(this.cfg.id, w, now));
    const month = stats.find((s) => s.key === 'month')!;
    const d = new Date(now);
    const monthMs = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() - new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    const budgetMs = ((100 - target) / 100) * monthMs;
    const incidents = store.incidents(this.cfg.id, now - 30 * 86400_000);

    const label = o.provider || this.cfg.name;
    const warnMs = o.latencyWarnMs ?? 100;
    const avg6 = (() => {
      const xs = this.recent.slice(-6).filter((x) => x.ok && x.ms != null).map((x) => x.ms!);
      return xs.length >= 3 ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    })();
    const checks: Check[] = [
      {
        rule: 'isp_down',
        clearAfter: 1,
        hit: down
          ? {
              severity: 'critical',
              title: `${label} DOWN`,
              message: `Sejak ${new Date(this.firstFailAt).toLocaleTimeString('id-ID')} · ${this.lastError}`,
            }
          : null,
      },
      {
        rule: 'isp_latency',
        raiseAfter: 3,
        hit:
          !down && avg6 != null && avg6 >= warnMs
            ? { severity: avg6 >= warnMs * 2 ? 'critical' : 'warning', title: `Latency ${label} ${Math.round(avg6)} ms`, message: `Ambang ${warnMs} ms` }
            : null,
      },
      {
        rule: 'isp_loss',
        raiseAfter: 3,
        hit:
          !down && loss != null && last30.length >= 10 && loss >= 5
            ? { severity: loss >= 20 ? 'critical' : 'warning', title: `Packet loss ${label} ${Math.round(loss)}%`, message: '30 ping terakhir' }
            : null,
      },
      {
        rule: 'isp_sla',
        // Baru dinilai setelah ≥ 24 jam data bulan ini, agar gangguan di awal pemakaian tidak langsung memicu alert
        hit:
          month.uptimePct != null &&
          month.uptimePct < target &&
          (month.coveragePct / 100) * (now - ws.find((w) => w.key === 'month')!.from) >= 86400_000
            ? {
                severity: 'warning',
                title: `SLA ${label} ${month.uptimePct.toFixed(2)}% < ${target}%`,
                message: `Bulan ini, downtime ${Math.round(month.downtimeMs / 60_000)} menit`,
              }
            : null,
      },
    ];

    return {
      series: { latency: r.ok ? r1(r.ms) : null, up: r.ok ? 1 : 0, loss: loss == null ? null : r1(loss) },
      data: {
        target: this.cfg.host,
        provider: o.provider ?? '',
        method: o.method ?? 'ping',
        tcpPort: o.tcpPort ?? null,
        slaTarget: target,
        down,
        downSince: down ? this.firstFailAt : null,
        lastOk: r.ok,
        lastMs: r.ms,
        lastError: r.ok ? null : (r.error ?? 'Timeout'),
        latencyAvg: r1(avg),
        jitter: r1(jitter),
        lossPct: loss == null ? null : r1(loss),
        sla: stats.map((s) => ({ ...s, uptimePct: s.uptimePct == null ? null : Math.round(s.uptimePct * 1000) / 1000, lossPct: r1(s.lossPct), latencyAvg: r1(s.latencyAvg), coveragePct: r1(s.coveragePct) })),
        budgetMs,
        budgetUsedMs: month.downtimeMs,
        budgetLeftMs: budgetMs - month.downtimeMs,
        incidents,
        intervalSec: this.intervalMs / 1000,
      },
      checks,
    };
  }

  async close() {
    // Gangguan yang sedang berjalan ditutup saat pemantauan dihentikan
    if (this.incidentId != null) store.closeIncident(this.incidentId, Date.now());
    this.incidentId = null;
  }
}
