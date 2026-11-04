import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ENGINE_META,
  STATUS,
  cpuOf,
  memOf,
  type AlertSnapshot,
  type ChartPoint,
  type Connection,
  type ConnStatus,
  type Details,
  type MetricPoint,
} from '../types';
import { fmtBytes, fmtMs, fmtNum } from '../format';
import { Kpi, levelOf } from './Kpi';
import { useTheme } from '../theme';
import { TimeChart, type SeriesDef } from './TimeChart';
import { Alerts, Sessions, SlowQueries, TabbedLists } from './Lists';

interface Props {
  conn: Connection;
  /** Titik per-detik terbaru (angka KPI selalu dari sini) */
  live: MetricPoint[];
  /** Titik yang digambar di grafik: live atau ringkasan rentang waktu */
  points: ChartPoint[];
  isLive: boolean;
  status?: { status: ConnStatus; message?: string };
  details?: Details;
  alerts?: AlertSnapshot;
  onDelete: (id: string) => void;
  onAgent: (c: Connection) => void;
  /** Mode dinding: panel mengisi sel grid setinggi layar */
  fill: boolean;
}

// Definisi seri stabil (dibuat sekali) supaya grafik tidak dibangun ulang tiap detik
const THROUGHPUT: SeriesDef[] = [
  { name: 'QPS', type: 'bar', color: 's1', value: (p) => p.qps },
  { name: 'TPS', type: 'line', color: 's2', value: (p) => p.tps },
];
const LATENCY: SeriesDef[] = [
  { name: 'Rata-rata', type: 'line', color: 's1', value: (p) => p.latencyAvgMs },
  { name: 'Maks', type: 'line', color: 's2', value: (p) => p.latencyMaxMs },
];
const fmtPerSec = (v: number) => fmtNum(v);

type Health = 'down' | 'critical' | 'warning' | 'healthy' | 'connecting';
export function healthOf(st: ConnStatus, alerts?: AlertSnapshot): Health {
  if (st === 'error') return 'down';
  if (st === 'connecting') return 'connecting';
  if (alerts?.active.some((a) => a.severity === 'critical')) return 'critical';
  if (alerts?.active.length) return 'warning';
  return 'healthy';
}

export const HEALTH_UI: Record<Health, { label: string; color: string; icon: string }> = {
  healthy: { label: 'Sehat', color: STATUS.good, icon: '✓' },
  warning: { label: 'Waspada', color: STATUS.warning, icon: '▲' },
  critical: { label: 'Kritis', color: STATUS.critical, icon: '●' },
  down: { label: 'Terputus', color: STATUS.critical, icon: '✕' },
  connecting: { label: 'Menghubungkan', color: '#94a3b8', icon: '…' },
};

