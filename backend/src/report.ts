import type { FastifyInstance } from 'fastify';
import * as store from './store.js';
import * as history from './history.js';
import * as devHistory from './deviceHistory.js';
import * as ispStore from './sources/ispStore.js';
import * as threatStore from './sources/threatStore.js';
import { alertsBetween, type LoggedAlert } from './alertLog.js';
import type { DeviceManager } from './devices.js';

/**
 * Laporan periode: ringkasan per sumber (rata-rata & puncak, SLA, alert) dan unduhan CSV.
 *   GET /api/report/summary?ids=a,b&from=<ms>&to=<ms>
 *   GET /api/report/csv?ids=a,b&from=<ms>&to=<ms>&res=hour|day|minute&fmt=id|en
 */

type Unit = '%' | 'ms' | 'B/s' | '°C' | '' | 'qps';
interface Def {
  label: string;
  unit: Unit;
}

const DB_ENGINES = new Set(['mariadb', 'postgres', 'mssql', 'sqlite']);
const ENGINE_LABEL: Record<string, string> = {
  mariadb: 'MariaDB',
  postgres: 'PostgreSQL',
  mssql: 'SQL Server',
  sqlite: 'SQLite',
  proxmox: 'Proxmox VE',
  pbs: 'Proxmox Backup',
  synology: 'Synology NAS',
  abb: 'Active Backup',
  isp: 'ISP',
  fortigate: 'FortiGate',
  mikrotik: 'MikroTik',
};

/** Nama & satuan angka perangkat untuk laporan (kunci = nama seri di sources/*.ts) */
const DEVICE_KEYS: Record<string, Record<string, Def>> = {
  proxmox: {
    cpu: { label: 'CPU', unit: '%' },
    mem: { label: 'Memory', unit: '%' },
    storage: { label: 'Storage terpenuh', unit: '%' },
    iowait: { label: 'IO wait', unit: '%' },
    netIn: { label: 'Jaringan masuk', unit: 'B/s' },
    netOut: { label: 'Jaringan keluar', unit: 'B/s' },
    vmRunning: { label: 'VM berjalan', unit: '' },
    ctRunning: { label: 'CT berjalan', unit: '' },
  },
  pbs: {
    cpu: { label: 'CPU', unit: '%' },
    mem: { label: 'Memory', unit: '%' },
    datastore: { label: 'Datastore terpenuh', unit: '%' },
    iowait: { label: 'IO wait', unit: '%' },
    backupOk: { label: 'Backup sukses (24 jam)', unit: '' },
    backupFailed: { label: 'Backup gagal belum tertangani', unit: '' },
  },
  synology: {
    cpu: { label: 'CPU', unit: '%' },
    mem: { label: 'Memory', unit: '%' },
    volume: { label: 'Volume terpenuh', unit: '%' },
    diskTemp: { label: 'Suhu disk', unit: '°C' },
    netRx: { label: 'Download', unit: 'B/s' },
    netTx: { label: 'Upload', unit: 'B/s' },
    diskRead: { label: 'Baca disk', unit: 'B/s' },
    diskWrite: { label: 'Tulis disk', unit: 'B/s' },
  },
  abb: {
    success: { label: 'Tugas sukses', unit: '' },
    failed: { label: 'Tugas gagal', unit: '' },
    partial: { label: 'Tugas sebagian', unit: '' },
    running: { label: 'Tugas berjalan', unit: '' },
  },
  isp: {
    latency: { label: 'Latency', unit: 'ms' },
    loss: { label: 'Packet loss', unit: '%' },
  },
  fortigate: {
    cpu: { label: 'CPU', unit: '%' },
    mem: { label: 'Memory', unit: '%' },
    sessions: { label: 'Sesi aktif', unit: '' },
    rx: { label: 'Download WAN', unit: 'B/s' },
    tx: { label: 'Upload WAN', unit: 'B/s' },
    wanUp: { label: 'Link WAN hidup', unit: '' },
    threats: { label: 'Serangan per menit', unit: '' },
  },
  mikrotik: {
    cpu: { label: 'CPU', unit: '%' },
    mem: { label: 'Memory', unit: '%' },
    temp: { label: 'Suhu', unit: '°C' },
    rx: { label: 'Download WAN', unit: 'B/s' },
    tx: { label: 'Upload WAN', unit: 'B/s' },
    wanUp: { label: 'Interface WAN hidup', unit: '' },
  },
};

