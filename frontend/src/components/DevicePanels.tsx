import type { ReactNode } from 'react';
import {
  STATUS,
  type AbbData,
  type AlertSnapshot,
  type BackupResult,
  type Connection,
  type ConnStatus,
  type DevicePoint,
  type FortiData,
  type IspData,
  type MikrotikData,
  type NasData,
  type PbsData,
  type PbsResult,
  type ProxmoxData,
} from '../types';
import { fmtAgo, fmtBytes, fmtDur, fmtMs, fmtNum, fmtRate, fmtUptime, fmtWhen } from '../format';
import { useTheme } from '../theme';
import { Kpi, levelOf } from './Kpi';
import { TimeChart, type SeriesDef } from './TimeChart';
import { Alerts, Box, Empty } from './Lists';
import { ChartCard, Dot, KpiRow, PanelFrame, UsageBar, type ListDef, type MenuItem } from './PanelFrame';

export interface DevicePanelProps<D> {
  conn: Connection;
  /** Deret waktu terbaru (angka KPI & sparkline) */
  live: DevicePoint[];
  /** Titik yang digambar di grafik (live atau rentang waktu) */
  points: DevicePoint[];
  isLive: boolean;
  data?: D;
  status?: { status: ConnStatus; message?: string };
  alerts?: AlertSnapshot;
  fill: boolean;
  menu: MenuItem[];
}

const v = (k: string) => (p: DevicePoint) => p.v?.[k];
const pctFmt = (x: number) => `${Math.round(x)}%`;
const spark = (pts: DevicePoint[], k: string) => pts.slice(-60).map((p) => p.v?.[k] ?? null);
const alertsList = (alerts?: AlertSnapshot): ListDef => {
  const n = alerts?.active.length ?? 0;
  const crit = alerts?.active.some((a) => a.severity === 'critical');
  return { key: 'alerts', label: 'Alert', badge: n, tone: crit ? 'bg-rose-600' : 'bg-amber-500', weight: 0.95, render: (e) => <Alerts snap={alerts} embedded={e} /> };
};

/** Teks status kecil berwarna (running/stopped, normal/degraded, dst.) */
function Pill({ ok, warn, children }: { ok?: boolean; warn?: boolean; children: ReactNode }) {
  const color = ok ? STATUS.good : warn ? STATUS.warning : STATUS.critical;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium" style={{ color }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {children}
    </span>
  );
}

const Row = ({ children, title, cols }: { children: ReactNode; title?: string; cols: string }) => (
  <li className={`row-in grid items-center gap-2 rounded-lg px-2 py-1 text-[12px] hover:bg-slate-50`} style={{ gridTemplateColumns: cols }} title={title}>
    {children}
  </li>
);

// ═══════════════════════ PROXMOX ═══════════════════════

const PVE_RES: SeriesDef[] = [
  { name: 'CPU', type: 'line', color: 's1', value: v('cpu') },
  { name: 'RAM', type: 'line', color: 's2', value: v('mem') },
];
const PVE_NET: SeriesDef[] = [
  { name: 'Masuk', type: 'line', color: 's1', value: v('netIn') },
  { name: 'Keluar', type: 'line', color: 's2', value: v('netOut') },
];

export function ProxmoxPanel({ conn, live, points, isLive, data, status, alerts, fill, menu }: DevicePanelProps<ProxmoxData>) {
  const { palette } = useTheme();
  const last = live.at(-1)?.v ?? {};
  const c = data?.counts;
  const worst = data?.storages[0];
  const running = (data?.guests ?? []).filter((g) => g.status === 'running').length;

  return (
    <PanelFrame
      conn={conn}
      subtitle={`${conn.host}:${conn.port ?? 8006}${data?.nodes.length ? ` · ${data.nodes.length} node` : ''}`}
      status={status}
      alerts={alerts}
      fill={fill}
      menu={menu}
      kpis={
        <KpiRow>
          <Kpi index={1} label="CPU Usage" value={last.cpu} unit="%" spark={spark(live, 'cpu')} sparkMax={100} color="s1" level={levelOf(last.cpu, 80, 90)} hint="Rata-rata semua node (terbobot jumlah core)" />
          <Kpi index={2} label="Memory Usage" value={last.mem} unit="%" spark={spark(live, 'mem')} sparkMax={100} color="s2" dot="s2" level={levelOf(last.mem, 85, 95)} hint={data ? `${fmtBytes(data.memUsed)} dari ${fmtBytes(data.memTotal)}` : undefined} />
          <Kpi index={3} label="Storage" value={last.storage} unit="%" spark={spark(live, 'storage')} sparkMax={100} color="s1" level={levelOf(last.storage, 85, 95)} hint={worst ? `Terpenuh: ${worst.name} (${fmtBytes(worst.used)} / ${fmtBytes(worst.total)})` : undefined} />
          <Kpi index={4} label="VM berjalan" value={c?.vmRunning} suffix={c ? <span className="text-sm font-medium text-slate-400">/{c.vmTotal}</span> : undefined} spark={spark(live, 'vmRunning')} color="s1" />
          <Kpi index={5} label="CT berjalan" value={c?.ctRunning} suffix={c ? <span className="text-sm font-medium text-slate-400">/{c.ctTotal}</span> : undefined} spark={spark(live, 'ctRunning')} color="s1" />
          <Kpi index={6} label="Jaringan" text={fmtBytes((last.netIn ?? 0) + (last.netOut ?? 0))} suffix={<span className="ml-1 text-[11px] font-medium text-slate-400">/dtk</span>} spark={spark(live, 'netIn')} spark2={spark(live, 'netOut')} color="s1" color2="s2" hint={`Masuk ${fmtRate(last.netIn)} · Keluar ${fmtRate(last.netOut)} (rata-rata menit terakhir)`} />
        </KpiRow>
      }
      charts={[
        <ChartCard key="r" fill={fill} title="CPU & RAM" legend={[{ label: 'CPU', color: palette.s1 }, { label: 'RAM', color: palette.s2 }]} right={<span className="text-[11px] text-slate-500">IO wait <b className="text-slate-800">{fmtNum(last.iowait)}%</b></span>}>
          <TimeChart label="Grafik CPU dan RAM Proxmox" series={PVE_RES} points={points} format={pctFmt} live={isLive} yMax={100} />
        </ChartCard>,
        <ChartCard key="n" fill={fill} title="Jaringan" legend={[{ label: 'Masuk', color: palette.s1 }, { label: 'Keluar', color: palette.s2 }]} right={<span className="text-[11px] text-slate-500">Uptime <b className="text-slate-800">{fmtUptime(data?.uptime)}</b></span>}>
          <TimeChart label="Grafik jaringan Proxmox" series={PVE_NET} points={points} format={(x) => fmtRate(x)} live={isLive} />
        </ChartCard>,
      ]}
      lists={[
        {
          key: 'guests',
          label: 'VM & CT',
          badge: data ? data.guests.length - running : 0,
          tone: 'bg-slate-500',
          weight: 1.35,
          render: (e) => (
            <Box title="VM & Container" sub={data ? `${running} berjalan dari ${data.guests.length}` : undefined} embedded={e}>
              {!data ? <Empty text="Memuat…" /> : !data.guests.length ? <Empty text="Tidak ada VM/CT" /> : (
                <ul className="space-y-px">
                  {data.guests.map((g) => (
                    <Row key={g.id} cols="2.6rem minmax(0,1fr) auto 3.2rem 3.2rem" title={`${g.type} ${g.vmid} · ${g.name}\nNode ${g.node} · uptime ${fmtUptime(g.uptime)}`}>
                      <span className="tabular text-[11px] text-slate-400">{g.vmid}</span>
                      <span className="truncate font-medium text-slate-800">{g.name} <span className="text-[10px] font-normal text-slate-400">{g.type}</span></span>
                      <Pill ok={g.status === 'running'} warn={g.status === 'paused'}>{g.status === 'running' ? 'jalan' : g.status === 'stopped' ? 'mati' : g.status}</Pill>
                      <span className="tabular text-right text-slate-600">{g.status === 'running' ? `${fmtNum(g.cpuPct)}%` : '—'}</span>
                      <span className="tabular text-right text-slate-600" title="RAM">{g.status === 'running' ? `${fmtNum(g.memPct)}%` : '—'}</span>
                    </Row>
                  ))}
                </ul>
              )}
            </Box>
          ),
        },
        {
          key: 'storage',
          label: 'Node & Storage',
          weight: 1.1,
          render: (e) => (
            <Box title="Node & Storage" embedded={e}>
              {!data ? <Empty text="Memuat…" /> : (
                <ul className="space-y-px">
                  {data.nodes.map((n) => (
                    <Row key={'n' + n.name} cols="minmax(0,1fr) auto 3.2rem 3.2rem" title={`${n.name} · ${n.version ?? ''}\nUptime ${fmtUptime(n.uptime)} · load ${n.load ?? '—'}`}>
                      <span className="truncate font-medium text-slate-800">🖥 {n.name}</span>
                      <Pill ok={n.status === 'online'}>{n.status}</Pill>
                      <span className="tabular text-right text-slate-600" title="CPU">{fmtNum(n.cpuPct)}%</span>
                      <span className="tabular text-right text-slate-600" title="RAM">{fmtNum(n.memPct)}%</span>
                    </Row>
                  ))}
                  {data.storages.map((s) => (
                    <Row key={'s' + s.node + s.name} cols="minmax(0,1fr) 4.5rem 3rem" title={`${s.name}${s.shared ? ' (shared)' : ` · node ${s.node}`}\n${fmtBytes(s.used)} / ${fmtBytes(s.total)}`}>
                      <span className="truncate text-slate-700">💽 {s.name}</span>
                      <UsageBar pct={s.pct} />
                      <span className="tabular text-right font-semibold text-slate-800">{fmtNum(s.pct)}%</span>
                    </Row>
                  ))}
                </ul>
              )}
            </Box>
          ),
        },
        alertsList(alerts),
      ]}
    />
  );
}

