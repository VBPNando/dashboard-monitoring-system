import { useEffect, useMemo, useState } from 'react';
import type { Alert, Connection, FortiThreats, ThreatDir, ThreatRow, ThreatTop } from '../types';
import { COUNTRIES, MAP_H, MAP_W, findCountry, project } from '../worldMap';
import { fmtAgo, fmtNum } from '../format';

/**
 * Peta Serangan FortiGate: serangan nyata ke/dari jaringan kantor dari log IPS, DoS & antivirus.
 * Tampilan gelap ala ruang kontrol (tidak ikut tema), cocok untuk layar NOC.
 */

type Filter = 'in' | 'out' | 'all';

const SEV: Record<string, { label: string; color: string; rank: number }> = {
  critical: { label: 'Kritis', color: '#f43f5e', rank: 4 },
  high: { label: 'Tinggi', color: '#fb923c', rank: 3 },
  medium: { label: 'Sedang', color: '#facc15', rank: 2 },
  low: { label: 'Rendah', color: '#38bdf8', rank: 1 },
  info: { label: 'Info', color: '#94a3b8', rank: 0 },
};
const SEV_BY_RANK = ['info', 'low', 'medium', 'high', 'critical'];
const sevOf = (s: string) => SEV[s] ?? SEV.info;

const KIND_LABEL: Record<string, string> = { IPS: 'Intrusi', DoS: 'DoS', Malware: 'Malware' };

const readDir = (): Filter => {
  try {
    const v = localStorage.getItem('dbmon.threatDir');
    return v === 'out' || v === 'all' ? v : 'in';
  } catch {
    return 'in';
  }
};

const hhmmss = (ts: number) => new Date(ts).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).replace(/\./g, ':');

const C = {
  bg: '#06110d',
  card: '#0a1a14',
  line: '#17362a',
  land: '#123528',
  landEdge: '#1c4a39',
  text: '#e6f4ee',
  muted: '#7fa596',
  accent: '#34d399',
};