/** Kolom CSV database: [judul, ambil nilai, satuan] */
const DB_COLS: [string, (p: history.HistoryPoint) => number | null | undefined][] = [
  ['QPS', (p) => p.qps],
  ['QPS puncak', (p) => p.qpsMax],
  ['TPS', (p) => p.tps],
  ['Latency rata-rata (ms)', (p) => p.latencyAvgMs],
  ['Latency maks (ms)', (p) => p.latencyMaxMs],
  ['Koneksi', (p) => p.totalConnections],
  ['Koneksi aktif', (p) => p.activeConnections],
  ['Batas koneksi', (p) => p.maxConnections],
  ['Read/dtk', (p) => p.reads],
  ['Write/dtk', (p) => p.writes],
  ['SELECT/dtk', (p) => p.ops.select],
  ['INSERT/dtk', (p) => p.ops.insert],
  ['UPDATE/dtk', (p) => p.ops.update],
  ['DELETE/dtk', (p) => p.ops.delete],
  ['CPU server (%)', (p) => p.cpuPct],
  ['Memory server (%)', (p) => p.memPct],
];

interface Row {
  label: string;
  unit: Unit;
  avg: number | null;
  max: number | null;
}

function keyDef(kind: string, k: string, alias: (iface: string) => string): Def {
  const d = DEVICE_KEYS[kind]?.[k];
  if (d) return d;
  if (k.startsWith('lat.')) return { label: `Latency ${alias(k.slice(4))}`, unit: 'ms' };
  if (k.startsWith('ds.')) return { label: `Datastore ${k.slice(3)}`, unit: '%' };
  return { label: k, unit: '' };
}

const MIN = 60_000;

function parseQuery(q: Record<string, string | undefined>) {
  const now = Date.now();
  const to = Math.min(Number(q.to) || now, now + MIN);
  const from = Math.max(Number(q.from) || to - 86400_000, to - 800 * 86400_000);
  if (!(from < to)) return null;
  const all = store.listPublic();
  const ids = q.ids ? new Set(q.ids.split(',')) : null;
  const sources = all.filter((c) => !ids || ids.has(c.id));
  return { from, to, sources };
}