// ═══════════════════════ NAS SYNOLOGY ═══════════════════════

const NAS_RES: SeriesDef[] = [
  { name: 'CPU', type: 'line', color: 's1', value: v('cpu') },
  { name: 'RAM', type: 'line', color: 's2', value: v('mem') },
];
const NAS_NET: SeriesDef[] = [
  { name: 'Download', type: 'line', color: 's1', value: v('netRx') },
  { name: 'Upload', type: 'line', color: 's2', value: v('netTx') },
];
const OK = new Set(['normal', 'background', 'initialized', '']);

export function NasPanel({ conn, live, points, isLive, data, status, alerts, fill, menu }: DevicePanelProps<NasData>) {
  const { palette } = useTheme();
  const last = live.at(-1)?.v ?? {};
  const disksOk = data?.disks.filter((d) => OK.has(d.status) && (!d.smart || OK.has(d.smart))).length;
  const badVol = data?.volumes.filter((x) => !OK.has(x.status)).length ?? 0;

  return (
    <PanelFrame
      conn={conn}
      subtitle={[data?.model, data?.version, `${conn.host}`].filter(Boolean).join(' · ')}
      status={status}
      alerts={alerts}
      fill={fill}
      menu={menu}
      kpis={
        <KpiRow>
          <Kpi index={1} label="CPU Usage" value={last.cpu} unit="%" spark={spark(live, 'cpu')} sparkMax={100} color="s1" level={levelOf(last.cpu, 80, 90)} />
          <Kpi index={2} label="Memory Usage" value={last.mem} unit="%" spark={spark(live, 'mem')} sparkMax={100} color="s2" dot="s2" level={levelOf(last.mem, 85, 95)} hint={data?.memTotal ? `${fmtBytes(data.memUsed)} dari ${fmtBytes(data.memTotal)}` : undefined} />
          <Kpi index={3} label="Volume" value={last.volume} unit="%" spark={spark(live, 'volume')} sparkMax={100} color="s1" level={badVol ? 'critical' : levelOf(last.volume, 85, 95)} hint="Volume yang paling penuh" />
          <Kpi index={4} label="Suhu Disk" value={last.diskTemp} unit="°C" spark={spark(live, 'diskTemp')} color="s1" level={levelOf(last.diskTemp, 55, 60)} hint={data?.sysTemp != null ? `Suhu sistem ${data.sysTemp}°C` : undefined} />
          <Kpi index={5} label="Disk Sehat" value={disksOk} suffix={data ? <span className="text-sm font-medium text-slate-400">/{data.disks.length}</span> : undefined} color="s1" level={data && disksOk! < data.disks.length ? 'warning' : 'ok'} />
          <Kpi index={6} label="Jaringan" text={fmtBytes((last.netRx ?? 0) + (last.netTx ?? 0))} suffix={<span className="ml-1 text-[11px] font-medium text-slate-400">/dtk</span>} spark={spark(live, 'netRx')} spark2={spark(live, 'netTx')} color="s1" color2="s2" hint={`Download ${fmtRate(last.netRx)} · Upload ${fmtRate(last.netTx)}`} />
        </KpiRow>
      }
      charts={[
        <ChartCard key="r" fill={fill} title="CPU & RAM" legend={[{ label: 'CPU', color: palette.s1 }, { label: 'RAM', color: palette.s2 }]} right={<span className="text-[11px] text-slate-500">Uptime <b className="text-slate-800">{fmtUptime(data?.uptime)}</b></span>}>
          <TimeChart label="Grafik CPU dan RAM NAS" series={NAS_RES} points={points} format={pctFmt} live={isLive} yMax={100} />
        </ChartCard>,
        <ChartCard key="n" fill={fill} title="Jaringan" legend={[{ label: 'Download', color: palette.s1 }, { label: 'Upload', color: palette.s2 }]}>
          <TimeChart label="Grafik jaringan NAS" series={NAS_NET} points={points} format={(x) => fmtRate(x)} live={isLive} />
        </ChartCard>,
      ]}
      lists={[
        {
          key: 'vol',
          label: 'Volume',
          badge: badVol,
          tone: 'bg-rose-600',
          weight: 1.1,
          render: (e) => (
            <Box title="Volume & Storage Pool" embedded={e}>
              {!data ? <Empty text="Memuat…" /> : (
                <ul className="space-y-px">
                  {data.volumes.map((x) => (
                    <Row key={x.id} cols="minmax(0,1fr) auto 4.5rem 3rem" title={`${x.name} (${x.fs})\n${fmtBytes(x.used)} / ${fmtBytes(x.total)}`}>
                      <span className="truncate font-medium text-slate-800">{x.name}</span>
                      <Pill ok={OK.has(x.status)} warn={!/crash|degrad|fail/.test(x.status)}>{x.status || 'normal'}</Pill>
                      <UsageBar pct={x.pct} />
                      <span className="tabular text-right font-semibold text-slate-800">{fmtNum(x.pct)}%</span>
                    </Row>
                  ))}
                  {data.pools.map((p) => (
                    <Row key={p.id} cols="minmax(0,1fr) auto">
                      <span className="truncate text-slate-600">Pool {p.id.replace('reuse_', '')} · {p.raid}</span>
                      <Pill ok={OK.has(p.status)} warn={!/crash|degrad|fail/.test(p.status)}>{p.status || 'normal'}</Pill>
                    </Row>
                  ))}
                </ul>
              )}
            </Box>
          ),
        },
        {
          key: 'disk',
          label: 'Disk',
          badge: data ? data.disks.length - (disksOk ?? 0) : 0,
          tone: 'bg-rose-600',
          weight: 1.25,
          render: (e) => (
            <Box title="Disk" embedded={e}>
              {!data ? <Empty text="Memuat…" /> : (
                <ul className="space-y-px">
                  {data.disks.map((d) => {
                    const ok = OK.has(d.status) && (!d.smart || OK.has(d.smart));
                    return (
                      <Row key={d.id} cols="minmax(0,1fr) auto 3rem" title={`${d.name} · ${d.model}\n${fmtBytes(d.size)} · status ${d.status} · S.M.A.R.T. ${d.smart || '-'}`}>
                        <span className="truncate">
                          <span className="font-medium text-slate-800">{d.name}</span> <span className="text-[10px] text-slate-400">{d.model}</span>
                        </span>
                        <Pill ok={ok} warn={!/crash|fail|abnormal/.test(d.status + d.smart)}>{ok ? 'sehat' : d.smart && !OK.has(d.smart) ? d.smart : d.status}</Pill>
                        <span className="tabular text-right font-semibold" style={{ color: (d.temp ?? 0) >= 60 ? STATUS.critical : (d.temp ?? 0) >= 55 ? STATUS.warning : undefined }}>
                          {d.temp != null && d.temp > 0 ? `${d.temp}°` : '—'}
                        </span>
                      </Row>
                    );
                  })}
                </ul>
              )}
            </Box>
          ),
        },
        alertsList(alerts),
      ]}
    />
  );
}