export function DbPanel({ conn, live, points, isLive, status, details, alerts, onDelete, onAgent, fill }: Props) {
  const { palette } = useTheme();
  const last = live.at(-1);
  const st = status?.status ?? conn.status ?? 'connecting';
  const health = healthOf(st, alerts);
  const hu = HEALTH_UI[health];
  const meta = ENGINE_META[conn.engine];
  const isSqlite = conn.engine === 'sqlite';
  const hasAgent = last ? last.agentStatus !== 'none' : !!conn.hasAgent;
  const agentOk = last?.agentStatus === 'ok';

  // Sparkline memakai 60 titik terakhir dari data grafik
  const sp = points.slice(-60);
  const cpu = last?.host?.cpuPct;
  const mem = last?.host?.memPct;
  const total = last?.totalConnections;
  const maxC = last?.maxConnections;
  const connPct = total != null && maxC ? (total / maxC) * 100 : null;
  const rw = last?.reads != null || last?.writes != null ? (last?.reads ?? 0) + (last?.writes ?? 0) : null;
  const rwUnit = last?.rwUnit === 'pages' ? 'hal/dtk' : last?.rwUnit === 'rows' ? 'baris/dtk' : 'ops/dtk';

  // Mode ringkas: panel pendek (mis. 4 database di laptop 1366×768) → daftar digabung jadi tab di samping grafik
  const ref = useRef<HTMLElement>(null);
  const height = useHeight(ref);
  const compact = fill && height > 0 && height < 400;

  const agentHint = !hasAgent
    ? 'CPU & RAM butuh Monitoring Agent di server database. Klik ⋯ → Atur agen.'
    : !agentOk
      ? 'Agen tidak terjangkau — lihat Alert.'
      : undefined;

  return (
    <article
      ref={ref}
      className={`card-in flex min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-slate-50/70 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_12px_32px_-16px_rgba(15,23,42,0.18)] backdrop-blur ${
        fill ? 'h-full min-h-0 gap-2 p-2.5' : 'gap-3 p-3'
      }`}
    >
      {/* ── Judul ── */}
      <header className="flex shrink-0 items-center gap-2 px-1">
        <h2 className="min-w-0 truncate text-[15px] font-semibold text-slate-900">
          <span className="font-normal text-slate-500">Database: </span>
          {conn.name}
        </h2>
        <span className="hidden truncate text-xs text-slate-400 sm:inline">
          {isSqlite ? conn.filePath : `${conn.host}:${conn.port}`}
        </span>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${meta.color}`}>{meta.label}</span>
        <span className="flex-1" />
        <span className="flex shrink-0 items-center gap-1.5 text-xs font-semibold" style={{ color: hu.color }} title={status?.message}>
          <StatusDot health={health} />
          {hu.label}
        </span>
        <PanelMenu onAgent={() => onAgent(conn)} onDelete={() => onDelete(conn.id)} name={conn.name} hasAgent={hasAgent} />
      </header>

      {st === 'error' && status?.message && (
        <p className="shrink-0 truncate rounded-lg bg-rose-50 px-3 py-1.5 text-xs text-rose-700" title={status.message}>
          {status.message}
        </p>
      )}

      {isSqlite ? (
        <SqliteBody last={last} />
      ) : (
        <div
          className={
            !fill
              ? 'grid gap-3'
              : compact
                ? 'grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-2'
                : 'grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1.15fr)_minmax(0,1fr)] gap-2'
          }
        >
          {/* ── 6 KPI ── */}
          <div className="grid grid-cols-3 gap-2 lg:grid-cols-6">
            <Kpi
              index={1}
              label="CPU Usage"
              value={agentOk ? cpu : null}
              text={agentOk ? undefined : '—'}
              unit={agentOk ? '%' : undefined}
              suffix={!hasAgent && <InstallAgent onClick={() => onAgent(conn)} />}
              spark={agentOk ? sp.map(cpuOf) : undefined}
              sparkMax={100}
              color="s1"
              level={levelOf(cpu, 80, 90)}
              hint={agentHint}
            />
            <Kpi
              index={2}
              label="Memory Usage"
              value={agentOk ? mem : null}
              text={agentOk ? undefined : '—'}
              unit={agentOk ? '%' : undefined}
              suffix={!hasAgent && <InstallAgent onClick={() => onAgent(conn)} />}
              spark={agentOk ? sp.map(memOf) : undefined}
              sparkMax={100}
              color="s1"
              level={levelOf(mem, 85, 95)}
              hint={
                agentOk && last?.host?.memUsedBytes
                  ? `${fmtBytes(last.host.memUsedBytes)} dari ${fmtBytes(last.host.memTotalBytes)}`
                  : agentHint
              }
            />
            <Kpi
              index={3}
              label="Koneksi"
              value={total}
              suffix={maxC ? <span className="text-sm font-medium text-slate-400">/{fmtNum(maxC)}</span> : undefined}
              spark={sp.map((p) => p.totalConnections)}
              color="s1"
              level={levelOf(connPct, 75, 90)}
              hint={`Total koneksi terbuka / batas max_connections. Sedang mengeksekusi query: ${fmtNum(last?.activeConnections)}`}
            />
            <Kpi
              index={4}
              label="Read/Write Ops"
              value={rw}
              unit={undefined}
              suffix={<span className="ml-1 text-[11px] font-medium text-slate-400">{rwUnit}</span>}
              spark={sp.map((p) => p.reads)}
              spark2={sp.map((p) => p.writes)}
              color="s1"
              color2="s2"
              hint={`Read ${fmtNum(last?.reads)} · Write ${fmtNum(last?.writes)} ${rwUnit} (biru = read, oranye = write)`}
            />
            <Kpi
              index={5}
              label="QPS"
              value={last?.qps}
              suffix={<span className="ml-1 text-[11px] font-medium text-slate-400">/dtk</span>}
              spark={sp.map((p) => p.qps)}
              color="s1"
              dot="s1"
              hint={
                last?.extra?.qpsSourceIsTps
                  ? 'pg_stat_statements belum aktif: QPS sama dengan TPS'
                  : 'Query per detik (batang biru di grafik Throughput)'
              }
            />
            <Kpi
              index={6}
              label="TPS"
              value={last?.tps}
              suffix={<span className="ml-1 text-[11px] font-medium text-slate-400">/dtk</span>}
              spark={sp.map((p) => p.tps)}
              color="s2"
              dot="s2"
              hint="Transaksi per detik (garis oranye di grafik Throughput)"
            />
          </div>

          {/* ── 2 grafik ── */}
          <div className={`grid gap-2 ${compact ? 'min-h-0 grid-cols-[1fr_1fr_0.85fr]' : 'lg:grid-cols-2'} ${fill ? 'min-h-0' : ''}`}>
            <ChartCard
              fill={fill}
              // "QPS" biru = batang, "TPS" oranye = garis → judul sekaligus keterangan grafik
              title={
                <>
                  Throughput (<span style={{ color: palette.s1 }}>QPS</span>/<span style={{ color: palette.s2 }}>TPS</span>)
                </>
              }
              legendNode={
                last?.ops ? (
                  <span
                    className="tabular truncate text-[11px] text-slate-500"
                    title={last.opsUnit === 'rows' ? 'Per detik, dihitung per baris' : 'Perintah per detik'}
                  >
                    SEL <b className="text-slate-800">{fmtNum(last.ops.select)}</b> · INS{' '}
                    <b className="text-slate-800">{fmtNum(last.ops.insert)}</b> · UPD{' '}
                    <b className="text-slate-800">{fmtNum(last.ops.update)}</b> · DEL{' '}
                    <b className="text-slate-800">{fmtNum(last.ops.delete)}</b>
                  </span>
                ) : undefined
              }
            >
              <TimeChart label="Grafik throughput" series={THROUGHPUT} points={points} format={fmtPerSec} live={isLive} />
            </ChartCard>
            <ChartCard
              fill={fill}
              title="Query Latency"
              legend={[
                { label: 'Rata-rata', color: palette.s1 },
                { label: 'Maks', color: palette.s2 },
              ]}
              right={
                <span className="tabular shrink-0 text-[11px] text-slate-500">
                  Rata² <b className="text-slate-800">{fmtMs(last?.latencyAvgMs)}</b> · Maks{' '}
                  <b className="text-slate-800">{fmtMs(last?.latencyMaxMs)}</b>
                </span>
              }
              hint={
                last?.latencySource === 'running'
                  ? 'Statistik query tidak aktif: latency dihitung dari query yang sedang berjalan saat dicek (perkiraan).'
                  : 'Rata-rata semua query yang selesai; Maks = query terlama yang sedang berjalan.'
              }
            >
              <TimeChart label="Grafik latency" series={LATENCY} points={points} format={fmtMs} live={isLive} />
            </ChartCard>
            {compact && <TabbedLists details={details} snap={alerts} />}
          </div>

          {/* ── Slow queries · Sesi & lock · Alert ── */}
          {!compact && (
            <div className={`grid gap-2 lg:grid-cols-[1.1fr_1.25fr_0.95fr] ${fill ? 'min-h-0' : '[&>*]:h-52'}`}>
              <SlowQueries details={details} />
              <Sessions details={details} />
              <Alerts snap={alerts} />
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function ChartCard({
  title,
  legend = [],
  legendNode,
  right,
  hint,
  fill,
  children,
}: {
  title: ReactNode;
  legend?: { label: string; color: string; bar?: boolean }[];
  /** Isi bebas di posisi legenda (mis. SEL/INS/UPD/DEL) */
  legendNode?: ReactNode;
  right?: ReactNode;
  hint?: string;
  fill: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className={`flex min-w-0 flex-col rounded-xl bg-white px-2 pt-1.5 pb-1 ring-1 ring-slate-200/70 ${fill ? 'min-h-0' : 'h-60'}`}
      title={hint}
    >
      <header className="flex shrink-0 items-center gap-3 overflow-hidden px-1">
        <h3 className="shrink-0 text-[13px] font-semibold text-slate-800">{title}</h3>
        <span className="flex min-w-0 items-center gap-2.5 overflow-hidden">
          {legendNode}
          {legend.map((l) => (
            <span key={l.label} className="flex shrink-0 items-center gap-1 text-[10px] text-slate-500">
              <span
                className={l.bar ? 'h-2 w-2 rounded-[2px]' : 'h-[3px] w-3 rounded-full'}
                style={{ background: l.color }}
                aria-hidden
              />
              {l.label}
            </span>
          ))}
        </span>
        <span className="ml-auto min-w-0 truncate">{right}</span>
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}

function StatusDot({ health }: { health: Health }) {
  const color = HEALTH_UI[health].color;
  const pulse = health !== 'down';
  return (
    <span className="relative flex h-2.5 w-2.5 shrink-0">
      {pulse && <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-50" style={{ background: color }} />}
      <span className="relative inline-flex h-2.5 w-2.5 rounded-full" style={{ background: color }} />
    </span>
  );
}

function InstallAgent({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="ml-2 rounded-md bg-sky-50 px-1.5 py-0.5 align-middle text-[10px] font-semibold text-sky-700 transition hover:bg-sky-100"
    >
      Pasang agen
    </button>
  );
}

function PanelMenu({ onAgent, onDelete, name, hasAgent }: { onAgent: () => void; onDelete: () => void; name: string; hasAgent: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-200/60 hover:text-slate-700"
        aria-label="Menu"
      >
        ⋯
      </button>
      {open && (
        <div className="sheet-in absolute right-0 z-20 mt-1 w-56 overflow-hidden rounded-xl bg-white py-1 text-sm shadow-xl ring-1 ring-slate-200">
          <button onClick={() => (setOpen(false), onAgent())} className="block w-full px-3 py-2 text-left text-slate-700 hover:bg-slate-50">
            {hasAgent ? 'Ubah agen CPU & RAM' : 'Pasang agen CPU & RAM'}
          </button>
          <button
            onClick={() => (setOpen(false), confirm(`Hapus database "${name}" dari Dashboard Monitoring System?`) && onDelete())}
            className="block w-full px-3 py-2 text-left text-rose-600 hover:bg-rose-50"
          >
            Hapus database
          </button>
        </div>
      )}
    </div>
  );
}

function SqliteBody({ last }: { last?: MetricPoint }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      <Kpi index={1} label="Ukuran DB" text={fmtBytes(last?.extra?.dbBytes)} color="s1" />
      <Kpi index={2} label="WAL" text={fmtBytes(last?.extra?.walBytes)} color="s1" />
      <Kpi index={3} label="Free pages" value={last?.extra?.freePages} color="s1" />
      <p className="col-span-3 px-1 text-xs text-slate-400">SQLite berbasis file: QPS, koneksi, latency & sesi tidak tersedia dari engine.</p>
    </div>
  );
}

/** Tinggi elemen (diperbarui saat ukuran berubah). */
function useHeight(ref: { current: HTMLElement | null }) {
  const [h, setH] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setH(Math.round(e.contentRect.height)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return h;
}