export function registerReports(app: FastifyInstance, devices: DeviceManager) {
  /** Alias interface FortiGate (port1 → "ISP-A") dari data terakhir */
  const aliasFn = (id: string) => {
    const d = devices.snapshot(id)?.data as { wans?: { name: string; alias: string }[] } | undefined;
    return (iface: string) => {
      const a = d?.wans?.find((w) => w.name === iface)?.alias;
      return a ? `${a} (${iface})` : iface;
    };
  };

  app.get<{ Querystring: Record<string, string | undefined> }>('/api/report/summary', async (req, reply) => {
    const p = parseQuery(req.query);
    if (!p) return reply.code(400).send({ error: 'Periode tidak valid' });
    const { from, to } = p;
    const periodMin = Math.max(1, (Math.min(to, Date.now()) - from) / MIN);

    const sources = p.sources.map((c) => {
      const alerts = alertsBetween(c.id, from, to);
      const base = {
        id: c.id,
        name: c.name,
        engine: c.engine,
        engineLabel: ENGINE_LABEL[c.engine] ?? c.engine,
        host: c.host ?? c.filePath ?? '',
        alerts: alertStats(alerts, from, to),
      };
      if (DB_ENGINES.has(c.engine)) {
        const s = history.summary(c.id, from, to);
        const dbRows: Row[] = [
          { label: 'QPS (query/dtk)', unit: 'qps', avg: s.qps, max: s.qps_max },
          { label: 'TPS (transaksi/dtk)', unit: 'qps', avg: s.tps, max: s.tps_max },
          { label: 'Latency query', unit: 'ms', avg: s.lat_avg, max: s.lat_max },
          { label: 'Koneksi', unit: '', avg: s.total, max: s.total_max },
          { label: 'Koneksi aktif', unit: '', avg: s.active, max: s.active_max },
          { label: 'CPU server', unit: '%', avg: s.cpu, max: s.cpu_max },
          { label: 'Memory server', unit: '%', avg: s.mem, max: s.mem_max },
        ];
        const rows = dbRows.filter((r) => r.avg != null || r.max != null);
        return {
          ...base,
          coveragePct: pctOf(s.minutes ?? 0, periodMin),
          rows,
          totals: [
            { label: 'Total query', value: s.queries },
            { label: 'Total transaksi', value: s.txs },
          ],
        };
      }
      const alias = aliasFn(c.id);
      const sum = devHistory.summary(c.id, from, to);
      const order = Object.keys(DEVICE_KEYS[c.engine] ?? {});
      const rows: Row[] = sum
        .filter((r) => !(c.engine === 'isp' && r.k === 'up'))
        .sort((a, b) => idx(order, a.k) - idx(order, b.k) || a.k.localeCompare(b.k))
        .map((r) => ({ ...keyDef(c.engine, r.k, alias), avg: r.avg, max: r.max }));
      const minutes = Math.max(0, ...sum.map((r) => r.minutes));
      const out: Record<string, unknown> = { ...base, coveragePct: pctOf(minutes, periodMin), rows, totals: [] };
      if (c.engine === 'isp') {
        out.sla = ispStore.sla(c.id, { key: 'report', label: 'Periode', from, to: Math.min(to, Date.now()) });
        out.slaTarget = c.options?.slaTarget ?? 99.5;
        out.incidents = ispStore.incidentsBetween(c.id, from, to);
      }
      if (c.engine === 'fortigate') out.threats = threatStore.periodSummary(c.id, from, to);
      return out;
    });
    return { from, to, generatedAt: Date.now(), sources };
  });

  app.get<{ Querystring: Record<string, string | undefined> }>('/api/report/csv', async (req, reply) => {
    const p = parseQuery(req.query);
    if (!p) return reply.code(400).send({ error: 'Periode tidak valid' });
    const { from, to } = p;
    const res = req.query.res === 'minute' ? 'minute' : req.query.res === 'day' ? 'day' : 'hour';
    if (res === 'minute' && to - from > 7 * 86400_000) {
      return reply.code(400).send({ error: 'Resolusi per menit maksimal 7 hari. Pilih per jam atau per hari.' });
    }
    const en = req.query.fmt === 'en';
    const sep = en ? ',' : ';';
    const num = (v: number | null | undefined, digits = 1) => {
      if (v == null || !Number.isFinite(v)) return '';
      const s = (Math.round(v * 10 ** digits) / 10 ** digits).toString();
      return en ? s : s.replace('.', ',');
    };
    const cell = (s: string) => (s.includes(sep) || /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const line = (xs: (string | number)[]) => xs.map((x) => cell(String(x))).join(sep);
    const conv = (v: number | null | undefined, unit: Unit) => (unit === 'B/s' && v != null ? v / 1024 : v);
    const unitLabel = (u: Unit) => (u === 'B/s' ? 'KB/dtk' : u === 'qps' ? '' : u);
    const bucket = res === 'minute' ? MIN : 3600_000;

    const out: string[] = [
      line(['Laporan Dashboard Monitoring System']),
      line(['Periode', fmtTime(from), 's/d', fmtTime(to)]),
      line(['Resolusi', res === 'minute' ? 'Per menit' : res === 'day' ? 'Per hari' : 'Per jam']),
      line(['Dibuat', fmtTime(Date.now())]),
      '',
    ];

    for (const c of p.sources) {
      out.push(line([`Sumber: ${c.name}`, ENGINE_LABEL[c.engine] ?? c.engine, c.host ?? c.filePath ?? '']));
      if (DB_ENGINES.has(c.engine)) {
        let pts = history.query(c.id, from, bucket, to).map((p) => ({ ts: p.ts, vals: DB_COLS.map(([, g]) => g(p) ?? null) }));
        if (res === 'day') pts = byDay(pts, (p) => p.vals, DB_COLS.map(([h]) => /maks|puncak|Batas/.test(h)));
        out.push(line(['Waktu', ...DB_COLS.map(([h]) => h)]));
        for (const pt of pts) out.push(line([fmtTime(pt.ts, res === 'day'), ...pt.vals.map((v) => num(v))]));
        if (!pts.length) out.push(line(['(tidak ada data di periode ini)']));
      } else {
        const alias = aliasFn(c.id);
        const raw = devHistory.query(c.id, from, bucket, to);
        const keys = [...new Set(raw.flatMap((p) => Object.keys(p.v)))]
          .filter((k) => !(c.engine === 'isp' && k === 'up'))
          .sort((a, b) => idx(Object.keys(DEVICE_KEYS[c.engine] ?? {}), a) - idx(Object.keys(DEVICE_KEYS[c.engine] ?? {}), b) || a.localeCompare(b));
        const defs = keys.map((k) => keyDef(c.engine, k, alias));
        // Rata-rata + nilai tertinggi untuk persen/latency/suhu
        const withMax = defs.map((d) => d.unit === '%' || d.unit === 'ms' || d.unit === '°C');
        const header = ['Waktu'];
        defs.forEach((d, i) => {
          const u = unitLabel(d.unit);
          header.push(u ? `${d.label} (${u})` : d.label);
          if (withMax[i]) header.push(`${d.label} maks${u ? ` (${u})` : ''}`);
        });
        type P = { ts: number; vals: (number | null)[] };
        let pts: P[] = raw.map((p) => ({
          ts: p.ts,
          vals: keys.flatMap((k, i) => {
            const a = conv(p.v[k], defs[i].unit) ?? null;
            return withMax[i] ? [a, conv(p.max?.[k], defs[i].unit) ?? null] : [a];
          }),
        }));
        if (res === 'day') {
          const isMax = keys.flatMap((_, i) => (withMax[i] ? [false, true] : [false]));
          pts = byDay(pts, (p) => p.vals, isMax);
        }
        out.push(line(header));
        for (const pt of pts) out.push(line([fmtTime(pt.ts, res === 'day'), ...pt.vals.map((v) => num(v))]));
        if (!pts.length) out.push(line(['(tidak ada data di periode ini)']));

        if (c.engine === 'isp') {
          const s = ispStore.sla(c.id, { key: 'r', label: 'Periode', from, to: Math.min(to, Date.now()) });
          out.push('', line(['SLA periode ini', 'Target (%)', 'Uptime (%)', 'Downtime (menit)', 'Gangguan', 'Packet loss (%)', 'Latency rata-rata (ms)', 'Terpantau (%)']));
          out.push(line(['', num(c.options?.slaTarget ?? 99.5, 2), num(s.uptimePct, 3), num(s.downtimeMs / MIN), s.incidents, num(s.lossPct, 2), num(s.latencyAvg), num(s.coveragePct)]));
          const inc = ispStore.incidentsBetween(c.id, from, to);
          if (inc.length) {
            out.push('', line(['Gangguan ISP', 'Mulai', 'Selesai', 'Durasi (menit)', 'Keterangan']));
            for (const i of inc) out.push(line(['', fmtTime(i.start), i.end ? fmtTime(i.end) : 'masih berlangsung', num(i.durationMs / MIN), i.reason ?? '']));
          }
        }
      }

      if (c.engine === 'fortigate') {
        const t = threatStore.periodSummary(c.id, from, to);
        if (t.n) {
          out.push('', line(['Serangan (log FortiGate)', 'Total', 'Diblokir', 'Kritis', 'Tinggi', 'Keluar (perangkat kantor)']));
          out.push(line(['', t.n, t.blocked, t.critical, t.high, t.outbound]));
          out.push('', line(['Negara penyerang teratas', 'Jumlah']));
          for (const r of t.topCountries) out.push(line([r.k, r.n]));
          out.push('', line(['Jenis serangan teratas', 'Jumlah']));
          for (const r of t.topAttacks) out.push(line([r.k, r.n]));
        }
      }

      const al = alertsBetween(c.id, from, to);
      if (al.length) {
        out.push('', line(['Riwayat alert', 'Mulai', 'Selesai', 'Durasi (menit)', 'Tingkat', 'Judul', 'Keterangan']));
        for (const a of al) {
          const end = a.end ?? Date.now();
          out.push(line(['', fmtTime(a.start), a.end ? fmtTime(a.end) : 'masih aktif', num((end - a.start) / MIN), a.severity === 'critical' ? 'Kritis' : 'Waspada', a.title, a.message ?? '']));
        }
      }
      out.push('', '');
    }

    const name = `laporan-monitoring_${fileDate(from)}_${fileDate(to)}.csv`;
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${name}"`)
      .header('Cache-Control', 'no-store');
    // BOM agar Excel membaca UTF-8 (huruf °, —, dst.)
    return '﻿' + out.join('\r\n');
  });
}

const idx = (order: string[], k: string) => {
  const i = order.indexOf(k);
  return i < 0 ? 999 : i;
};
const pctOf = (minutes: number, periodMin: number) => Math.min(100, Math.round((minutes / periodMin) * 1000) / 10);

function alertStats(list: LoggedAlert[], from: number, to: number) {
  const now = Date.now();
  const dur = (a: LoggedAlert) => Math.max(0, Math.min(a.end ?? now, to) - Math.max(a.start, from));
  const down = list.filter((a) => a.rule === 'conn_down');
  return {
    critical: list.filter((a) => a.severity === 'critical').length,
    warning: list.filter((a) => a.severity === 'warning').length,
    downtimeMs: down.reduce((s, a) => s + dur(a), 0),
    list: list
      .slice(-100)
      .reverse()
      .map((a) => ({ id: a.id, rule: a.rule, severity: a.severity, title: a.title, message: a.message, start: a.start, end: a.end, durationMs: dur(a) })),
  };
}

/** Gabungkan titik per jam menjadi per hari (tanggal lokal server): rata-rata, atau maksimum untuk kolom puncak */
function byDay<T extends { ts: number }>(pts: T[], vals: (p: T) => (number | null | undefined)[], isMax: boolean[]) {
  const days = new Map<number, { sum: number[]; n: number[]; max: (number | null)[] }>();
  for (const p of pts) {
    const d = new Date(p.ts);
    const key = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    let acc = days.get(key);
    const v = vals(p);
    if (!acc) {
      acc = { sum: v.map(() => 0), n: v.map(() => 0), max: v.map(() => null) };
      days.set(key, acc);
    }
    v.forEach((x, i) => {
      if (x == null || !Number.isFinite(x)) return;
      acc!.sum[i] += x;
      acc!.n[i]++;
      acc!.max[i] = acc!.max[i] == null ? x : Math.max(acc!.max[i]!, x);
    });
  }
  return [...days.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, a]) => ({ ts, vals: a.sum.map((s, i) => (isMax[i] ? a.max[i] : a.n[i] ? s / a.n[i] : null)) }));
}

const pad = (n: number) => String(n).padStart(2, '0');
function fmtTime(ts: number, dateOnly = false) {
  const d = new Date(ts);
  const date = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  return dateOnly ? date : `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const fileDate = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
};