// ═══════════════════════ ACTIVE BACKUP FOR BUSINESS ═══════════════════════

const RESULT_UI: Record<BackupResult, { label: string; color: string; icon: string }> = {
  success: { label: 'Sukses', color: STATUS.good, icon: '✓' },
  partial: { label: 'Sebagian', color: STATUS.warning, icon: '▲' },
  failed: { label: 'Gagal', color: STATUS.critical, icon: '✕' },
  running: { label: 'Berjalan', color: '#2a78d6', icon: '⟳' },
  canceled: { label: 'Dibatalkan', color: '#94a3b8', icon: '–' },
  none: { label: 'Belum pernah', color: '#94a3b8', icon: '·' },
  unknown: { label: 'Tidak diketahui', color: '#94a3b8', icon: '?' },
};

export function AbbPanel({ conn, data, status, alerts, fill, menu }: DevicePanelProps<AbbData>) {
  const t = data?.tasks ?? [];
  const count = (r: BackupResult) => t.filter((x) => x.result === r).length;
  const ok = count('success');
  const failed = count('failed');
  const partial = count('partial');
  const running = count('running');

  return (
    <PanelFrame
      conn={conn}
      subtitle={`${conn.host} · diperbarui tiap menit`}
      status={status}
      alerts={alerts}
      fill={fill}
      menu={menu}
      layout="list"
      kpis={
        <KpiRow>
          <Kpi index={1} label="Total Tugas" value={data?.total} color="s1" hint={data ? `${data.devicesOnline}/${data.devicesTotal} perangkat online` : undefined} />
          <Kpi index={2} label="Sukses" value={data ? ok : null} color="s3" />
          <Kpi index={3} label="Gagal" value={data ? failed : null} color="s1" level={failed ? 'critical' : 'ok'} />
          <Kpi index={4} label="Sebagian" value={data ? partial : null} color="s1" level={partial ? 'warning' : 'ok'} />
          <Kpi index={5} label="Berjalan" value={data ? running : null} color="s1" />
          <Kpi index={6} label="Backup Terakhir" text={data?.lastEnd ? fmtAgo(data.lastEnd) : '—'} color="s1" hint={data ? `Data terkirim 24 jam: ${fmtBytes(data.bytes24h)}` : undefined} />
        </KpiRow>
      }
      lists={[
        {
          key: 'tasks',
          label: 'Tugas',
          weight: 1.9,
          render: (e) => (
            <Box title="Tugas Backup" sub="Urut: gagal → sebagian → berjalan → sukses" embedded={e}>
              {!data ? <Empty text="Memuat…" /> : !t.length ? <Empty text="Belum ada tugas backup" /> : (
                <ul className="space-y-px">
                  <li className="grid grid-cols-[minmax(0,1.4fr)_5.5rem_minmax(0,1fr)_4.6rem_4.2rem] gap-2 px-2 pb-0.5 text-[10px] font-medium tracking-wide text-slate-400 uppercase">
                    <span>Tugas</span>
                    <span>Hasil</span>
                    <span>Terakhir</span>
                    <span className="text-right">Durasi</span>
                    <span className="text-right">Data</span>
                  </li>
                  {t.map((x) => {
                    const ui = RESULT_UI[x.result];
                    const offline = x.devices.filter((d) => !d.online).length;
                    return (
                      <Row
                        key={x.id}
                        cols="minmax(0,1.4fr) 5.5rem minmax(0,1fr) 4.6rem 4.2rem"
                        title={`${x.name} (${x.type})\nPerangkat: ${x.devices.map((d) => `${d.name}${d.online ? '' : ' [offline]'}`).join(', ') || '-'}\nMulai ${fmtWhen(x.start)} · selesai ${fmtWhen(x.end)}\nBerikutnya ${fmtWhen(x.next)}${x.counts ? `\nSukses ${x.counts.ok} · peringatan ${x.counts.warn} · error ${x.counts.err}` : ''}`}
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-slate-800">{x.name}</span>
                          <span className="block truncate text-[10px] text-slate-400">
                            {x.type} · {x.deviceCount} perangkat{offline ? <span style={{ color: STATUS.warning }}> · {offline} offline</span> : null}
                          </span>
                        </span>
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold" style={{ color: ui.color }}>
                          <span className={x.result === 'running' ? 'animate-spin' : ''}>{ui.icon}</span> {ui.label}
                        </span>
                        <span className="truncate text-slate-600" title={fmtWhen(x.end ?? x.start)}>
                          {x.end ? fmtAgo(x.end) : x.start ? `mulai ${fmtAgo(x.start)}` : '—'}
                        </span>
                        <span className="tabular text-right text-slate-600">{fmtMs(x.durationMs)}</span>
                        <span className="tabular text-right text-slate-600">{x.bytes != null ? fmtBytes(x.bytes) : '—'}</span>
                      </Row>
                    );
                  })}
                </ul>
              )}
            </Box>
          ),
        },
        alertsList(alerts),
      ]}
    />
  );
}

