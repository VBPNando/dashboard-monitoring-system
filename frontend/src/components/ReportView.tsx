import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../api';
import { ENGINE_META, STATUS, type Connection, type SlaStat } from '../types';
import { fmtBytes, fmtDur, fmtNum } from '../format';

type Unit = '%' | 'ms' | 'B/s' | '°C' | '' | 'qps';
interface SourceReport {
  id: string;
  name: string;
  engine: Connection['engine'];
  engineLabel: string;
  host: string;
  coveragePct: number;
  rows: { label: string; unit: Unit; avg: number | null; max: number | null }[];
  totals: { label: string; value: number | null }[];
  alerts: {
    critical: number;
    warning: number;
    downtimeMs: number;
    list: { id: string; rule: string; severity: 'critical' | 'warning'; title: string; message: string | null; start: number; end: number | null; durationMs: number }[];
  };
  sla?: SlaStat;
  slaTarget?: number;
  incidents?: { id: number; start: number; end: number | null; reason: string | null; durationMs: number; ongoing: boolean }[];
}
interface Report {
  from: number;
  to: number;
  generatedAt: number;
  sources: SourceReport[];
}

type Preset = 'today' | 'yesterday' | '7d' | '30d' | 'month' | 'prevMonth' | 'custom';
const PRESETS: { key: Preset; label: string }[] = [
  { key: 'today', label: 'Hari ini' },
  { key: 'yesterday', label: 'Kemarin' },
  { key: '7d', label: '7 hari terakhir' },
  { key: '30d', label: '30 hari terakhir' },
  { key: 'month', label: 'Bulan ini' },
  { key: 'prevMonth', label: 'Bulan lalu' },
  { key: 'custom', label: 'Pilih tanggal…' },
];

const day0 = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function periodOf(p: Preset, customFrom: string, customTo: string): [number, number] {
  const now = new Date();
  const today = day0(now).getTime();
  switch (p) {
    case 'today':
      return [today, now.getTime()];
    case 'yesterday':
      return [today - 86400_000, today];
    case '7d':
      return [now.getTime() - 7 * 86400_000, now.getTime()];
    case '30d':
      return [now.getTime() - 30 * 86400_000, now.getTime()];
    case 'month':
      return [new Date(now.getFullYear(), now.getMonth(), 1).getTime(), now.getTime()];
    case 'prevMonth':
      return [new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(), new Date(now.getFullYear(), now.getMonth(), 1).getTime()];
    case 'custom': {
      const f = new Date(`${customFrom}T00:00:00`).getTime();
      const t = new Date(`${customTo}T00:00:00`).getTime() + 86400_000; // sampai akhir hari terpilih
      return [f, Math.min(t, now.getTime())];
    }
  }
}

const when = (ts: number, withTime = true) =>
  new Date(ts).toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) });

function fmtVal(v: number | null, unit: Unit) {
  if (v == null) return '—';
  switch (unit) {
    case '%':
      return `${fmtNum(v)}%`;
    case 'ms':
      return `${fmtNum(v)} ms`;
    case '°C':
      return `${fmtNum(v)}°C`;
    case 'B/s':
      return `${fmtBytes(v)}/dtk`;
    default:
      return fmtNum(v);
  }
}