export function ThreatView({ conn, data, alerts, fill }: { conn: Connection; data: FortiThreats | null | undefined; alerts: Alert[]; fill: boolean }) {
  const [dir, setDir] = useState<Filter>(readDir);
  const choose = (d: Filter) => {
    setDir(d);
    try {
      localStorage.setItem('dbmon.threatDir', d);
    } catch {
      /* abaikan */
    }
  };
  const want = (d: ThreatDir) => (dir === 'all' ? d !== 'lan' : d === dir);

  const stats = useMemo(() => {
    const rows = (data?.totals ?? []).filter((t) => want(t.dir));
    const total = rows.reduce((a, r) => a + r.n, 0);
    const blocked = rows.filter((r) => r.blocked).reduce((a, r) => a + r.n, 0);
    const serious = rows.filter((r) => r.severity === 'critical' || r.severity === 'high').reduce((a, r) => a + r.n, 0);
    const leaked = rows.filter((r) => !r.blocked && (r.severity === 'critical' || r.severity === 'high')).reduce((a, r) => a + r.n, 0);
    return { total, blocked, serious, leaked };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, dir]);

  const recent = (data?.recent ?? []).filter((r) => want(r.dir));
  const threatAlerts = alerts.filter((a) => a.rule.startsWith('fg_threat') || a.rule === 'fg_infected');

  return (
    <section
      className={`card-in flex min-w-0 flex-col overflow-hidden rounded-2xl ${fill ? 'h-full min-h-0' : ''}`}
      style={{ background: C.bg, color: C.text, boxShadow: `inset 0 0 0 1px ${C.line}` }}
    >
      {/* Judul + filter */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-3 pb-2">
        <span className="grid h-8 w-8 place-items-center rounded-lg text-[17px]" style={{ background: '#0f2c21', boxShadow: `inset 0 0 0 1px ${C.line}` }}>
          🛡
        </span>
        <div className="min-w-0">
          <h2 className="truncate text-[15px] leading-5 font-semibold">
            Peta Serangan <span style={{ color: C.muted }}>· {conn.name}</span>
          </h2>
          <p className="text-[11px]" style={{ color: C.muted }}>
            {data?.ok ? (
              <>
                <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full align-middle" style={{ background: C.accent }} />
                LIVE · log {data.device} · diperbarui {data.lastFetch ? fmtAgo(data.lastFetch) : '—'} · 24 jam terakhir
              </>
            ) : (
              'Log IPS, DoS & antivirus FortiGate'
            )}
          </p>
        </div>
        <span className="flex-1" />
        <div className="flex rounded-xl p-0.5 text-[12px] font-semibold" style={{ background: C.card, boxShadow: `inset 0 0 0 1px ${C.line}` }} role="tablist">
          {(
            [
              ['in', '⬇ Serangan masuk'],
              ['out', '⬆ Keluar'],
              ['all', 'Semua'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              role="tab"
              aria-selected={dir === k}
              onClick={() => choose(k)}
              className="rounded-lg px-3 py-1.5 transition"
              style={dir === k ? { background: '#14532d', color: '#d1fae5' } : { color: C.muted }}
            >
              {label}
              {k === 'out' && <span className="hidden font-normal opacity-80 sm:inline"> (malware/botnet)</span>}
            </button>
          ))}
        </div>
      </header>

      {!data ? (
        <Setup message="Peta serangan dimatikan untuk FortiGate ini. Aktifkan lewat menu ⋯ → hapus & tambah ulang dengan opsi Peta Serangan dicentang." />
      ) : !data.ok && data.message ? (
        <Setup message={data.message} />
      ) : (
        <>
          {/* Angka 24 jam */}
          <div className="grid grid-cols-2 gap-2 px-4 pb-2 sm:grid-cols-3 xl:grid-cols-6">
            <Stat label={dir === 'out' ? 'Deteksi keluar' : 'Serangan'} value={fmtNum(stats.total)} />
            <Stat label="Diblokir" value={stats.total ? `${fmtNum(Math.floor((stats.blocked / stats.total) * 1000) / 10)}%` : '—'} tone={stats.total && stats.blocked === stats.total ? C.accent : undefined} />
            <Stat label="Kritis + tinggi" value={fmtNum(stats.serious)} tone={stats.serious ? SEV.high.color : undefined} />
            <Stat label="Lolos (tidak diblokir)" value={fmtNum(stats.leaked)} tone={stats.leaked ? SEV.critical.color : C.accent} hint="Serangan kritis/tinggi yang hanya terdeteksi, tidak diblokir" />
            <Stat label="PC terindikasi malware" value={String(data.infected.length)} tone={data.infected.length ? SEV.critical.color : C.accent} />
            <Stat label="Sekarang" value={data.perMinute == null ? '—' : `${fmtNum(data.perMinute)}/mnt`} />
          </div>

          {threatAlerts.length > 0 && (
            <div className="mx-4 mb-2 rounded-xl px-3 py-2 text-[12px]" style={{ background: '#3b0d16', boxShadow: 'inset 0 0 0 1px #7f1d2d' }}>
              {threatAlerts.map((a) => (
                <p key={a.id} className="truncate">
                  <b style={{ color: a.severity === 'critical' ? '#fda4af' : '#fdba74' }}>{a.severity === 'critical' ? '⛔' : '⚠️'} {a.title}</b>{' '}
                  <span style={{ color: '#fecdd3' }}>{a.message}</span>
                </p>
              ))}
            </div>
          )}

          {/* Peta + daftar real-time */}
          <div className={`grid gap-3 px-4 pb-3 ${fill ? 'min-h-0 flex-1 lg:grid-cols-[minmax(0,1.9fr)_minmax(19rem,1fr)]' : 'lg:grid-cols-[minmax(0,1.9fr)_minmax(19rem,1fr)]'}`}>
            <WorldMap data={data} want={want} dir={dir} fill={fill} />
            <RealTime rows={recent} fill={fill} />
          </div>

          {/* Peringkat */}
          <div className="grid gap-3 px-4 pb-4 sm:grid-cols-3">
            {dir !== 'out' && <TopList title="Negara penyerang" rows={data.topCountries} />}
            <TopList title="Jenis serangan" rows={data.topAttacks} mono />
            {dir !== 'out' && <TopList title="Server kantor paling diserang" rows={data.topTargets} mono />}
            {dir !== 'in' && <TopList title="PC kantor terindikasi (keluar)" rows={data.infected} mono empty="Tidak ada ✓" />}
          </div>
        </>
      )}
    </section>
  );
}

function Stat({ label, value, tone, hint }: { label: string; value: string; tone?: string; hint?: string }) {
  return (
    <div className="rounded-xl px-3 py-2" style={{ background: C.card, boxShadow: `inset 0 0 0 1px ${C.line}` }} title={hint}>
      <div className="truncate text-[10px] font-medium tracking-wide uppercase" style={{ color: C.muted }}>
        {label}
      </div>
      <div className="tabular truncate text-[20px] leading-7 font-semibold" style={{ color: tone ?? C.text }}>
        {value}
      </div>
    </div>
  );
}

/** Peta dunia SVG dengan garis serangan beranimasi */
function WorldMap({ data, want, dir, fill }: { data: FortiThreats; want: (d: ThreatDir) => boolean; dir: Filter; fill: boolean }) {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    try {
      setReduce(window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch {
      /* abaikan */
    }
  }, []);

  const site = project(data.site.lon, data.site.lat);
  // Gabungkan per negara (arah masuk & keluar bisa sama-sama ada saat "Semua")
  const points = useMemo(() => {
    const acc = new Map<string, { key: string; name: string; x: number; y: number; id: string | null; n: number; sev: number; dir: ThreatDir }>();
    for (const c of data.countries) {
      if (!want(c.dir)) continue;
      const p = findCountry(c.country);
      if (!p) continue;
      const key = `${c.dir}:${p.id ?? p.name}`;
      const cur = acc.get(key);
      if (cur) {
        cur.n += c.n;
        cur.sev = Math.max(cur.sev, c.sev);
      } else {
        const [x, y] = project(p.lon, p.lat);
        acc.set(key, { key, name: c.country, x, y, id: p.id, n: c.n, sev: c.sev, dir: c.dir });
      }
    }
    return [...acc.values()].sort((a, b) => b.n - a.n);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, dir]);

  const max = Math.max(1, ...points.map((p) => p.n));
  const heat = new Map<string, number>();
  for (const p of points) if (p.id) heat.set(p.id, Math.max(heat.get(p.id) ?? 0, p.n / max));
  const arcs = points.slice(0, 14);
  // Label negara teratas, dilewati bila bertumpuk dengan label lain
  const labels: typeof points = [];
  for (const p of points.slice(0, 10)) {
    if (labels.length >= 6) break;
    if (labels.every((q) => Math.abs(q.x - p.x) > 95 || Math.abs(q.y - p.y) > 18)) labels.push(p);
  }

  return (
    <div className="relative min-h-[14rem] overflow-hidden rounded-xl" style={{ background: 'radial-gradient(120% 90% at 50% 40%, #0c2219 0%, #06110d 70%)', boxShadow: `inset 0 0 0 1px ${C.line}` }}>
      <svg viewBox={`0 0 ${MAP_W} ${MAP_H}`} className={fill ? 'absolute inset-0 h-full w-full' : 'block h-auto w-full'} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Peta asal serangan">
        <defs>
          <filter id="tglow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="2.2" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        {COUNTRIES.map((c) => {
          const h = heat.get(c.id);
          return (
            <path
              key={c.id + c.name}
              d={c.d}
              fill={h ? `rgba(244,63,94,${0.18 + h * 0.55})` : C.land}
              stroke={h ? 'rgba(251,113,133,0.55)' : C.landEdge}
              strokeWidth={0.5}
            >
              <title>{c.name}</title>
            </path>
          );
        })}

        {arcs.map((p, i) => {
          const from = p.dir === 'in' ? [p.x, p.y] : site;
          const to = p.dir === 'in' ? site : [p.x, p.y];
          const mx = (from[0] + to[0]) / 2;
          const my = (from[1] + to[1]) / 2;
          const dist = Math.hypot(to[0] - from[0], to[1] - from[1]);
          const d = `M${from[0].toFixed(1)},${from[1].toFixed(1)} Q${mx.toFixed(1)},${(my - dist * 0.32 - 8).toFixed(1)} ${to[0].toFixed(1)},${to[1].toFixed(1)}`;
          const col = sevOf(SEV_BY_RANK[p.sev] ?? 'info').color;
          const w = 0.8 + (p.n / max) * 2.2;
          const dur = 1.6 + (i % 5) * 0.35;
          return (
            <g key={p.key}>
              <path d={d} fill="none" stroke={col} strokeOpacity={0.22} strokeWidth={w + 1.5} />
              <path d={d} fill="none" stroke={col} strokeWidth={w} strokeLinecap="round" className="threat-arc" style={{ animationDuration: `${dur}s` }} />
              {!reduce && (
                <circle r={2.4 + w * 0.4} fill="#fff" filter="url(#tglow)" visibility="hidden">
                  <animateMotion dur={`${dur * 1.4}s`} repeatCount="indefinite" path={d} begin={`${((i * 0.37) % 2).toFixed(2)}s`} />
                  <set attributeName="visibility" to="visible" begin={`${((i * 0.37) % 2).toFixed(2)}s`} />
                </circle>
              )}
              <circle cx={p.x} cy={p.y} r={3} fill={col} />
              <circle cx={p.x} cy={p.y} r={3} fill="none" stroke={col} strokeWidth={1.2} className="threat-ripple" style={{ animationDelay: `${(i * 0.29) % 1.8}s` }} />
            </g>
          );
        })}

        {labels.map((p) => (
          <text
            key={'t' + p.key}
            x={p.x + 6}
            y={p.y - 6}
            fontSize={13}
            fontWeight={600}
            fill="#f1f5f9"
            stroke="#06110d"
            strokeWidth={3}
            paintOrder="stroke"
          >
            {p.name} <tspan fill="#fda4af">×{fmtNum(p.n)}</tspan>
          </text>
        ))}

        {/* Kantor */}
        <g>
          <circle cx={site[0]} cy={site[1]} r={5} fill={C.accent} filter="url(#tglow)" />
          <circle cx={site[0]} cy={site[1]} r={5} fill="none" stroke={C.accent} strokeWidth={1.5} className="threat-ripple" />
          <text x={site[0] + 8} y={site[1] + 16} fontSize={13} fontWeight={700} fill="#a7f3d0" stroke="#06110d" strokeWidth={3} paintOrder="stroke">
            {data.site.label}
          </text>
        </g>
      </svg>
      {!points.length && (
        <p className="absolute inset-x-0 bottom-3 text-center text-[12px]" style={{ color: C.muted }}>
          {dir === 'out' ? 'Tidak ada perangkat kantor yang menghubungi server berbahaya ✓' : 'Belum ada serangan tercatat 24 jam terakhir ✓'}
        </p>
      )}
      <div className="pointer-events-none absolute bottom-2 left-3 flex flex-wrap gap-x-3 gap-y-1 text-[10px]" style={{ color: C.muted }}>
        {['critical', 'high', 'medium', 'low'].map((k) => (
          <span key={k} className="flex items-center gap-1">
            <span className="h-[3px] w-3 rounded" style={{ background: SEV[k].color }} />
            {SEV[k].label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Daftar serangan terbaru, seperti "REAL-TIME ATTACKS" */
function RealTime({ rows, fill }: { rows: ThreatRow[]; fill: boolean }) {
  return (
    <div className={`flex min-h-0 flex-col overflow-hidden rounded-xl ${fill ? '' : 'max-h-[28rem]'}`} style={{ background: C.card, boxShadow: `inset 0 0 0 1px ${C.line}` }}>
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
        <h3 className="text-[12px] font-bold tracking-[0.12em]">REAL-TIME</h3>
        <span className="text-[11px]" style={{ color: C.muted }}>
          {new Date().toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short' })}
        </span>
      </div>
      {!rows.length ? (
        <p className="px-3 py-6 text-center text-[12px]" style={{ color: C.muted }}>
          Belum ada kejadian
        </p>
      ) : (
        <ul className="thin-scroll min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
          {rows.map((r) => {
            const s = sevOf(r.severity);
            const blocked = !!r.blocked;
            return (
              <li
                key={`${r.ts}-${r.dir}-${r.name}-${r.remoteIp}-${r.localIp}-${r.blocked}`}
                className="row-in grid grid-cols-[3.6rem_minmax(0,1fr)_auto] gap-x-2 rounded-lg px-1.5 py-1.5"
                style={{ borderBottom: `1px solid ${C.line}` }}
                title={`${KIND_LABEL[r.kind] ?? r.kind} · aksi FortiGate: ${r.action || '-'}${r.port ? ` · port ${r.port}` : ''}`}
              >
                <span className="tabular pt-0.5 text-[11px]" style={{ color: C.muted }}>
                  {hhmmss(r.ts)}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[12px] font-semibold" style={{ color: '#86efac' }}>
                    {r.count > 1 && (
                      <span className="mr-1 rounded-full px-1.5 text-[10px] font-bold" style={{ color: '#fde68a', boxShadow: 'inset 0 0 0 1px #a16207' }}>
                        ×{r.count}
                      </span>
                    )}
                    {r.name}
                  </span>
                  <span className="block truncate text-[11px]" style={{ color: C.muted }}>
                    {r.dir === 'in' ? (
                      <>
                        <span style={{ color: '#fca5a5' }}>{r.country || 'Tidak diketahui'}</span> {r.remoteIp} → {r.localIp}
                        {r.port ? `:${r.port}` : ''}
                      </>
                    ) : r.dir === 'out' ? (
                      <>
                        PC {r.localIp} → <span style={{ color: '#fca5a5' }}>{r.country || '?'}</span> {r.remoteIp}
                      </>
                    ) : (
                      <>
                        LAN {r.remoteIp} → {r.localIp}
                      </>
                    )}
                  </span>
                </span>
                <span className="flex flex-col items-end gap-0.5">
                  <span className="rounded-full px-2 text-[10px] font-bold" style={{ color: s.color, boxShadow: `inset 0 0 0 1px ${s.color}88` }}>
                    {s.label}
                  </span>
                  <span className="text-[10px] font-semibold" style={{ color: blocked ? '#6ee7b7' : '#fda4af' }}>
                    {blocked ? '✓ diblokir' : '! lolos'}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function TopList({ title, rows, mono, empty }: { title: string; rows: ThreatTop[]; mono?: boolean; empty?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return (
    <div className="rounded-xl px-3 py-2" style={{ background: C.card, boxShadow: `inset 0 0 0 1px ${C.line}` }}>
      <h4 className="mb-1 text-[10px] font-semibold tracking-wide uppercase" style={{ color: C.muted }}>
        {title}
      </h4>
      {!rows.length ? (
        <p className="py-1 text-[12px]" style={{ color: C.muted }}>
          {empty ?? '—'}
        </p>
      ) : (
        <ul className="space-y-1">
          {rows.slice(0, 5).map((r) => (
            <li key={r.k} className="grid grid-cols-[minmax(0,1fr)_3.5rem] items-center gap-2 text-[12px]">
              <span className="relative min-w-0">
                <span className="absolute inset-y-0 left-0 rounded" style={{ width: `${(r.n / max) * 100}%`, background: `${sevOf(SEV_BY_RANK[r.sev] ?? 'info').color}26` }} />
                <span className={`relative block truncate px-1.5 ${mono ? 'font-mono text-[11px]' : ''}`}>{r.k}</span>
              </span>
              <span className="tabular text-right font-semibold">{fmtNum(r.n)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Setup({ message }: { message: string }) {
  return (
    <div className="m-4 rounded-xl p-4 text-[13px] leading-relaxed" style={{ background: C.card, boxShadow: `inset 0 0 0 1px ${C.line}` }}>
      <p className="font-semibold" style={{ color: '#fde68a' }}>
        ⚠️ {message}
      </p>
      <p className="mt-3 font-semibold">Yang perlu disiapkan di FortiGate:</p>
      <ol className="mt-1 list-decimal space-y-1 pl-5" style={{ color: '#cde7dc' }}>
        <li>
          <b>System → Admin Profiles</b> → profil admin API (mis. <code>admin_monitor</code>) → <b>Log &amp; Report: Read</b>.
        </li>
        <li>
          <b>Log &amp; Report → Log Settings</b>: aktifkan log ke <b>Disk</b> (bila ada) atau <b>Memory</b>.
        </li>
        <li>
          <b>Policy &amp; Objects → Firewall Policy</b>: pada policy dari internet ke server kantor (VIP/port-forward) dan dari LAN ke
          internet, aktifkan <b>IPS</b> (dan Antivirus bila ada lisensi), lalu <b>Log Allowed Traffic: Security Events</b>.
        </li>
        <li>Tunggu ±1 menit: peta terisi otomatis.</li>
      </ol>
    </div>
  );
}
