import type { CSSProperties, ReactNode } from 'react';
import {
  ENGINE_META,
  STATUS,
  type AbbData,
  type Alert,
  type AlertSnapshot,
  type Connection,
  type ConnStatus,
  type DevicePoint,
  type DeviceUpdate,
  type FortiData,
  type IspData,
  type MetricPoint,
  type MikrotikData,
  type NasData,
  type PbsData,
  type ProxmoxData,
} from '../types';
import { fmtAgo, fmtBytes, fmtDur, fmtNum, fmtUptime } from '../format';
import { useTheme } from '../theme';
import { useMinWidth } from '../hooks/useLayout';
import { HEALTH_UI, healthOf } from './DbPanel';
import { Sparkline } from './Kpi';
import { Dot } from './PanelFrame';

interface Props {
  conns: Connection[];
  status: Record<string, { status: ConnStatus; message?: string }>;
  alerts: Record<string, AlertSnapshot>;
  live: Record<string, MetricPoint[]>;
  devLive: Record<string, DevicePoint[]>;
  devData: Record<string, DeviceUpdate>;
  onOpen: (c: Connection) => void;
}

/**
 * Tab Ringkasan (gaya layar NOC), mengisi satu layar penuh dengan grid 6 kolom:
 *   Baris besar (tinggi 2) : DATABASE · DATABASE · PROXMOX
 *   Baris berikut          : NAS · ACTIVE BACKUP · PROXMOX BACKUP (sejajar)
 *   Lalu                   : FORTIGATE · MIKROTIK (sejajar)
 *   Baris terakhir         : KONEKSI ISP
 * Lebar kartu menyesuaikan jumlahnya agar tiap baris selalu penuh.
 * Kanan: semua alert aktif.
 */