// ═══════════════════════ ISP / SLA ═══════════════════════

const ISP_LAT: SeriesDef[] = [{ name: 'Latency', type: 'line', color: 's1', value: v('latency') }];

/** Rentang gangguan untuk arsiran merah di grafik latency */
function outagesOf(d?: IspData): [number, number][] {
  return (d?.incidents ?? []).map((i) => [i.start, i.end ?? Date.now()]);
}

export function IspPanel({ conn, live, points, isLive, data, status, alerts, fill, menu }: DevicePanelProps<IspData>) {
  const { palette } = useTheme();
  const last = live.at(-1)?.v ?? {};
  const month = data?.sla.find((s) => s.key === 'month');
  const target = data?.slaTarget ?? conn.options?.slaTarget ?? 99.5;
  const below = month?.uptimePct != null && month.uptimePct < target;
  const label = data?.provider || conn.options?.provider || '';
  const budgetPct = data && data.budgetMs > 0 ? Math.max(0, (data.budgetLeftMs / data.budgetMs) * 100) : null;
  const inc30 = data?.incidents.length ?? 0;

  return (
    <PanelFrame
      conn={conn}
      subtitle={`${label ? label + ' · ' : ''}${conn.host}${data?.method === 'tcp' ? `:${data.tcpPort}` : ''} · target SLA ${target}%`}
      status={status}
      alerts={alerts}
      fill={fill}
      menu={menu}
      kpis={
        <KpiRow>
          <Kpi
            index={1}
            label="Status Link"
            text={!data ? '—' : data.down ? 'DOWN' : 'UP'}
            color="s1"
            level={data?.down ? 'critical' : 'ok'}
            suffix={data?.down && data.downSince ? <span className="ml-1 text-[11px] font-medium text-slate-400">{fmtAgo(data.downSince).replace(' lalu', '')}</span> : undefined}
            hint={data?.lastError ? `Ping terakhir: ${data.lastError}` : undefined}
          />
          <Kpi index={2} label="Latency" value={last.latency} unit="ms" spark={spark(live, 'latency')} color="s1" level={levelOf(data?.latencyAvg, conn.options?.latencyWarnMs ?? 100, (conn.options?.latencyWarnMs ?? 100) * 2)} hint={data ? `Rata-rata ${fmtNum(data.latencyAvg)} ms · jitter ${fmtNum(data.jitter)} ms (30 ping)` : undefined} />
          <Kpi index={3} label="Packet Loss" value={data?.lossPct} unit="%" spark={spark(live, 'loss')} color="s2" dot="s2" level={levelOf(data?.lossPct, 5, 20)} hint="30 ping terakhir" />
          <Kpi index={4} label="Uptime Bulan Ini" text={month?.uptimePct != null ? `${month.uptimePct.toFixed(2)}` : '—'} unit={month?.uptimePct != null ? '%' : undefined} color="s1" level={below ? 'warning' : 'ok'} hint={month ? `Target ${target}% · terpantau ${fmtNum(month.coveragePct)}% waktu bulan ini` : undefined} />
          <Kpi index={5} label="Sisa Jatah Down" text={data ? fmtDur(data.budgetLeftMs) : '—'} color="s1" level={budgetPct == null ? 'ok' : budgetPct <= 0 ? 'critical' : budgetPct < 25 ? 'warning' : 'ok'} hint={data ? `Jatah downtime bulan ini untuk SLA ${target}%: ${fmtDur(data.budgetMs)} · terpakai ${fmtDur(data.budgetUsedMs)}` : undefined} />
          <Kpi index={6} label="Gangguan 30 Hari" value={data ? inc30 : null} color="s1" level={inc30 ? 'warning' : 'ok'} />
        </KpiRow>
      }
      charts={[
        <ChartCard
          key="lat"
          fill={fill}
          title="Latency"
          legend={[{ label: 'ms', color: palette.s1 }, { label: 'gangguan', color: 'rgba(220,38,38,0.45)', bar: true }]}
          right={<span className="text-[11px] text-slate-500">Ping tiap <b className="text-slate-800">{data?.intervalSec ?? conn.options?.intervalSec ?? 10} dtk</b></span>}
        >
          <TimeChart label="Grafik latency ISP" series={ISP_LAT} points={points} format={(x) => `${Math.round(x)} ms`} live={isLive} outages={outagesOf(data)} />
        </ChartCard>,
        <ChartCard key="sla" fill={fill} title="SLA per Periode" right={<span className="text-[11px] text-slate-500">target <b className="text-slate-800">{target}%</b></span>}>
          <SlaTable data={data} target={target} />
        </ChartCard>,
      ]}
      lists={[
        {
          key: 'inc',
          label: 'Gangguan',
          badge: data?.incidents.filter((i) => i.ongoing).length ?? 0,
          tone: 'bg-rose-600',
          weight: 1.4,
          render: (e) => (
            <Box title="Riwayat Gangguan" sub="30 hari · gangguan = ≥ 3 ping gagal berturut-turut" embedded={e}>
              {!data ? <Empty text="Memuat…" /> : !data.incidents.length ? <Empty text="Tidak ada gangguan 30 hari terakhir ✓" /> : (
                <ul className="space-y-px">
                  {data.incidents.map((i) => (
                    <Row key={i.id} cols="minmax(0,1fr) auto 5rem" title={`Mulai ${fmtWhen(i.start)}${i.end ? ` · pulih ${fmtWhen(i.end)}` : ' · masih berlangsung'}\n${i.reason ?? ''}`}>
                      <span className="truncate text-slate-700">{fmtWhen(i.start)} <span className="text-[10px] text-slate-400">{i.reason}</span></span>
                      {i.ongoing ? <Pill>berlangsung</Pill> : <Pill ok>pulih</Pill>}
                      <span className="tabular text-right font-semibold text-slate-800">{fmtDur(i.durationMs)}</span>
                    </Row>
                  ))}
                </ul>
              )}
            </Box>
          ),
        },
        alertsList(alerts),
      ]}
    />
  );
}