/** Tab Laporan: ringkasan periode per sumber, cetak/PDF, dan unduh CSV untuk Excel. */
export function ReportView({ conns }: { conns: Connection[] }) {
  const [preset, setPreset] = useState<Preset>(() => {
    try {
      return (localStorage.getItem('dbmon.report.preset') as Preset) || 'month';
    } catch {
      return 'month';
    }
  });
  const [cFrom, setCFrom] = useState(() => isoDate(new Date(Date.now() - 7 * 86400_000)));
  const [cTo, setCTo] = useState(() => isoDate(new Date()));
  const [picked, setPicked] = useState<Set<string> | null>(null); // null = semua
  const [res, setRes] = useState<'hour' | 'day' | 'minute'>('hour');
  const [fmt, setFmt] = useState<'id' | 'en'>(() => {
    try {
      return (localStorage.getItem('dbmon.report.fmt') as 'id' | 'en') || 'id';
    } catch {
      return 'id';
    }
  });
  const [data, setData] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const ids = useMemo(() => conns.filter((c) => !picked || picked.has(c.id)).map((c) => c.id), [conns, picked]);
  const [from, to] = periodOf(preset, cFrom, cTo);
  const valid = from < to && ids.length > 0;
  const qs = `ids=${ids.join(',')}&from=${Math.round(from)}&to=${Math.round(to)}`;
  const tooLongForMinute = to - from > 7 * 86400_000;

  const load = async () => {
    if (!valid) return;
    setBusy(true);
    setErr('');
    try {
      const r = await apiFetch(`/api/report/summary?${qs}`);
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? 'Gagal memuat laporan');
      setData(body);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Cetak selalu dengan tema terang (hemat tinta & terbaca di kertas)
  useEffect(() => {
    const root = document.documentElement;
    let wasDark = false;
    const before = () => {
      wasDark = root.classList.contains('dark');
      root.classList.remove('dark');
    };
    const after = () => wasDark && root.classList.add('dark');
    window.addEventListener('beforeprint', before);
    window.addEventListener('afterprint', after);
    return () => {
      window.removeEventListener('beforeprint', before);
      window.removeEventListener('afterprint', after);
    };
  }, []);

  // Muat otomatis saat periode / sumber berubah
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qs]);

  const save = (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* abaikan */
    }
  };

  const download = () => {
    const a = document.createElement('a');
    a.href = `/api/report/csv?${qs}&res=${res === 'minute' && tooLongForMinute ? 'hour' : res}&fmt=${fmt}`;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const toggle = (id: string) =>
    setPicked((p) => {
      const s = new Set(p ?? conns.map((c) => c.id));
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return s.size === conns.length ? null : s;
    });

  const ctl = 'rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 outline-none focus:border-sky-500';

  return (
    <div className="report mx-auto grid max-w-[1200px] grid-cols-[minmax(0,1fr)] gap-4">
      {/* Kontrol (tidak ikut tercetak) */}
      <section className="no-print grid gap-3 rounded-2xl bg-white p-4 ring-1 ring-slate-200/70">
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1">
            <span className="text-[11px] font-medium text-slate-500">Periode</span>
            <select className={ctl} value={preset} onChange={(e) => (setPreset(e.target.value as Preset), save('dbmon.report.preset', e.target.value))}>
              {PRESETS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          {preset === 'custom' && (
            <>
              <label className="grid gap-1">
                <span className="text-[11px] font-medium text-slate-500">Dari tanggal</span>
                <input type="date" className={ctl} value={cFrom} max={cTo} onChange={(e) => setCFrom(e.target.value)} />
              </label>
              <label className="grid gap-1">
                <span className="text-[11px] font-medium text-slate-500">Sampai tanggal</span>
                <input type="date" className={ctl} value={cTo} min={cFrom} max={isoDate(new Date())} onChange={(e) => setCTo(e.target.value)} />
              </label>
            </>
          )}
          <span className="flex-1" />
          <button onClick={() => window.print()} disabled={!data} className="rounded-xl px-4 py-1.5 text-sm font-medium text-slate-700 ring-1 ring-slate-200 transition hover:bg-slate-50 disabled:opacity-50">
            🖨 Cetak / Simpan PDF
          </button>
        </div>

        <div>
          <p className="mb-1.5 text-[11px] font-medium text-slate-500">
            Sumber ({ids.length}/{conns.length}) ·{' '}
            <button className="text-sky-700 hover:underline" onClick={() => setPicked(null)}>
              semua
            </button>{' '}
            ·{' '}
            <button className="text-sky-700 hover:underline" onClick={() => setPicked(new Set())}>
              kosongkan
            </button>
          </p>
          <div className="flex flex-wrap gap-1.5">
            {conns.map((c) => {
              const on = !picked || picked.has(c.id);
              return (
                <button
                  key={c.id}
                  onClick={() => toggle(c.id)}
                  className={`rounded-full px-2.5 py-1 text-[12px] font-medium ring-1 transition ${on ? 'bg-sky-50 text-sky-800 ring-sky-200' : 'text-slate-400 ring-slate-200 hover:text-slate-600'}`}
                >
                  {on ? '✓ ' : ''}
                  {c.name} <span className="font-normal opacity-70">{ENGINE_META[c.engine].label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3">
          <span className="self-center text-sm font-semibold text-slate-700">Unduh data (CSV untuk Excel):</span>
          <select className={ctl} value={res} onChange={(e) => setRes(e.target.value as typeof res)} aria-label="Resolusi">
            <option value="hour">Per jam</option>
            <option value="day">Per hari</option>
            <option value="minute" disabled={tooLongForMinute}>
              Per menit{tooLongForMinute ? ' (maks. 7 hari)' : ''}
            </option>
          </select>
          <select className={ctl} value={fmt} onChange={(e) => (setFmt(e.target.value as 'id' | 'en'), save('dbmon.report.fmt', e.target.value))} aria-label="Format angka">
            <option value="id">Excel Indonesia (1,5 ; )</option>
            <option value="en">Excel English (1.5 , )</option>
          </select>
          <button onClick={download} disabled={!valid} className="rounded-xl bg-sky-600 px-4 py-1.5 text-sm font-semibold text-onaccent shadow-sm transition hover:bg-sky-700 disabled:opacity-50">
            ⬇ Unduh CSV
          </button>
          <span className="text-[11px] text-slate-400">Riwayat per menit disimpan 31 hari, per jam ±13 bulan.</span>
        </div>
      </section>

      {err && <p className="no-print rounded-xl bg-rose-50 px-4 py-2 text-sm text-rose-700">{err}</p>}
      {!ids.length && <p className="no-print text-center text-sm text-slate-500">Pilih minimal satu sumber.</p>}

      {/* Laporan (ini yang tercetak) */}
      {data && ids.length > 0 && (
        <article className={`grid grid-cols-[minmax(0,1fr)] gap-4 ${busy ? 'opacity-60' : ''}`}>
          <header className="rounded-2xl bg-white px-5 py-4 ring-1 ring-slate-200/70">
            <h2 className="text-lg font-semibold text-slate-900">Laporan Monitoring</h2>
            <p className="text-sm text-slate-600">
              Periode <b>{when(data.from)}</b> s/d <b>{when(data.to)}</b> · {PRESETS.find((p) => p.key === preset)?.label}
            </p>
            <p className="text-[11px] text-slate-400">Dibuat {when(data.generatedAt)} · Dashboard Monitoring System</p>
            <SummaryTable sources={data.sources} />
          </header>
          {data.sources.map((s) => (
            <SourceCard key={s.id} s={s} />
          ))}
        </article>
      )}
    </div>
  );
}

/** Tabel ringkas semua sumber di bagian atas laporan */
function SummaryTable({ sources }: { sources: SourceReport[] }) {
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-left text-[10px] tracking-wide text-slate-400 uppercase">
            <th className="py-1 font-medium">Sumber</th>
            <th className="py-1 font-medium">Jenis</th>
            <th className="py-1 text-right font-medium">Data terpantau</th>
            <th className="py-1 text-right font-medium">Terputus</th>
            <th className="py-1 text-right font-medium">Alert kritis</th>
            <th className="py-1 text-right font-medium">Alert waspada</th>
            <th className="py-1 text-right font-medium">SLA</th>
          </tr>
        </thead>
        <tbody>
          {sources.map((s) => {
            const below = s.sla?.uptimePct != null && s.sla.uptimePct < (s.slaTarget ?? 99.5);
            return (
              <tr key={s.id} className="border-t border-slate-100">
                <td className="py-1 font-medium text-slate-800">{s.name}</td>
                <td className="py-1 text-slate-500">{s.engineLabel}</td>
                <td className="tabular py-1 text-right text-slate-700">{fmtNum(s.coveragePct)}%</td>
                <td className="tabular py-1 text-right" style={{ color: s.alerts.downtimeMs ? STATUS.critical : undefined }}>
                  {s.alerts.downtimeMs ? fmtDur(s.alerts.downtimeMs) : '—'}
                </td>
                <td className="tabular py-1 text-right" style={{ color: s.alerts.critical ? STATUS.critical : undefined }}>{s.alerts.critical}</td>
                <td className="tabular py-1 text-right" style={{ color: s.alerts.warning ? STATUS.warning : undefined }}>{s.alerts.warning}</td>
                <td className="tabular py-1 text-right font-semibold" style={{ color: s.sla?.uptimePct == null ? undefined : below ? STATUS.critical : STATUS.good }}>
                  {s.sla?.uptimePct == null ? '—' : `${s.sla.uptimePct.toFixed(3)}%`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SourceCard({ s }: { s: SourceReport }) {
  const [all, setAll] = useState(false);
  const alerts = all ? s.alerts.list : s.alerts.list.slice(0, 8);
  const sla = s.sla;
  const target = s.slaTarget ?? 99.5;
  return (
    <section className="report-card rounded-2xl bg-white px-5 py-4 ring-1 ring-slate-200/70">
      <header className="flex flex-wrap items-baseline gap-x-2">
        <h3 className="text-[15px] font-semibold text-slate-900">{s.name}</h3>
        <span className="text-xs text-slate-500">
          {s.engineLabel} · {s.host}
        </span>
        <span className="ml-auto text-[11px] text-slate-400">Data terpantau {fmtNum(s.coveragePct)}% dari periode</span>
      </header>

      <div className="mt-3 grid gap-4 md:grid-cols-2 print:grid-cols-2">
        <div>
          {sla && (
            <div className="mb-3 grid grid-cols-3 gap-2">
              <Stat label={`Uptime (target ${target}%)`} value={sla.uptimePct == null ? '—' : `${sla.uptimePct.toFixed(3)}%`} tone={sla.uptimePct == null ? undefined : sla.uptimePct < target ? STATUS.critical : STATUS.good} />
              <Stat label="Total downtime" value={fmtDur(sla.downtimeMs)} />
              <Stat label="Gangguan" value={String(sla.incidents)} />
              <Stat label="Packet loss" value={sla.lossPct == null ? '—' : `${fmtNum(sla.lossPct)}%`} />
              <Stat label="Latency rata-rata" value={sla.latencyAvg == null ? '—' : `${Math.round(sla.latencyAvg)} ms`} />
              <Stat label="Terpantau" value={`${fmtNum(sla.coveragePct)}%`} />
            </div>
          )}
          {s.rows.length ? (
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left text-[10px] tracking-wide text-slate-400 uppercase">
                  <th className="py-1 font-medium">Metrik</th>
                  <th className="py-1 text-right font-medium">Rata-rata</th>
                  <th className="py-1 text-right font-medium">Tertinggi</th>
                </tr>
              </thead>
              <tbody>
                {s.rows.map((r) => (
                  <tr key={r.label} className="border-t border-slate-100">
                    <td className="py-1 text-slate-700">{r.label}</td>
                    <td className="tabular py-1 text-right text-slate-800">{fmtVal(r.avg, r.unit)}</td>
                    <td className="tabular py-1 text-right font-semibold text-slate-800">{fmtVal(r.max, r.unit)}</td>
                  </tr>
                ))}
                {s.totals
                  .filter((t) => t.value != null)
                  .map((t) => (
                    <tr key={t.label} className="border-t border-slate-100">
                      <td className="py-1 text-slate-700">{t.label}</td>
                      <td className="tabular py-1 text-right font-semibold text-slate-800" colSpan={2}>
                        {Math.round(t.value!).toLocaleString('id-ID')}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-slate-400">Belum ada data tersimpan di periode ini.</p>
          )}
        </div>

        <div className="min-w-0">
          {s.incidents && s.incidents.length > 0 && (
            <>
              <h4 className="mb-1 text-[12px] font-semibold text-slate-700">Gangguan ISP ({s.incidents.length})</h4>
              <ul className="mb-3 space-y-0.5 text-[12px]">
                {s.incidents.slice(0, 10).map((i) => (
                  <li key={i.id} className="flex gap-2">
                    <span className="tabular text-slate-500">{when(i.start)}</span>
                    <span className="min-w-0 flex-1 truncate text-slate-600">{i.reason}</span>
                    <b className="tabular" style={{ color: STATUS.critical }}>
                      {i.ongoing ? 'berlangsung' : fmtDur(i.durationMs)}
                    </b>
                  </li>
                ))}
              </ul>
            </>
          )}
          <h4 className="mb-1 text-[12px] font-semibold text-slate-700">
            Riwayat alert{' '}
            <span className="font-normal text-slate-400">
              ({s.alerts.critical} kritis · {s.alerts.warning} waspada)
            </span>
          </h4>
          {!s.alerts.list.length ? (
            <p className="text-[12px] text-slate-400">Tidak ada alert di periode ini ✓</p>
          ) : (
            <ul className="space-y-0.5 text-[12px]">
              {alerts.map((a) => (
                <li key={a.id} className="grid grid-cols-[1rem_minmax(0,1fr)_auto] gap-1.5" title={a.message ?? ''}>
                  <span>{a.severity === 'critical' ? '⛔' : '⚠️'}</span>
                  <span className="min-w-0">
                    <span className="block truncate text-slate-800">{a.title}</span>
                    <span className="block text-[10px] text-slate-400">
                      {when(a.start)}
                      {a.end ? ` – ${when(a.end)}` : ' · masih aktif'}
                    </span>
                  </span>
                  <span className="tabular text-slate-600">{fmtDur(a.durationMs)}</span>
                </li>
              ))}
            </ul>
          )}
          {s.alerts.list.length > 8 && (
            <button className="no-print mt-1 text-[12px] text-sky-700 hover:underline" onClick={() => setAll((x) => !x)}>
              {all ? 'Ringkas' : `Tampilkan semua (${s.alerts.list.length})`}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg bg-slate-50 px-2.5 py-1.5 ring-1 ring-slate-200/60">
      <div className="truncate text-[10px] text-slate-500">{label}</div>
      <div className="tabular text-[15px] font-semibold text-slate-900" style={{ color: tone }}>
        {value}
      </div>
    </div>
  );
}