export function Overview({ conns, status, alerts, live, devLive, devData, onOpen }: Props) {
  const wide = useMinWidth(1024);
  const health = (c: Connection) => healthOf(status[c.id]?.status ?? c.status ?? 'connecting', alerts[c.id]);
  const counts = conns.reduce<Record<string, number>>((a, c) => ((a[health(c)] = (a[health(c)] ?? 0) + 1), a), {});
  const active: (Alert & { conn: Connection })[] = conns
    .flatMap((c) => (alerts[c.id]?.active ?? []).map((a) => ({ ...a, conn: c })))
    .sort((a, b) => (a.severity === b.severity ? b.since - a.since : a.severity === 'critical' ? -1 : 1));

  const isDb = (c: Connection) => ['mariadb', 'postgres', 'mssql', 'sqlite'].includes(c.engine);
  const groups = [
    { items: [...conns.filter(isDb), ...conns.filter((c) => c.engine === 'proxmox')], rows: 2 },
    { items: [...conns.filter((c) => c.engine === 'synology'), ...conns.filter((c) => c.engine === 'abb'), ...conns.filter((c) => c.engine === 'pbs')], rows: 1 },
    { items: [...conns.filter((c) => c.engine === 'fortigate'), ...conns.filter((c) => c.engine === 'mikrotik')], rows: 1 },
    { items: conns.filter((c) => c.engine === 'isp'), rows: 1 },
  ].filter((g) => g.items.length);
  // 1 kartu → selebar layar · 2 → setengah · ≥ 3 → sepertiga (6 kolom)
  const span = (n: number) => (n <= 1 ? 6 : n === 2 ? 3 : 2);
  // Baris besar (Database/Proxmox, ada grafik) berbagi sisa tinggi layar; baris kecil setinggi isinya
  const hasBig = groups.some((g) => g.rows > 1);
  const templateRows = groups
    .flatMap((g) =>
      Array.from({ length: Math.ceil(g.items.length / 3) * g.rows }, () =>
        g.rows > 1 || !hasBig ? 'minmax(130px, 1fr)' : 'auto',
      ),
    )
    .join(' ');

  const tile = (c: Connection, n: number, rows: number) => {
    const style: CSSProperties = wide ? { gridColumn: `span ${span(n)}`, gridRow: `span ${rows}` } : {};
    const props = { c, health: health(c), alert: alerts[c.id]?.active[0], status: status[c.id], onOpen, style, big: rows > 1, full: wide && span(n) === 6, narrow: wide && span(n) === 2 };
    if (isDb(c)) return <DbTile key={c.id} {...props} points={live[c.id] ?? []} />;
    const pts = devLive[c.id] ?? [];
    const d = devData[c.id];
    switch (c.engine) {
      case 'proxmox':
        return <ProxmoxTile key={c.id} {...props} points={pts} d={d?.data as ProxmoxData | undefined} />;
      case 'synology':
        return <NasTile key={c.id} {...props} points={pts} d={d?.data as NasData | undefined} />;
      case 'abb':
        return <AbbTile key={c.id} {...props} d={d?.data as AbbData | undefined} />;
      case 'pbs':
        return <PbsTile key={c.id} {...props} points={pts} d={d?.data as PbsData | undefined} />;
      case 'fortigate':
        return <FortiTile key={c.id} {...props} points={pts} d={d?.data as FortiData | undefined} />;
      case 'mikrotik':
        return <MikrotikTile key={c.id} {...props} points={pts} d={d?.data as MikrotikData | undefined} />;
      default:
        return <IspTile key={c.id} {...props} points={pts} d={d?.data as IspData | undefined} />;
    }
  };

  return (
    <div className="grid min-h-0 gap-3 lg:h-full lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.32fr)]">
      <div className="flex min-h-0 min-w-0 flex-col gap-3">
        {/* Ringkasan angka */}
        <div className="grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-5">
          <Big label="Sumber dipantau" value={conns.length} />
          {(['healthy', 'warning', 'critical', 'down'] as const).map((h) => (
            <Big key={h} label={HEALTH_UI[h].label} value={counts[h] ?? 0} color={counts[h] ? HEALTH_UI[h].color : undefined} icon={HEALTH_UI[h].icon} />
          ))}
        </div>

        {/* Grid kartu: mengisi sisa tinggi layar */}
        <div
          className="thin-scroll grid min-h-0 flex-1 gap-3 overflow-y-auto"
          style={
            wide
              ? {
                  gridTemplateColumns: 'repeat(6, minmax(0, 1fr))',
                  gridTemplateRows: templateRows || 'minmax(0, 1fr)',
                }
              : undefined
          }
        >
          {groups.flatMap((g) => g.items.map((c) => tile(c, g.items.length, g.rows)))}
        </div>
      </div>

      {/* Semua alert aktif */}
      <section className="flex min-h-64 min-w-0 flex-col overflow-hidden rounded-2xl bg-white ring-1 ring-slate-200/70 lg:min-h-0">
        <header className="flex shrink-0 items-center justify-between px-4 pt-3 pb-2">
          <h3 className="font-semibold text-slate-900">Alert Aktif</h3>
          <span className="flex gap-1 text-[11px] font-semibold">
            <Chip n={active.filter((a) => a.severity === 'critical').length} cls="bg-rose-600">Kritis</Chip>
            <Chip n={active.filter((a) => a.severity === 'warning').length} cls="bg-amber-500">Waspada</Chip>
          </span>
        </header>
        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {!active.length ? (
            <p className="grid h-full min-h-32 place-items-center text-sm text-slate-400">Semua normal ✓</p>
          ) : (
            <ul className="space-y-1">
              {active.map((a) => (
                <li key={a.id}>
                  <button onClick={() => onOpen(a.conn)} className="row-in flex w-full gap-2.5 rounded-xl px-2.5 py-2 text-left hover:bg-slate-50">
                    <span className="mt-0.5 text-[13px]">{a.severity === 'critical' ? '⛔' : '⚠️'}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-slate-800">{a.title}</span>
                      <span className="block truncate text-[11px] text-slate-500">
                        {a.conn.name} · {a.message} · {fmtAgo(a.since)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

// ───────────────────────── Kartu ─────────────────────────

interface TileProps {
  c: Connection;
  health: ReturnType<typeof healthOf>;
  alert?: Alert;
  status?: { status: ConnStatus; message?: string };
  onOpen: (c: Connection) => void;
  style: CSSProperties;
  big: boolean;
  /** Kartu selebar layar → angka disusun lebih banyak kolom */
  full: boolean;
  /** Kartu sepertiga lebar (3 kartu sejajar) → angka 3 kolom × 2 baris agar tidak berdesakan */
  narrow: boolean;
}

/** Kerangka kartu: judul + status, isi, baris alert teratas */
function Tile({ c, health, alert, status, onOpen, style, narrow, children }: TileProps & { children: ReactNode }) {
  const hu = HEALTH_UI[health];
  const edge = health === 'critical' || health === 'down' || health === 'warning';
  return (
    <button
      onClick={() => onOpen(c)}
      style={{ ...style, boxShadow: edge ? `inset 3px 0 0 ${hu.color}` : undefined }}
      className="card-in kpi flex min-h-0 min-w-0 flex-col gap-2 overflow-hidden rounded-xl bg-white p-3 text-left ring-1 ring-slate-200/70"
    >
      <span className="flex shrink-0 items-center gap-2">
        <Dot color={hu.color} pulse={health !== 'down'} />
        <span className="min-w-0 truncate text-[15px] font-semibold text-slate-900">{c.name}</span>
        <span className={`hidden truncate text-[11px] text-slate-400 ${narrow ? '2xl:inline' : 'xl:inline'}`}>{c.host ?? c.filePath}</span>
        <span className="flex-1" />
        <span className="shrink-0 text-[11px] font-semibold" style={{ color: hu.color }}>
          {hu.label}
        </span>
        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${ENGINE_META[c.engine].color}`}>{ENGINE_META[c.engine].label}</span>
      </span>
      {children}
      <span
        className="shrink-0 truncate text-[11px]"
        style={{ color: alert ? (alert.severity === 'critical' ? STATUS.critical : STATUS.warning) : undefined }}
      >
        {alert ? (
          `${alert.severity === 'critical' ? '⛔' : '⚠️'} ${alert.title}`
        ) : (
          <span className="text-slate-400">{health === 'healthy' ? 'Semua normal' : (status?.message ?? hu.label)}</span>
        )}
      </span>
    </button>
  );
}

type M = { label: string; value: string; tone?: string; dot?: string };

/** Deretan angka; jumlah kolom = jumlah angka per baris */
function Metrics({ items, cols, big }: { items: M[]; cols: number; big?: boolean }) {
  return (
    <span className="grid shrink-0 gap-x-3 gap-y-2" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {items.map((m, i) => (
        <span key={`${i}-${m.label}`} className="min-w-0">
          <span className="flex items-center gap-1 truncate text-[10px] font-medium tracking-wide text-slate-400 uppercase">
            {m.dot && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: m.dot }} />}
            {m.label}
          </span>
          <span className={`tabular block truncate font-semibold text-slate-900 ${big ? 'text-[22px] leading-7' : 'text-[17px] leading-6'}`} style={{ color: m.tone }}>
            {m.value}
          </span>
        </span>
      ))}
    </span>
  );
}

/** Grafik kecil mengisi sisa tinggi kartu */
function Trend({ a, b, max, label }: { a: (number | null)[]; b?: (number | null)[]; max?: number; label: string }) {
  const { palette } = useTheme();
  if (a.length < 2) return <span className="min-h-0 flex-1" />;
  const top = Math.max(max ?? 0, ...a.map((v) => v ?? 0), ...(b ?? []).map((v) => v ?? 0), 1);
  return (
    <span className="relative min-h-6 flex-1" aria-label={label}>
      <span className="absolute inset-0">
        <Sparkline values={a} color={palette.s1} max={top} dot={false} />
      </span>
      {b && (
        <span className="absolute inset-0">
          <Sparkline values={b} color={palette.s2} max={top} dot={false} />
        </span>
      )}
    </span>
  );
}

const pct = (x: number | null | undefined) => (x == null ? '—' : `${Math.round(x)}%`);
const lvl = (x: number | null | undefined, w: number, c: number) => (x == null ? undefined : x >= c ? STATUS.critical : x >= w ? STATUS.warning : undefined);

function DbTile(p: TileProps & { points: MetricPoint[] }) {
  const { palette } = useTheme();
  const l = p.points.at(-1);
  const rwUnit = l?.rwUnit === 'pages' ? ' hal' : '';
  const connPct = l?.totalConnections != null && l.maxConnections ? (l.totalConnections / l.maxConnections) * 100 : null;
  const sp = p.points.slice(-120);
  return (
    <Tile {...p}>
      <Metrics
        big={p.big}
        cols={p.full ? 6 : 4}
        items={[
          { label: 'QPS', value: fmtNum(l?.qps), dot: palette.s1 },
          { label: 'TPS', value: fmtNum(l?.tps), dot: palette.s2 },
          { label: 'R/W', value: l ? `${fmtNum(l.reads)}/${fmtNum(l.writes)}${rwUnit}` : '—' },
          { label: 'Koneksi', value: l ? `${fmtNum(l.totalConnections)}${l.maxConnections ? '/' + fmtNum(l.maxConnections) : ''}` : '—', tone: lvl(connPct, 75, 90) },
          { label: 'CPU', value: l?.host ? pct(l.host.cpuPct) : '—', tone: lvl(l?.host?.cpuPct, 80, 90) },
          { label: 'Memory', value: l?.host ? pct(l.host.memPct) : '—', tone: lvl(l?.host?.memPct, 85, 95) },
          { label: 'Latency', value: l?.latencyAvgMs == null ? '—' : `${Math.round(l.latencyAvgMs)} ms` },
          { label: 'Active', value: fmtNum(l?.activeConnections) },
          { label: 'SEL', value: fmtNum(l?.ops?.select) },
          { label: 'INS', value: fmtNum(l?.ops?.insert) },
          { label: 'UPD', value: fmtNum(l?.ops?.update) },
          { label: 'DEL', value: fmtNum(l?.ops?.delete) },
        ]}
      />
      {p.big && <Trend a={sp.map((x) => x.qps)} b={sp.map((x) => x.tps)} label="Tren QPS dan TPS" />}
    </Tile>
  );
}

function ProxmoxTile(p: TileProps & { points: DevicePoint[]; d?: ProxmoxData }) {
  const v = p.points.at(-1)?.v ?? {};
  const c = p.d?.counts;
  return (
    <Tile {...p}>
      <Metrics
        big={p.big}
        cols={p.full ? 6 : 3}
        items={[
          { label: 'CPU', value: pct(v.cpu), tone: lvl(v.cpu, 80, 90) },
          { label: 'Memory', value: pct(v.mem), tone: lvl(v.mem, 85, 95) },
          { label: 'Storage', value: pct(v.storage), tone: lvl(v.storage, 85, 95) },
          { label: 'VM jalan', value: c ? `${c.vmRunning}/${c.vmTotal}` : '—' },
          { label: 'CT jalan', value: c ? `${c.ctRunning}/${c.ctTotal}` : '—' },
          { label: 'Jaringan', value: v.netIn == null ? '—' : `${fmtBytes((v.netIn ?? 0) + (v.netOut ?? 0))}/s` },
        ]}
      />
      {p.big && <RunningGuests d={p.d} />}
    </Tile>
  );
}

/** Daftar VM & Container yang sedang berjalan (CPU & RAM %), sama seperti di tab Proxmox */
function RunningGuests({ d }: { d?: ProxmoxData }) {
  if (!d) return <span className="grid min-h-0 flex-1 place-items-center text-xs text-slate-400">Memuat…</span>;
  const running = d.guests.filter((g) => g.status === 'running');
  const stopped = d.guests.length - running.length;
  const cols = '2.6rem minmax(0,1fr) 3.4rem minmax(3.5rem,5.5rem) minmax(3.5rem,5.5rem)';
  return (
    <span className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg bg-slate-50 ring-1 ring-slate-200/60">
      <span
        className="grid shrink-0 items-center gap-2 border-b border-slate-200/60 px-2.5 py-1 text-[10px] font-medium tracking-wide text-slate-400 uppercase"
        style={{ gridTemplateColumns: cols }}
      >
        <span>ID</span>
        <span className="truncate">VM & CT berjalan</span>
        <span>Status</span>
        <span className="text-right">CPU</span>
        <span className="text-right">RAM</span>
      </span>
      <span className="thin-scroll block min-h-0 flex-1 overflow-y-auto px-1 py-0.5">
        {!running.length ? (
          <span className="grid h-full place-items-center text-xs text-slate-400">Tidak ada VM/CT yang berjalan</span>
        ) : (
          running.map((g) => (
            <span
              key={g.id}
              className="row-in grid items-center gap-2 rounded-md px-1.5 py-[3px] text-[12px] hover:bg-white"
              style={{ gridTemplateColumns: cols }}
              title={`${g.type} ${g.vmid} · ${g.name}\nNode ${g.node} · uptime ${fmtUptime(g.uptime)}`}
            >
              <span className="tabular text-[11px] text-slate-400">{g.vmid}</span>
              <span className="truncate font-medium text-slate-800">
                {g.name} <span className="text-[10px] font-normal text-slate-400">{g.type}</span>
              </span>
              <span className="inline-flex items-center gap-1 text-[11px] font-medium" style={{ color: STATUS.good }}>
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: STATUS.good }} />
                jalan
              </span>
              <PctBar v={g.cpuPct} warn={80} crit={90} />
              <PctBar v={g.memPct} warn={85} crit={95} />
            </span>
          ))
        )}
      </span>
      {stopped > 0 && (
        <span className="shrink-0 border-t border-slate-200/60 px-2.5 py-1 text-[10px] text-slate-400">
          {stopped} VM/CT tidak berjalan · lihat tab Proxmox
        </span>
      )}
    </span>
  );
}

/** Persentase + bar tipis (warna status bila melewati ambang) */
function PctBar({ v, warn, crit }: { v: number | null; warn: number; crit: number }) {
  const color = lvl(v, warn, crit);
  return (
    <span className="flex min-w-0 items-center justify-end gap-1.5">
      <span className="hidden h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-200/70 xl:block">
        <span
          className="block h-full rounded-full transition-[width] duration-700"
          style={{ width: `${Math.min(100, v ?? 0)}%`, background: color ?? 'var(--color-slate-400)' }}
        />
      </span>
      <span className="tabular shrink-0 text-right font-semibold text-slate-700" style={{ color }}>
        {v == null ? '—' : `${fmtNum(v)}%`}
      </span>
    </span>
  );
}

function NasTile(p: TileProps & { points: DevicePoint[]; d?: NasData }) {
  const v = p.points.at(-1)?.v ?? {};
  const ok = new Set(['normal', 'background', 'initialized', '']);
  const disksOk = p.d?.disks.filter((x) => ok.has(x.status) && (!x.smart || ok.has(x.smart))).length;
  const badVol = p.d?.volumes.some((x) => !ok.has(x.status));
  return (
    <Tile {...p}>
      <Metrics
        cols={p.narrow ? 3 : 6}
        items={[
          { label: 'CPU', value: pct(v.cpu), tone: lvl(v.cpu, 80, 90) },
          { label: 'Memory', value: pct(v.mem), tone: lvl(v.mem, 85, 95) },
          { label: 'Volume', value: pct(v.volume), tone: badVol ? STATUS.critical : lvl(v.volume, 85, 95) },
          { label: 'Suhu disk', value: v.diskTemp == null ? '—' : `${v.diskTemp}°C`, tone: lvl(v.diskTemp, 55, 60) },
          { label: 'Disk sehat', value: p.d ? `${disksOk}/${p.d.disks.length}` : '—', tone: p.d && disksOk! < p.d.disks.length ? STATUS.warning : undefined },
          { label: 'Jaringan', value: v.netRx == null ? '—' : `${fmtBytes((v.netRx ?? 0) + (v.netTx ?? 0))}/s` },
        ]}
      />
    </Tile>
  );
}

function AbbTile(p: TileProps & { d?: AbbData }) {
  const t = p.d?.tasks ?? [];
  const n = (r: string) => t.filter((x) => x.result === r).length;
  return (
    <Tile {...p}>
      <Metrics
        cols={p.narrow ? 3 : 6}
        items={[
          { label: 'Tugas', value: p.d ? String(p.d.total) : '—' },
          { label: 'Sukses', value: p.d ? String(n('success')) : '—', tone: STATUS.good },
          { label: 'Gagal', value: p.d ? String(n('failed')) : '—', tone: n('failed') ? STATUS.critical : undefined },
          { label: 'Sebagian', value: p.d ? String(n('partial')) : '—', tone: n('partial') ? STATUS.warning : undefined },
          { label: 'Berjalan', value: p.d ? String(n('running')) : '—' },
          { label: 'Terakhir', value: p.d?.lastEnd ? fmtAgo(p.d.lastEnd) : '—' },
        ]}
      />
    </Tile>
  );
}

const bps = (rx?: number | null, tx?: number | null) => (rx == null && tx == null ? '—' : `${fmtBytes((rx ?? 0) + (tx ?? 0))}/s`);

/**
 * FortiGate: tiap link ISP tampil sebagai satu angka (latency dari SD-WAN SLA, atau status link),
 * sehingga 2 ISP + CPU/Memory/Sesi/Trafik pas 6 kolom dan tinggi kartu sama dengan NAS/Backup.
 */
function FortiTile(p: TileProps & { points: DevicePoint[]; d?: FortiData }) {
  const v = p.points.at(-1)?.v ?? {};
  const d = p.d;
  const members = [...new Set((d?.sla ?? []).map((s) => s.iface))];
  const alias = (n: string) => d?.wans.find((w) => w.name === n)?.alias || n;
  const links: M[] = members.length
    ? members.map((m) => {
        const rows = d!.sla.filter((s) => s.iface === m);
        const up = rows.find((s) => s.status === 'up');
        const bad = rows.some((s) => s.slaMet === false);
        return { label: alias(m), value: up ? `${Math.round(up.latencyMs ?? 0)} ms` : 'PUTUS', tone: !up ? STATUS.critical : bad ? STATUS.warning : STATUS.good };
      })
    : (d?.wans ?? []).map((w) => ({ label: w.alias || w.name, value: w.link ? 'UP' : 'DOWN', tone: w.link ? STATUS.good : STATUS.critical }));
  return (
    <Tile {...p}>
      <Metrics
        cols={p.narrow ? 3 : 6}
        items={[
          { label: 'CPU', value: pct(v.cpu), tone: lvl(v.cpu, 80, 90) },
          { label: 'Memory', value: pct(v.mem), tone: lvl(v.mem, 80, 90) },
          ...(links.length ? links : [{ label: 'Link WAN', value: '—' }]),
          { label: 'Trafik WAN', value: bps(v.rx, v.tx) },
          threatItem(d) ?? { label: 'Sesi', value: fmtNum(v.sessions) },
        ]}
      />
    </Tile>
  );
}

/** Serangan masuk 24 jam (bila Peta Serangan aktif); merah bila ada yang lolos tidak diblokir */
function threatItem(d?: FortiData): M | null {
  const t = d?.threats;
  if (!t?.ok) return null;
  const inbound = t.totals.filter((r) => r.dir === 'in');
  const n = inbound.reduce((a, r) => a + r.n, 0);
  const leaked = inbound.some((r) => !r.blocked && (r.severity === 'critical' || r.severity === 'high'));
  return { label: 'Serangan 24j', value: fmtNum(n), tone: leaked || t.infected.length ? STATUS.critical : n ? STATUS.warning : undefined };
}

/** MikroTik: tiap default route (ISP) tampil sebagai satu angka: aktif / siaga / putus */
function MikrotikTile(p: TileProps & { points: DevicePoint[]; d?: MikrotikData }) {
  const v = p.points.at(-1)?.v ?? {};
  const d = p.d;
  const routes: M[] = (d?.routes ?? []).map((r) => {
    const itf = d!.interfaces.find((x) => x.name === r.iface);
    const down = itf ? !itf.running : false;
    return {
      label: r.comment || r.iface || r.gateway,
      value: r.active ? 'AKTIF' : down ? 'PUTUS' : 'siaga',
      tone: r.active ? STATUS.good : down ? STATUS.critical : 'var(--color-slate-400)',
    };
  });
  const nwUp = d?.netwatch.filter((x) => x.status === 'up').length ?? 0;
  const nwTotal = d?.netwatch.length ?? 0;
  return (
    <Tile {...p}>
      <Metrics
        cols={p.narrow ? 3 : 6}
        items={[
          { label: 'CPU', value: pct(v.cpu), tone: lvl(v.cpu, 80, 90) },
          { label: 'Memory', value: pct(v.mem), tone: lvl(v.mem, 85, 95) },
          ...(routes.length ? routes : [{ label: 'Jalur ISP', value: d ? 'tidak ada' : '—', tone: d ? STATUS.critical : undefined }]),
          { label: 'Trafik WAN', value: bps(v.rx, v.tx) },
          nwTotal
            ? { label: 'Netwatch', value: `${nwUp}/${nwTotal}`, tone: nwUp < nwTotal ? STATUS.critical : undefined }
            : v.temp != null
              ? { label: 'Suhu', value: `${v.temp}°C`, tone: lvl(v.temp, 70, 80) }
              : { label: 'Klien DHCP', value: fmtNum(d?.dhcpBound) },
        ]}
      />
    </Tile>
  );
}

function PbsTile(p: TileProps & { points: DevicePoint[]; d?: PbsData }) {
  const v = p.points.at(-1)?.v ?? {};
  const c = p.d?.counts;
  return (
    <Tile {...p}>
      <Metrics
        cols={p.narrow ? 3 : 6}
        items={[
          { label: 'Datastore', value: pct(v.datastore), tone: lvl(v.datastore, 85, 95) },
          { label: 'Backup 24j', value: c ? `${c.ok24}/${c.backups24}` : '—', tone: c?.failedOpen ? STATUS.critical : undefined },
          { label: 'Gagal', value: c ? String(c.failedOpen) : '—', tone: c?.failedOpen ? STATUS.critical : undefined },
          { label: 'VM/CT lama', value: c ? String(c.stale) : '—', tone: c?.stale ? STATUS.warning : undefined },
          { label: 'Terakhir', value: p.d?.lastBackup ? fmtAgo(p.d.lastBackup) : '—' },
          { label: 'CPU / RAM', value: v.cpu == null ? '—' : `${Math.round(v.cpu)}/${Math.round(v.mem ?? 0)}%`, tone: lvl(Math.max(v.cpu ?? 0, v.mem ?? 0), 85, 95) },
        ]}
      />
    </Tile>
  );
}

function IspTile(p: TileProps & { points: DevicePoint[]; d?: IspData }) {
  const v = p.points.at(-1)?.v ?? {};
  const d = p.d;
  const m = d?.sla.find((x) => x.key === 'month');
  const sp = p.points.slice(-120);
  return (
    <Tile {...p}>
      <span className="flex min-h-12 flex-1 items-stretch gap-4">
        <span className="min-w-0 flex-[3]">
          <Metrics
            cols={p.narrow ? 3 : 6}
            items={[
              { label: 'Link', value: !d ? '—' : d.down ? 'DOWN' : 'UP', tone: !d ? undefined : d.down ? STATUS.critical : STATUS.good },
              { label: 'Latency', value: v.latency == null ? '—' : `${Math.round(v.latency)} ms` },
              { label: 'Loss', value: d?.lossPct == null ? '—' : `${fmtNum(d.lossPct)}%`, tone: lvl(d?.lossPct, 5, 20) },
              { label: 'SLA bln', value: m?.uptimePct == null ? '—' : `${m.uptimePct.toFixed(2)}%`, tone: m?.uptimePct != null && m.uptimePct < (d?.slaTarget ?? 99.5) ? STATUS.warning : undefined },
              { label: 'Sisa jatah', value: d ? fmtDur(d.budgetLeftMs) : '—' },
              { label: 'Gangguan', value: d ? String(d.incidents.length) : '—', tone: d?.incidents.length ? STATUS.warning : undefined },
            ]}
          />
        </span>
        <span className="flex min-w-0 flex-[2] flex-col">
          <Trend a={sp.map((x) => x.v.latency)} label="Tren latency" />
        </span>
      </span>
    </Tile>
  );
}

function Big({ label, value, color, icon }: { label: string; value: number; color?: string; icon?: string }) {
  return (
    <div className="kpi rounded-xl bg-white px-3 py-1.5 ring-1 ring-slate-200/70">
      <div className="text-[11px] font-medium text-slate-500">
        {icon && <span style={{ color }}>{icon} </span>}
        {label}
      </div>
      <div className="tabular text-[22px] leading-7 font-semibold text-slate-900" style={{ color }}>
        {value}
      </div>
    </div>
  );
}

const Chip = ({ n, cls, children }: { n: number; cls: string; children: string }) => (
  <span className={`rounded-full px-2 ${n ? `${cls} text-onaccent` : 'bg-slate-100 text-slate-400'}`}>
    {children} {n}
  </span>
);