function SlaTable({ data, target }: { data?: IspData; target: number }) {
  if (!data) return <Empty text="Memuat…" />;
  return (
    <div className="thin-scroll h-full overflow-auto px-1">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-[10px] tracking-wide text-slate-400 uppercase">
            <th className="py-1 text-left font-medium">Periode</th>
            <th className="py-1 text-right font-medium">Uptime</th>
            <th className="py-1 text-right font-medium">Down</th>
            <th className="py-1 text-right font-medium">Ggn</th>
            <th className="py-1 text-right font-medium">Loss</th>
            <th className="py-1 text-right font-medium">Lat.</th>
          </tr>
        </thead>
        <tbody>
          {data.sla.map((s) => {
            const below = s.uptimePct != null && s.uptimePct < target;
            return (
              <tr key={s.key} className="border-t border-slate-100" title={`Terpantau ${fmtNum(s.coveragePct)}% dari periode`}>
                <td className="py-1 text-slate-700">{s.label}</td>
                <td className="tabular py-1 text-right font-semibold" style={{ color: s.uptimePct == null ? undefined : below ? STATUS.critical : STATUS.good }}>
                  {s.uptimePct == null ? '—' : `${s.uptimePct.toFixed(s.uptimePct === 100 ? 0 : 3)}%`}
                </td>
                <td className="tabular py-1 text-right text-slate-600">{s.downtimeMs ? fmtDur(s.downtimeMs) : '0'}</td>
                <td className="tabular py-1 text-right text-slate-600">{s.incidents}</td>
                <td className="tabular py-1 text-right text-slate-600">{s.lossPct == null ? '—' : `${fmtNum(s.lossPct)}%`}</td>
                <td className="tabular py-1 text-right text-slate-600">{s.latencyAvg == null ? '—' : `${Math.round(s.latencyAvg)} ms`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ═══════════════════════ FORTIGATE ═══════════════════════

const NET_RES: SeriesDef[] = [
  { name: 'CPU', type: 'line', color: 's1', value: v('cpu') },
  { name: 'Memory', type: 'line', color: 's2', value: v('mem') },
];
const WAN_NET: SeriesDef[] = [
  { name: 'Download', type: 'line', color: 's1', value: v('rx') },
  { name: 'Upload', type: 'line', color: 's2', value: v('tx') },
];
const SLOTS = ['s1', 's2', 's3', 's4'] as const;
const msFmt = (x: number) => `${Math.round(x)} ms`;
const muted = (t: ReactNode) => <span className="ml-1 text-[11px] font-medium text-slate-400">{t}</span>;

/** Nama tampilan interface: alias (port) */
const ifLabel = (name: string, alias?: string) => (alias ? `${alias} (${name})` : name);

export function FortiPanel({ conn, live, points, isLive, data, status, alerts, fill, menu }: DevicePanelProps<FortiData>) {
  const { palette } = useTheme();
  const last = live.at(-1)?.v ?? {};
  const members = [...new Set((data?.sla ?? []).map((s) => s.iface))].slice(0, 4);
  const aliasOf = (n: string) => data?.wans.find((w) => w.name === n)?.alias || data?.interfaces.find((w) => w.name === n)?.alias || '';
  const latSeries: SeriesDef[] = members.map((m, i) => ({ name: ifLabel(m, aliasOf(m)), type: 'line', color: SLOTS[i], value: v(`lat.${m}`) }));
  const wanTotal = members.length || data?.wans.length || 0;
  const wanUp = last.wanUp;
  const tUp = data?.tunnels.filter((t) => t.up).length ?? 0;
  const tTotal = data?.tunnels.length ?? 0;
  const slaRows = data?.sla ?? [];
  const slaBad = slaRows.filter((s) => s.status !== 'up' || s.slaMet === false).length;

  return (
    <PanelFrame
      conn={conn}
      subtitle={[data?.model, data?.version, data?.hostname ?? conn.host].filter(Boolean).join(' · ')}
      status={status}
      alerts={alerts}
      fill={fill}
      menu={menu}
      kpis={
        <KpiRow>
          <Kpi index={1} label="CPU Usage" value={last.cpu} unit="%" spark={spark(live, 'cpu')} sparkMax={100} color="s1" level={levelOf(last.cpu, 80, 90)} />
          <Kpi index={2} label="Memory Usage" value={last.mem} unit="%" spark={spark(live, 'mem')} sparkMax={100} color="s2" dot="s2" level={levelOf(last.mem, 80, 90)} hint="≥ 88% FortiGate bisa masuk conserve mode" />
          <Kpi index={3} label="Sesi Aktif" value={last.sessions} spark={spark(live, 'sessions')} color="s1" />
          <Kpi index={4} label="Link WAN" value={wanUp} suffix={wanTotal ? muted(`/${wanTotal}`) : undefined} color="s1" level={wanUp != null && wanTotal && wanUp < wanTotal ? (wanUp === 0 ? 'critical' : 'warning') : 'ok'} hint={members.length ? 'Anggota SD-WAN yang lolos health-check' : 'Interface WAN yang link-nya hidup'} />
          <Kpi index={5} label="Trafik WAN" text={last.rx == null ? '—' : fmtBytes((last.rx ?? 0) + (last.tx ?? 0))} suffix={muted('/dtk')} spark={spark(live, 'rx')} spark2={spark(live, 'tx')} color="s1" color2="s2" hint={`Download ${fmtRate(last.rx)} · Upload ${fmtRate(last.tx)}`} />
          <Kpi index={6} label="Tunnel VPN" value={data ? tUp : null} suffix={tTotal ? muted(`/${tTotal}`) : undefined} color="s1" level={tTotal && tUp < tTotal ? 'warning' : 'ok'} hint="Tunnel IPsec yang tersambung" />
        </KpiRow>
      }
      charts={[
        members.length ? (
          <ChartCard key={'lat' + members.join()} fill={fill} title="Latency per ISP" legend={latSeries.map((s) => ({ label: s.name, color: palette[s.color] }))} right={<span className="text-[11px] text-slate-500">SD-WAN SLA</span>}>
            <TimeChart key={members.join()} label="Grafik latency per link ISP" series={latSeries} points={points} format={msFmt} live={isLive} />
          </ChartCard>
        ) : (
          <ChartCard key="r" fill={fill} title="CPU & Memory" legend={[{ label: 'CPU', color: palette.s1 }, { label: 'Memory', color: palette.s2 }]} right={<span className="text-[11px] text-slate-500">Uptime <b className="text-slate-800">{fmtUptime(data?.uptime)}</b></span>}>
            <TimeChart label="Grafik CPU dan memory FortiGate" series={NET_RES} points={points} format={pctFmt} live={isLive} yMax={100} />
          </ChartCard>
        ),
        <ChartCard key="n" fill={fill} title="Trafik WAN" legend={[{ label: 'Download', color: palette.s1 }, { label: 'Upload', color: palette.s2 }]} right={<span className="text-[11px] text-slate-500">Sesi <b className="text-slate-800">{fmtNum(last.sessions)}</b></span>}>
          <TimeChart label="Grafik trafik WAN FortiGate" series={WAN_NET} points={points} format={(x) => fmtRate(x)} live={isLive} />
        </ChartCard>,
      ]}
      lists={[
        {
          key: 'sla',
          label: 'Link ISP',
          badge: slaBad,
          tone: 'bg-rose-600',
          weight: 1.4,
          render: (e) => (
            <Box title="Link ISP" sub={slaRows.length ? 'SD-WAN Performance SLA' : 'Interface WAN'} embedded={e}>
              {!data ? <Empty text="Memuat…" /> : slaRows.length ? (
                <ul className="space-y-px">
                  <li className="grid gap-2 px-2 pb-0.5 text-[10px] font-medium tracking-wide text-slate-400 uppercase" style={{ gridTemplateColumns: SLA_COLS }}>
                    <span>Link</span>
                    <span>Status</span>
                    <span className="text-right">Latency</span>
                    <span className="text-right">Jitter</span>
                    <span className="text-right">Loss</span>
                  </li>
                  {slaRows.map((s) => {
                    const up = s.status === 'up';
                    return (
                      <Row key={s.sla + s.iface} cols={SLA_COLS} title={`Health-check ${s.sla} · ${s.iface}${s.since ? `\nStatus berubah ${fmtWhen(s.since)}` : ''}${s.slaMet === false ? '\nTarget SLA tidak terpenuhi' : ''}`}>
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-slate-800">{aliasOf(s.iface) || s.iface}</span>
                          <span className="block truncate text-[10px] text-slate-400">{s.iface} · {s.sla}</span>
                        </span>
                        <Pill ok={up && s.slaMet !== false} warn={up}>{!up ? 'putus' : s.slaMet === false ? 'di bawah SLA' : 'normal'}</Pill>
                        <span className="tabular text-right text-slate-700">{s.latencyMs == null ? '—' : `${fmtNum(s.latencyMs)} ms`}</span>
                        <span className="tabular text-right text-slate-600">{s.jitterMs == null ? '—' : `${fmtNum(s.jitterMs)}`}</span>
                        <span className="tabular text-right text-slate-600" style={{ color: (s.lossPct ?? 0) >= 5 ? STATUS.critical : undefined }}>{s.lossPct == null ? '—' : `${fmtNum(s.lossPct)}%`}</span>
                      </Row>
                    );
                  })}
                </ul>
              ) : (
                <IfaceList rows={data.wans.map((w) => ({ key: w.name, name: ifLabel(w.name, w.alias), sub: w.ip, up: w.link, rx: w.rxBps, tx: w.txBps }))} empty="Tidak ada interface WAN (role wan / SD-WAN)" />
              )}
            </Box>
          ),
        },
        {
          key: 'if',
          label: 'Interface & VPN',
          badge: tTotal - tUp,
          tone: 'bg-amber-500',
          weight: 1.25,
          render: (e) => (
            <Box title="Interface & VPN" embedded={e}>
              {!data ? <Empty text="Memuat…" /> : (
                <>
                  <IfaceList
                    rows={[...data.wans, ...data.interfaces].map((w) => ({ key: w.name, name: ifLabel(w.name, w.alias), sub: [w.wan ? 'WAN' : w.role.toUpperCase(), w.ip].filter(Boolean).join(' · '), up: w.link, rx: w.rxBps, tx: w.txBps }))}
                    empty="Tidak ada interface aktif"
                  />
                  {data.tunnels.length > 0 && (
                    <ul className="mt-1 space-y-px border-t border-slate-100 pt-1">
                      {data.tunnels.map((t) => (
                        <Row key={'t' + t.name} cols="minmax(0,1fr) auto 4.5rem" title={`${t.name} → ${t.remote}\nPhase 2: ${t.up}/${t.total} up\nMasuk ${fmtBytes(t.rxBytes)} · keluar ${fmtBytes(t.txBytes)}`}>
                          <span className="truncate text-slate-700">🔒 {t.name} <span className="text-[10px] text-slate-400">{t.remote}</span></span>
                          <Pill ok={t.up > 0 && t.up === t.total} warn={t.up > 0}>{t.up ? `${t.up}/${t.total} up` : 'putus'}</Pill>
                          <span className="tabular text-right text-[11px] text-slate-500">{fmtBytes((t.rxBytes ?? 0) + (t.txBytes ?? 0))}</span>
                        </Row>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </Box>
          ),
        },
        alertsList(alerts),
      ]}
    />
  );
}

const SLA_COLS = 'minmax(0,1fr) 6.2rem 4rem 2.8rem 3rem';
const IF_COLS = 'minmax(0,1fr) 3.6rem 4.6rem 4.6rem';

/** Daftar interface: nama, status link, download, upload */
function IfaceList({ rows, empty }: { rows: { key: string; name: string; sub?: string; up: boolean; rx: number | null; tx: number | null; tag?: ReactNode }[]; empty: string }) {
  if (!rows.length) return <Empty text={empty} />;
  return (
    <ul className="space-y-px">
      <li className="grid gap-2 px-2 pb-0.5 text-[10px] font-medium tracking-wide text-slate-400 uppercase" style={{ gridTemplateColumns: IF_COLS }}>
        <span>Interface</span>
        <span>Link</span>
        <span className="text-right">↓ Down</span>
        <span className="text-right">↑ Up</span>
      </li>
      {rows.map((r) => (
        <Row key={r.key} cols={IF_COLS} title={`${r.name}${r.sub ? `\n${r.sub}` : ''}`}>
          <span className="min-w-0">
            <span className="block truncate font-medium text-slate-800">{r.name} {r.tag}</span>
            {r.sub && <span className="block truncate text-[10px] text-slate-400">{r.sub}</span>}
          </span>
          <Pill ok={r.up}>{r.up ? 'up' : 'down'}</Pill>
          <span className="tabular text-right text-slate-600">{r.rx == null ? '—' : fmtBytes(r.rx)}</span>
          <span className="tabular text-right text-slate-600">{r.tx == null ? '—' : fmtBytes(r.tx)}</span>
        </Row>
      ))}
    </ul>
  );
}

// ═══════════════════════ MIKROTIK ═══════════════════════

export function MikrotikPanel({ conn, live, points, isLive, data, status, alerts, fill, menu }: DevicePanelProps<MikrotikData>) {
  const { palette } = useTheme();
  const last = live.at(-1)?.v ?? {};
  const active = data?.routes.find((r) => r.active);
  const primary = data?.routes[0];
  const failover = !!(data && data.routes.length > 1 && primary && !primary.active && active);
  const nwUp = data?.netwatch.filter((x) => x.status === 'up').length ?? 0;
  const nwTotal = data?.netwatch.length ?? 0;
  const ifOf = (name: string) => data?.interfaces.find((i) => i.name === name);

  return (
    <PanelFrame
      conn={conn}
      subtitle={[data?.identity, data?.board, data?.version ? `RouterOS ${data.version}` : null, conn.host].filter(Boolean).join(' · ')}
      status={status}
      alerts={alerts}
      fill={fill}
      menu={menu}
      kpis={
        <KpiRow>
          <Kpi index={1} label="CPU Usage" value={last.cpu} unit="%" spark={spark(live, 'cpu')} sparkMax={100} color="s1" level={levelOf(last.cpu, 80, 90)} hint={data?.cpuCount ? `${data.cpuCount} core · ${data.arch ?? ''}` : undefined} />
          <Kpi index={2} label="Memory Usage" value={last.mem} unit="%" spark={spark(live, 'mem')} sparkMax={100} color="s2" dot="s2" level={levelOf(last.mem, 85, 95)} hint={data?.memTotal ? `${fmtBytes(data.memUsed)} dari ${fmtBytes(data.memTotal)}` : undefined} />
          <Kpi index={3} label="Suhu" value={last.temp} unit={last.temp != null ? '°C' : undefined} text={last.temp == null ? '—' : undefined} spark={spark(live, 'temp')} color="s1" level={levelOf(last.temp, 70, 80)} hint={data?.voltage != null ? `Tegangan ${data.voltage} V` : 'Tidak semua model punya sensor suhu'} />
          <Kpi
            index={4}
            label="Jalur Aktif"
            text={!data ? '—' : active ? active.comment || active.iface || active.gateway : 'tidak ada'}
            color="s1"
            level={!data ? 'ok' : !active ? 'critical' : failover ? 'warning' : 'ok'}
            hint={active ? `Default route aktif via ${active.gateway} (${active.iface || '-'}) · distance ${active.distance}${failover ? '\nSedang failover: jalur utama tidak aktif' : ''}` : undefined}
          />
          <Kpi index={5} label="Trafik WAN" text={last.rx == null ? '—' : fmtBytes((last.rx ?? 0) + (last.tx ?? 0))} suffix={muted('/dtk')} spark={spark(live, 'rx')} spark2={spark(live, 'tx')} color="s1" color2="s2" hint={`Download ${fmtRate(last.rx)} · Upload ${fmtRate(last.tx)}`} />
          {nwTotal ? (
            <Kpi index={6} label="Netwatch" value={nwUp} suffix={muted(`/${nwTotal}`)} color="s1" level={nwUp < nwTotal ? 'critical' : 'ok'} hint="Host yang dipantau Tools → Netwatch" />
          ) : (
            <Kpi index={6} label="Klien DHCP" value={data?.dhcpBound ?? null} text={data && data.dhcpBound == null ? '—' : undefined} color="s1" hint="Lease DHCP berstatus bound" />
          )}
        </KpiRow>
      }
      charts={[
        <ChartCard key="r" fill={fill} title="CPU & Memory" legend={[{ label: 'CPU', color: palette.s1 }, { label: 'Memory', color: palette.s2 }]} right={<span className="text-[11px] text-slate-500">Uptime <b className="text-slate-800">{fmtUptime(data?.uptime)}</b></span>}>
          <TimeChart label="Grafik CPU dan memory MikroTik" series={NET_RES} points={points} format={pctFmt} live={isLive} yMax={100} />
        </ChartCard>,
        <ChartCard key="n" fill={fill} title="Trafik WAN" legend={[{ label: 'Download', color: palette.s1 }, { label: 'Upload', color: palette.s2 }]}>
          <TimeChart label="Grafik trafik WAN MikroTik" series={WAN_NET} points={points} format={(x) => fmtRate(x)} live={isLive} />
        </ChartCard>,
      ]}
      lists={[
        {
          key: 'isp',
          label: 'Jalur ISP',
          badge: (data?.routes.filter((r) => !r.active).length ?? 0) + (nwTotal - nwUp),
          tone: failover || nwUp < nwTotal ? 'bg-rose-600' : 'bg-slate-500',
          weight: 1.3,
          render: (e) => (
            <Box title="Jalur ISP & Netwatch" sub="Default route · distance kecil = utama" embedded={e}>
              {!data ? <Empty text="Memuat…" /> : !data.routes.length && !nwTotal ? <Empty text="Tidak ada default route" /> : (
                <ul className="space-y-px">
                  {data.routes.map((r, i) => {
                    const itf = ifOf(r.iface);
                    return (
                      <Row key={'r' + i} cols="minmax(0,1fr) 5.4rem 4.6rem" title={`Gateway ${r.gateway} · ${r.iface || '-'} · distance ${r.distance}${itf ? `\n↓ ${fmtRate(itf.rxBps)} · ↑ ${fmtRate(itf.txBps)}` : ''}`}>
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-slate-800">{r.comment || r.iface || r.gateway}</span>
                          <span className="block truncate text-[10px] text-slate-400">{r.gateway} · {r.iface || '-'} · dist {r.distance}</span>
                        </span>
                        <Pill ok={r.active} warn={!r.active && itf?.running}>{r.active ? (i === 0 ? 'aktif' : 'aktif (cadangan)') : itf && !itf.running ? 'putus' : 'siaga'}</Pill>
                        <span className="tabular text-right text-[11px] text-slate-600">{itf ? fmtBytes((itf.rxBps ?? 0) + (itf.txBps ?? 0)) + '/s' : '—'}</span>
                      </Row>
                    );
                  })}
                  {data.netwatch.map((x) => (
                    <Row key={'w' + x.host} cols="minmax(0,1fr) 5.4rem 4.6rem" title={`Netwatch ${x.host}${x.since ? ` · sejak ${x.since}` : ''}`}>
                      <span className="truncate text-slate-700">📶 {x.comment || x.host} <span className="text-[10px] text-slate-400">{x.comment ? x.host : ''}</span></span>
                      <Pill ok={x.status === 'up'} warn={x.status === 'unknown'}>{x.status}</Pill>
                      <span className="truncate text-right text-[10px] text-slate-400">{x.since}</span>
                    </Row>
                  ))}
                </ul>
              )}
            </Box>
          ),
        },
        {
          key: 'if',
          label: 'Interface',
          weight: 1.2,
          render: (e) => (
            <Box title="Interface" sub={data?.dhcpBound != null ? `${data.dhcpBound} klien DHCP` : undefined} embedded={e}>
              {!data ? <Empty text="Memuat…" /> : (
                <IfaceList
                  rows={data.interfaces.map((i) => ({ key: i.name, name: i.name, sub: [i.wan ? 'WAN' : '', i.type, i.comment].filter(Boolean).join(' · '), up: i.running, rx: i.rxBps, tx: i.txBps }))}
                  empty="Tidak ada interface"
                />
              )}
            </Box>
          ),
        },
        alertsList(alerts),
      ]}
    />
  );
}

// ═══════════════════════ PROXMOX BACKUP SERVER ═══════════════════════

const PBS_UI: Record<PbsResult, { label: string; color: string; icon: string }> = {
  ok: { label: 'OK', color: STATUS.good, icon: '✓' },
  warning: { label: 'Peringatan', color: STATUS.warning, icon: '▲' },
  error: { label: 'Gagal', color: STATUS.critical, icon: '✕' },
  running: { label: 'Berjalan', color: '#2a78d6', icon: '⟳' },
};
const GUEST_ICON: Record<string, string> = { vm: '🖥', ct: '📦', host: '🗄' };

export function PbsPanel({ conn, live, points, isLive, data, status, alerts, fill, menu }: DevicePanelProps<PbsData>) {
  const { palette } = useTheme();
  const last = live.at(-1)?.v ?? {};
  const c = data?.counts;
  const worst = data?.datastores[0];
  const stores = (data?.datastores ?? []).slice(0, 4);
  const dsSeries: SeriesDef[] = stores.map((d, i) => ({ name: d.name, type: 'line', color: SLOTS[i], value: v(`ds.${d.name}`) }));
  const protectedN = c ? c.groups - c.stale : null;

  return (
    <PanelFrame
      conn={conn}
      subtitle={[data?.version ? `PBS ${data.version}` : null, `${conn.host}:${conn.port ?? 8007}`, data ? `${data.datastores.length} datastore` : null].filter(Boolean).join(' · ')}
      status={status}
      alerts={alerts}
      fill={fill}
      menu={menu}
      kpis={
        <KpiRow>
          <Kpi index={1} label="CPU Usage" value={last.cpu} unit="%" spark={spark(live, 'cpu')} sparkMax={100} color="s1" level={levelOf(last.cpu, 80, 90)} hint={data?.load != null ? `Load ${data.load}` : undefined} />
          <Kpi index={2} label="Memory Usage" value={last.mem} unit="%" spark={spark(live, 'mem')} sparkMax={100} color="s2" dot="s2" level={levelOf(last.mem, 85, 95)} hint={data?.memTotal ? `${fmtBytes(data.memUsed)} dari ${fmtBytes(data.memTotal)}` : undefined} />
          <Kpi
            index={3}
            label="Datastore"
            value={last.datastore}
            unit="%"
            spark={spark(live, 'datastore')}
            sparkMax={100}
            color="s1"
            level={levelOf(last.datastore, 85, 95)}
            hint={worst ? `Terpenuh: ${worst.name} (${fmtBytes(worst.used)} / ${fmtBytes(worst.total)})${worst.fullAt ? `\nPerkiraan penuh ${new Date(worst.fullAt).toLocaleDateString('id-ID')}` : ''}` : undefined}
          />
          <Kpi index={4} label="Backup 24 Jam" value={c?.ok24} suffix={c ? muted(`/${c.backups24}`) : undefined} color="s1" level={c?.failedOpen ? 'critical' : 'ok'} hint="Backup sukses / semua backup 24 jam terakhir" />
          <Kpi index={5} label="VM/CT Terlindungi" value={protectedN} suffix={c ? muted(`/${c.groups}`) : undefined} color="s1" level={c?.stale ? 'warning' : 'ok'} hint={data ? `Dibackup dalam ${data.staleHours} jam terakhir` : undefined} />
          <Kpi index={6} label="Backup Terakhir" text={data?.lastBackup ? fmtAgo(data.lastBackup) : '—'} color="s1" hint={c?.running ? `${c.running} tugas sedang berjalan` : undefined} />
        </KpiRow>
      }
      charts={[
        <ChartCard key="r" fill={fill} title="CPU & RAM" legend={[{ label: 'CPU', color: palette.s1 }, { label: 'RAM', color: palette.s2 }]} right={<span className="text-[11px] text-slate-500">Uptime <b className="text-slate-800">{fmtUptime(data?.uptime)}</b></span>}>
          <TimeChart label="Grafik CPU dan RAM Proxmox Backup Server" series={PVE_RES} points={points} format={pctFmt} live={isLive} yMax={100} />
        </ChartCard>,
        <ChartCard key={'ds' + stores.map((d) => d.name).join()} fill={fill} title="Datastore" legend={dsSeries.map((d) => ({ label: d.name, color: palette[d.color] }))} right={<span className="text-[11px] text-slate-500">% terisi</span>}>
          {dsSeries.length ? (
            <TimeChart key={stores.map((d) => d.name).join()} label="Grafik pemakaian datastore" series={dsSeries} points={points} format={pctFmt} live={isLive} yMax={100} />
          ) : (
            <Empty text="Memuat…" />
          )}
        </ChartCard>,
      ]}
      lists={[
        {
          key: 'groups',
          label: 'VM & CT',
          badge: c?.stale ?? 0,
          tone: 'bg-amber-500',
          weight: 1.3,
          render: (e) => (
            <Box title="Backup per VM / CT" sub={data ? `Lama = tidak dibackup > ${data.staleHours} jam` : undefined} embedded={e}>
              {!data ? <Empty text="Memuat…" /> : (
                <ul className="space-y-px">
                  {data.datastores.map((d) => (
                    <Row key={'d' + d.name} cols="minmax(0,1fr) 4.5rem 3rem" title={`${d.name}: ${fmtBytes(d.used)} / ${fmtBytes(d.total)}${d.fullAt ? `\nPerkiraan penuh ${new Date(d.fullAt).toLocaleDateString('id-ID')}` : ''}${d.error ? `\n${d.error}` : ''}`}>
                      <span className="truncate text-slate-700">💽 {d.name}</span>
                      <UsageBar pct={d.pct} />
                      <span className="tabular text-right font-semibold text-slate-800">{fmtNum(d.pct)}%</span>
                    </Row>
                  ))}
                  {!data.groups.length ? (
                    <li className="px-2 py-2 text-[12px] text-slate-400">Belum ada backup</li>
                  ) : (
                    data.groups.map((g) => (
                      <Row key={g.id} cols="minmax(0,1fr) auto 4.6rem 2.4rem" title={`${g.type}/${g.backupId}${g.comment ? ` · ${g.comment}` : ''}\nDatastore ${g.store}\nTerakhir ${fmtWhen(g.last)} · ${g.count ?? '?'} snapshot`}>
                        <span className="truncate">
                          <span className="font-medium text-slate-800">
                            {GUEST_ICON[g.type] ?? '•'} {g.type.toUpperCase()} {g.backupId}
                          </span>{' '}
                          <span className="text-[10px] text-slate-400">{g.comment}</span>
                        </span>
                        <Pill ok={!g.stale} warn>{g.stale ? 'lama' : 'OK'}</Pill>
                        <span className="truncate text-right text-slate-600">{g.last ? fmtAgo(g.last) : '—'}</span>
                        <span className="tabular text-right text-[11px] text-slate-400" title="Jumlah snapshot">{g.count ?? '—'}</span>
                      </Row>
                    ))
                  )}
                </ul>
              )}
            </Box>
          ),
        },
        {
          key: 'tasks',
          label: 'Tugas',
          badge: data?.tasks.filter((t) => t.result === 'error').length ?? 0,
          tone: 'bg-rose-600',
          weight: 1.35,
          render: (e) => (
            <Box title="Tugas 24 Jam" sub="Backup, verifikasi, prune, garbage collection, sinkronisasi" embedded={e}>
              {!data ? <Empty text="Memuat…" /> : !data.tasks.length ? <Empty text="Tidak ada tugas 24 jam terakhir" /> : (
                <ul className="space-y-px">
                  {data.tasks.map((t) => {
                    const ui = PBS_UI[t.result];
                    return (
                      <Row key={t.upid} cols="minmax(0,1fr) 5.4rem 4.2rem 3.6rem" title={`${t.typeLabel} ${t.target}${t.store ? ` · ${t.store}` : ''}\nMulai ${fmtWhen(t.start)}${t.end ? ` · selesai ${fmtWhen(t.end)}` : ''}\n${t.status || 'berjalan'}`}>
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-slate-800">
                            {t.typeLabel} <span className="font-normal text-slate-500">{t.target}</span>
                          </span>
                          {t.result === 'error' && <span className="block truncate text-[10px]" style={{ color: STATUS.critical }}>{t.status}</span>}
                        </span>
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold" style={{ color: ui.color }}>
                          <span className={t.result === 'running' ? 'animate-spin' : ''}>{ui.icon}</span> {ui.label}
                        </span>
                        <span className="truncate text-right text-slate-600">{fmtAgo(t.start)}</span>
                        <span className="tabular text-right text-slate-500">{fmtMs(t.durationMs)}</span>
                      </Row>
                    );
                  })}
                </ul>
              )}
            </Box>
          ),
        },
        alertsList(alerts),
      ]}
    />
  );
}
