import type { Details, MetricPoint } from './collectors/types.js';

export type Severity = 'critical' | 'warning';

export interface Alert {
  id: string;
  connId: string;
  rule: string;
  severity: Severity;
  title: string;
  message: string;
  since: number;
  resolvedAt?: number;
}

interface Hit {
  severity: Severity;
  title: string;
  message: string;
}

interface Ctx {
  status: 'connecting' | 'up' | 'error';
  statusMessage?: string;
  point?: MetricPoint;
  details?: Details;
  agentError?: string;
}

interface Rule {
  id: string;
  /** Berapa evaluasi berturut-turut kondisi harus terpenuhi sebelum alert muncul */
  raiseAfter: number;
  check: (c: Ctx) => Hit | null;
}

const pct = (v: number) => `${Math.round(v)}%`;
const secs = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} menit` : `${Math.round(ms / 1000)} detik`);
const short = (q: string) => (q.length > 80 ? q.slice(0, 80) + '…' : q);

const level = (v: number, warn: number, crit: number): Severity | null => (v >= crit ? 'critical' : v >= warn ? 'warning' : null);

/** Aturan alert. Ambang bisa diubah di sini. */
const RULES: Rule[] = [
  {
    id: 'conn_down',
    raiseAfter: 1,
    check: (c) =>
      c.status === 'error'
        ? { severity: 'critical', title: 'Koneksi database gagal', message: c.statusMessage || 'Tidak dapat terhubung' }
        : null,
  },
  {
    id: 'cpu',
    raiseAfter: 5,
    check: ({ point }) => {
      const v = point?.host?.cpuPct;
      const s = v == null ? null : level(v, 80, 90);
      return s && v != null ? { severity: s, title: `CPU tinggi (${pct(v)})`, message: 'Pemakaian CPU server database' } : null;
    },
  },
  {
    id: 'mem',
    raiseAfter: 5,
    check: ({ point }) => {
      const v = point?.host?.memPct;
      const s = v == null ? null : level(v, 85, 95);
      return s && v != null ? { severity: s, title: `RAM tinggi (${pct(v)})`, message: 'Pemakaian memori server database' } : null;
    },
  },
  {
    id: 'disk',
    raiseAfter: 5,
    check: ({ point }) => {
      const v = point?.host?.diskPct;
      const s = v == null ? null : level(v, 90, 95);
      return s && v != null ? { severity: s, title: `Disk hampir penuh (${pct(v)})`, message: 'Ruang disk server database' } : null;
    },
  },
  {
    id: 'conn_usage',
    raiseAfter: 5,
    check: ({ point }) => {
      const t = point?.totalConnections;
      const m = point?.maxConnections;
      if (t == null || !m) return null;
      const v = (t / m) * 100;
      const s = level(v, 75, 90);
      return s ? { severity: s, title: `Koneksi ${t}/${m} (${pct(v)})`, message: 'Mendekati batas max_connections' } : null;
    },
  },
  {
    id: 'latency',
    raiseAfter: 5,
    check: ({ point }) => {
      if (point?.latencySource !== 'stats' || point.latencyAvgMs == null) return null;
      const v = point.latencyAvgMs;
      const s = level(v, 500, 2000);
      return s ? { severity: s, title: `Latency rata-rata ${Math.round(v)} ms`, message: 'Query melambat' } : null;
    },
  },
  {
    id: 'long_query',
    raiseAfter: 1,
    check: ({ details }) => {
      const s = details?.sessions.filter((x) => x.state === 'running').sort((a, b) => b.durationMs - a.durationMs)[0];
      if (!s) return null;
      const sev = level(s.durationMs, 30_000, 120_000);
      return sev
        ? { severity: sev, title: `Query berjalan ${secs(s.durationMs)}`, message: `Sesi ${s.id}: ${short(s.query)}` }
        : null;
    },
  },
  {
    id: 'lock_wait',
    raiseAfter: 1,
    check: ({ details }) => {
      const w = details?.sessions.filter((x) => x.state !== 'running').sort((a, b) => b.durationMs - a.durationMs);
      if (!w?.length) return null;
      const sev = level(w[0].durationMs, 10_000, 60_000);
      return sev
        ? {
            severity: sev,
            title: `${w.length} sesi menunggu lock (${secs(w[0].durationMs)})`,
            message: w[0].lock || short(w[0].query),
          }
        : null;
    },
  },
  {
    id: 'agent_down',
    raiseAfter: 3,
    check: ({ agentError }) =>
      agentError ? { severity: 'warning', title: 'Agen CPU & RAM tidak terjangkau', message: agentError } : null,
  },
];

/** Kondisi harus normal sekian kali berturut-turut sebelum alert dianggap selesai (mencegah kedip). */
const CLEAR_AFTER = 5;
const RECENT_MAX = 20;

interface ConnState {
  active: Map<string, Alert>;
  hits: Map<string, number>;
  clears: Map<string, number>;
  recent: Alert[];
}

/** Pencatat riwayat alert (opsional) — dipanggil saat alert muncul, berubah, selesai */
export interface AlertListener {
  raise(a: Alert): void;
  update(a: Alert): void;
  resolve(a: Alert, at: number): void;
}

export class AlertEngine {
  private state = new Map<string, ConnState>();
  constructor(private log?: AlertListener) {}

  private get(connId: string) {
    let s = this.state.get(connId);
    if (!s) {
      s = { active: new Map(), hits: new Map(), clears: new Map(), recent: [] };
      this.state.set(connId, s);
    }
    return s;
  }

  /**
   * Evaluasi aturan yang relevan. `scope` membatasi aturan: data metrik dievaluasi tiap detik,
   * data detail (sesi/lock) tiap beberapa detik.
   * @returns true bila daftar alert berubah
   */
  evaluate(connId: string, ctx: Ctx, scope: 'point' | 'details' | 'status' | 'agent'): boolean {
    const ids: Record<typeof scope, string[]> = {
      point: ['cpu', 'mem', 'disk', 'conn_usage', 'latency'],
      details: ['long_query', 'lock_wait'],
      status: ['conn_down'],
      agent: ['agent_down'],
    };
    return this.apply(
      connId,
      RULES.filter((r) => ids[scope].includes(r.id)).map((r) => ({ id: r.id, raiseAfter: r.raiseAfter, hit: r.check(ctx) })),
    );
  }

  /**
   * Kondisi alert dari perangkat (Proxmox, NAS, Backup, ISP) — tiap sumber menghitung sendiri kondisinya.
   * @returns true bila daftar alert berubah
   */
  evaluateChecks(connId: string, checks: { rule: string; raiseAfter?: number; clearAfter?: number; hit: Hit | null }[]): boolean {
    return this.apply(
      connId,
      checks.map((c) => ({ id: c.rule, raiseAfter: c.raiseAfter ?? 1, clearAfter: c.clearAfter, hit: c.hit })),
    );
  }

  private apply(connId: string, items: { id: string; raiseAfter: number; clearAfter?: number; hit: Hit | null }[]): boolean {
    const st = this.get(connId);
    let changed = false;
    const now = Date.now();
    for (const rule of items) {
      const hit = rule.hit;
      const cur = st.active.get(rule.id);
      if (hit) {
        st.clears.delete(rule.id);
        const n = (st.hits.get(rule.id) ?? 0) + 1;
        st.hits.set(rule.id, n);
        if (cur) {
          if (cur.severity !== hit.severity || cur.title !== hit.title || cur.message !== hit.message) {
            Object.assign(cur, hit);
            this.log?.update(cur);
            changed = true;
          }
        } else if (n >= rule.raiseAfter) {
          const a: Alert = { id: `${connId}:${rule.id}:${now}`, connId, rule: rule.id, since: now, ...hit };
          st.active.set(rule.id, a);
          this.log?.raise(a);
          changed = true;
        }
      } else {
        st.hits.delete(rule.id);
        if (cur) {
          const c = (st.clears.get(rule.id) ?? 0) + 1;
          st.clears.set(rule.id, c);
          // Koneksi pulih langsung dianggap selesai; aturan lain menunggu stabil
          if (c >= (rule.clearAfter ?? (rule.id === 'conn_down' ? 1 : CLEAR_AFTER))) {
            st.active.delete(rule.id);
            st.clears.delete(rule.id);
            this.log?.resolve(cur, now);
            st.recent.unshift({ ...cur, resolvedAt: now });
            st.recent.length = Math.min(st.recent.length, RECENT_MAX);
            changed = true;
          }
        }
      }
    }
    return changed;
  }

  snapshot(connId: string) {
    const st = this.get(connId);
    const order = (a: Alert, b: Alert) =>
      (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1) || b.since - a.since;
    return { connId, active: [...st.active.values()].sort(order), recent: st.recent };
  }

  forget(connId: string) {
    this.state.delete(connId);
  }
}
