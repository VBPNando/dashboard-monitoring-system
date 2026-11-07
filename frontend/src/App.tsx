import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  CATEGORIES,
  RANGES,
  categoryOf,
  isDevice,
  type AbbData,
  type Category,
  type Connection,
  type DevicePoint,
  type FortiData,
  type FortiThreats,
  type HistoryPoint,
  type IspData,
  type MikrotikData,
  type PbsData,
  type NasData,
  type ProxmoxData,
  type RangeKey,
} from './types';
import { apiFetch, UNAUTHORIZED_EVENT } from './api';
import { useMetrics, useRange } from './hooks/useMetrics';
import { useFullscreen, useMinWidth, wallGrid, WALL_FIT } from './hooks/useLayout';
import { DbPanel, HEALTH_UI, healthOf } from './components/DbPanel';
import { ConnectionForm } from './components/ConnectionForm';
import { AgentDialog } from './components/AgentDialog';
import { RawDialog } from './components/RawDialog';
import { Overview } from './components/Overview';
import { ReportView } from './components/ReportView';
import { ThreatView } from './components/ThreatView';
import { SettingsDialog } from './components/SettingsDialog';
import { AbbPanel, FortiPanel, IspPanel, MikrotikPanel, NasPanel, PbsPanel, ProxmoxPanel, type DevicePanelProps } from './components/DevicePanels';
import { ThemeToggle } from './theme';
import { Login } from './components/Login';

type AuthState = 'checking' | 'in' | 'out';

export default function App() {
  const [auth, setAuth] = useState<AuthState>('checking');

  useEffect(() => {
    const onUnauthorized = () => setAuth('out');
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    apiFetch('/api/me')
      .then((r) => setAuth(r.ok ? 'in' : 'out'))
      .catch(() => setAuth('out'));
    // Layar NOC yang terbuka berhari-hari: sesi "Ingat saya" diperpanjang berkala
    const renew = setInterval(() => void apiFetch('/api/me').catch(() => {}), 6 * 3600_000);
    return () => {
      window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
      clearInterval(renew);
    };
  }, []);

  if (auth === 'checking') {
    return <div className="grid min-h-dvh place-items-center text-slate-500">Memuat…</div>;
  }
  if (auth === 'out') return <Login onSuccess={() => setAuth('in')} />;

  return (
    <Dashboard
      onLogout={async () => {
        await apiFetch('/api/logout', { method: 'POST' }).catch(() => {});
        setAuth('out');
      }}
    />
  );
}

const readPref = <T extends string>(k: string, fallback: T): T => {
  try {
    return (localStorage.getItem(k) as T) || fallback;
  } catch {
    return fallback;
  }
};
const writePref = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* mode privat: abaikan */
  }
};

type Tab = 'overview' | Category | 'report';

function Dashboard({ onLogout }: { onLogout: () => void }) {
  const [conns, setConns] = useState<Connection[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [agentFor, setAgentFor] = useState<Connection | null>(null);
  const [rawFor, setRawFor] = useState<Connection | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [tab, setTab] = useState<Tab>(() => readPref<Tab>('dbmon.tab', 'overview'));
  const [filter, setFilter] = useState<string>('all');
  const [range, setRange] = useState<RangeKey>(() => readPref<RangeKey>('dbmon.range', 'live'));
  /** Tab Firewall: tampilan status perangkat atau Peta Serangan */
  const [fgView, setFgView] = useState<'status' | 'threats'>(() => readPref<'status' | 'threats'>('dbmon.fgView', 'status'));

  const sources = useMemo(() => conns.map((c) => ({ id: c.id, engine: c.engine })), [conns]);
  const { live, devLive, devData, status, details, alerts } = useMetrics(sources);

  useEffect(() => {
    apiFetch('/api/connections')
      .then((r) => (r.ok ? r.json() : []))
      .then(setConns)
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  // Tab yang tersedia: Ringkasan + kategori yang punya sumber
  const cats = CATEGORIES.filter((c) => conns.some((x) => categoryOf(x.engine) === c.key));
  const showOverview = cats.length > 1 || conns.length > 4;
  const tabs: Tab[] = [...(showOverview ? (['overview'] as Tab[]) : []), ...cats.map((c) => c.key), ...(conns.length ? (['report'] as Tab[]) : [])];
  const current: Tab = tabs.includes(tab) ? tab : (tabs[0] ?? 'overview');
  const go = (t: Tab, id = 'all') => {
    setTab(t);
    setFilter(id);
    writePref('dbmon.tab', t);
  };

  const inTab = current === 'overview' || current === 'report' ? [] : conns.filter((c) => categoryOf(c.engine) === current);
  const threatsView = current === 'fortigate' && fgView === 'threats';
  const visible = filter === 'all' ? inTab : inTab.filter((c) => c.id === filter);
  useEffect(() => {
    if (filter !== 'all' && !inTab.some((c) => c.id === filter)) setFilter('all');
  }, [inTab, filter]);

  const rangeData = useRange(
    visible.filter((c) => c.engine !== 'abb').map((c) => c.id),
    range,
  );

  const remove = async (id: string) => {
    await apiFetch(`/api/connections/${id}`, { method: 'DELETE' });
    setConns((cs) => cs.filter((c) => c.id !== id));
  };

  const healthOfConn = (c: Connection) => healthOf(status[c.id]?.status ?? c.status ?? 'connecting', alerts[c.id]);
  const summary = conns.reduce<Record<string, number>>((acc, c) => {
    const h = healthOfConn(c);
    acc[h] = (acc[h] ?? 0) + 1;
    return acc;
  }, {});
  /** Status terburuk per tab (titik warna di tab) */
  const worstIn = (t: Tab) => {
    if (t === 'report') return null;
    const list = t === 'overview' ? conns : conns.filter((c) => categoryOf(c.engine) === t);
    const hs = list.map(healthOfConn);
    return hs.includes('down') || hs.includes('critical') ? 'critical' : hs.includes('warning') ? 'warning' : null;
  };

  // Desktop: panel mengisi layar (1 penuh · 2 berdampingan · 3–4 grid 2×2; > 4 → 2 baris per layar, scroll)
  // HP / layar sempit: panel ditumpuk & bisa di-scroll
  const isDesktop = useMinWidth(1024);
  const wall = isDesktop && current !== 'report' && (current === 'overview' || visible.length > 0);
  const grid = wallGrid(visible.length);
  const fits = visible.length <= WALL_FIT;
  const fs = useFullscreen();

  const select =
    'rounded-xl border border-slate-200 bg-white py-1.5 pr-8 pl-3 text-sm text-slate-700 shadow-sm outline-none transition hover:border-slate-300 focus:border-sky-500 focus:ring-4 focus:ring-sky-500/10';

  const menuFor = (c: Connection) => [
    { label: 'Lihat data mentah', onClick: () => setRawFor(c) },
    { label: 'Hapus dari pemantauan', danger: true, onClick: () => confirm(`Hapus "${c.name}" dari pemantauan?`) && remove(c.id) },
  ];

  const renderPanel = (c: Connection): ReactNode => {
    const isLive = range === 'live';
    if (!isDevice(c.engine)) {
      const lv = live[c.id] ?? [];
      return (
        <DbPanel
          key={c.id}
          conn={c}
          live={lv}
          points={isLive ? lv : ((rangeData[c.id] ?? []) as HistoryPoint[])}
          isLive={isLive}
          status={status[c.id]}
          details={details[c.id]}
          alerts={alerts[c.id]}
          onDelete={remove}
          onAgent={setAgentFor}
          fill={wall}
        />
      );
    }
    const dl = devLive[c.id] ?? [];
    const common: DevicePanelProps<unknown> = {
      conn: c,
      live: dl,
      points: isLive ? dl : ((rangeData[c.id] ?? []) as DevicePoint[]),
      isLive,
      data: devData[c.id]?.data,
      status: status[c.id],
      alerts: alerts[c.id],
      fill: wall,
      menu: menuFor(c),
    };
    switch (c.engine) {
      case 'proxmox':
        return <ProxmoxPanel key={c.id} {...(common as DevicePanelProps<ProxmoxData>)} />;
      case 'synology':
        return <NasPanel key={c.id} {...(common as DevicePanelProps<NasData>)} />;
      case 'pbs':
        return <PbsPanel key={c.id} {...(common as DevicePanelProps<PbsData>)} />;
      case 'abb':
        return <AbbPanel key={c.id} {...(common as DevicePanelProps<AbbData>)} />;
      case 'isp':
        return <IspPanel key={c.id} {...(common as DevicePanelProps<IspData>)} />;
      case 'fortigate':
        return <FortiPanel key={c.id} {...(common as DevicePanelProps<FortiData>)} />;
      case 'mikrotik':
        return <MikrotikPanel key={c.id} {...(common as DevicePanelProps<MikrotikData>)} />;
    }
  };

  const tabLabel = (t: Tab) =>
    t === 'overview' ? { label: 'Ringkasan', icon: '▦' } : t === 'report' ? { label: 'Laporan', icon: '📄' } : CATEGORIES.find((c) => c.key === t)!;

  return (
    <div className={wall ? 'flex h-dvh flex-col overflow-hidden' : 'min-h-dvh'}>
      <header className={`no-print safe-x z-10 shrink-0 border-b border-slate-200/70 bg-white/70 backdrop-blur-md ${wall ? 'pt-2' : 'sticky top-0 pt-3'}`}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="flex items-center gap-2 text-base font-semibold text-slate-900 sm:text-lg">
            <span className="h-2 w-2 rounded-full bg-sky-500" aria-hidden />
            Dashboard Monitoring System
          </h1>
          {conns.length > 0 && (
            <div className="hidden items-center gap-3 border-l border-slate-200 pl-3 text-sm md:flex">
              <span className="text-slate-500">Status:</span>
              {(['healthy', 'warning', 'critical', 'down'] as const)
                .filter((h) => summary[h])
                .map((h) => (
                  <span key={h} className="flex items-center gap-1 font-semibold" style={{ color: HEALTH_UI[h].color }}>
                    {HEALTH_UI[h].icon} {summary[h]} {HEALTH_UI[h].label}
                  </span>
                ))}
            </div>
          )}
          <span className="flex-1" />
          <div className="flex flex-wrap items-center gap-2">
            {current !== 'overview' && inTab.length > 1 && (
              <select className={select} value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Pilih sumber">
                <option value="all">Semua ({inTab.length})</option>
                {inTab.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
            {current === 'fortigate' && (
              <div className="flex rounded-xl bg-slate-100 p-0.5 text-[13px] font-medium" role="tablist" aria-label="Tampilan firewall">
                {(
                  [
                    ['status', '📊 Status'],
                    ['threats', '🛡 Peta Serangan'],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    role="tab"
                    aria-selected={fgView === k}
                    onClick={() => (setFgView(k), writePref('dbmon.fgView', k))}
                    className={`rounded-lg px-3 py-1 transition ${fgView === k ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            {current !== 'overview' && current !== 'report' && !threatsView && !(current === 'abb' && inTab.every((c) => c.engine === 'abb')) && (
              <select
                className={select}
                value={range}
                onChange={(e) => (setRange(e.target.value as RangeKey), writePref('dbmon.range', e.target.value))}
                aria-label="Rentang waktu"
              >
                {RANGES.map((r) => (
                  <option key={r.key} value={r.key}>
                    🕘 {r.key === 'live' && current !== 'database' ? 'Live (30 menit)' : r.label}
                  </option>
                ))}
              </select>
            )}
            <ThemeToggle />
            {fs.supported && (
              <button
                onClick={fs.toggle}
                className="hidden rounded-xl px-3 py-1.5 text-sm text-slate-600 transition hover:bg-slate-100 sm:block"
                title="Sembunyikan tab & address bar browser (Esc untuk keluar)"
              >
                {fs.active ? '⤡ Keluar layar penuh' : '⤢ Layar penuh'}
              </button>
            )}
            {/* Tombol tambah di header hanya untuk layar ≥ sm; di HP pakai FAB di bawah */}
            <button
              onClick={() => setShowForm(true)}
              className="hidden rounded-xl bg-sky-600 px-4 py-1.5 text-sm font-semibold text-onaccent shadow-sm transition hover:bg-sky-700 sm:block"
            >
              + Tambah
            </button>
            <button
              onClick={() => setShowSettings(true)}
              className="grid h-8 w-8 place-items-center rounded-xl text-[16px] text-slate-600 transition hover:bg-slate-100"
              title="Pengaturan: ganti password, ingat login"
              aria-label="Pengaturan"
            >
              ⚙
            </button>
            <button onClick={onLogout} className="rounded-xl px-3 py-1.5 text-sm text-slate-500 transition hover:bg-slate-100">
              Keluar
            </button>
          </div>
        </div>

        {/* Tab kategori */}
        {tabs.length > 1 && (
          <nav className="thin-scroll -mb-px mt-2 flex gap-1 overflow-x-auto" aria-label="Kategori">
            {tabs.map((t) => {
              const { label, icon } = tabLabel(t);
              const n = t === 'overview' ? conns.length : conns.filter((c) => categoryOf(c.engine) === t).length;
              const worst = worstIn(t);
              const on = t === current;
              return (
                <button
                  key={t}
                  onClick={() => go(t)}
                  className={`relative flex shrink-0 items-center gap-1.5 rounded-t-xl border-b-2 px-3 py-1.5 text-sm font-medium transition ${
                    on ? 'border-sky-500 text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-800'
                  }`}
                >
                  <span aria-hidden>{icon}</span>
                  {label}
                  {t !== 'report' && <span className="text-xs text-slate-400">{n}</span>}
                  {worst && (
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ background: worst === 'critical' ? HEALTH_UI.critical.color : HEALTH_UI.warning.color }}
                      title={worst === 'critical' ? 'Ada yang kritis / terputus' : 'Ada peringatan'}
                    />
                  )}
                </button>
              );
            })}
          </nav>
        )}
        {tabs.length <= 1 && <div className="h-2" />}
      </header>

      {loaded && conns.length === 0 ? (
        <div className="mt-20 text-center text-slate-500">
          <p>Belum ada yang dipantau.</p>
          <button onClick={() => setShowForm(true)} className="mt-4 rounded-xl bg-sky-600 px-5 py-3 font-semibold text-onaccent shadow-sm transition hover:bg-sky-700">
            Tambah pemantauan pertama
          </button>
        </div>
      ) : current === 'report' ? (
        <main className="safe-x py-4 pb-28 sm:pb-8 print:p-0">
          <ReportView conns={conns} />
        </main>
      ) : threatsView ? (
        <main
          className={wall ? 'grid min-h-0 flex-1 gap-3 overflow-y-auto p-3' : 'safe-x mx-auto grid max-w-[1600px] gap-4 py-4 pb-28 sm:pb-8'}
          style={wall ? { gridAutoRows: visible.length === 1 ? 'minmax(0, 1fr)' : 'minmax(calc(100dvh - 7rem), auto)' } : undefined}
        >
          {visible.map((c) => (
            <ThreatView
              key={c.id}
              conn={c}
              data={(devData[c.id]?.data as FortiData | undefined)?.threats as FortiThreats | null | undefined}
              alerts={alerts[c.id]?.active ?? []}
              fill={wall && visible.length === 1}
            />
          ))}
        </main>
      ) : current === 'overview' ? (
        <main className={wall ? 'min-h-0 flex-1 p-3' : 'safe-x mx-auto max-w-[1600px] py-4 pb-28 sm:pb-8'}>
          <Overview conns={conns} status={status} alerts={alerts} live={live} devLive={devLive} devData={devData} onOpen={(c) => go(categoryOf(c.engine), c.id)} />
        </main>
      ) : (
        <main
          className={wall ? `grid min-h-0 flex-1 gap-3 p-3 ${fits ? '' : 'overflow-y-auto'}` : 'safe-x mx-auto grid max-w-[1600px] gap-4 py-4 pb-28 sm:pb-8'}
          style={
            wall
              ? {
                  gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))`,
                  // ≤ 4 panel: dibagi rata setinggi layar; lebih dari itu: tiap baris setengah layar
                  ...(fits ? { gridTemplateRows: `repeat(${grid.rows}, minmax(0, 1fr))` } : { gridAutoRows: 'calc((100dvh - 7rem) / 2)' }),
                }
              : undefined
          }
        >
          {visible.map(renderPanel)}
        </main>
      )}

      {/* FAB: mudah dijangkau jempol di HP */}
      <button
        onClick={() => setShowForm(true)}
        aria-label="Tambah pemantauan"
        className="no-print fixed right-5 bottom-[max(1.25rem,env(safe-area-inset-bottom))] z-20 grid h-14 w-14 place-items-center rounded-full bg-sky-600 text-3xl text-onaccent shadow-xl sm:hidden"
      >
        +
      </button>

      {showForm && (
        <ConnectionForm
          initial={current === 'overview' || current === 'database' || current === 'report' ? 'mariadb' : current}
          onClose={() => setShowForm(false)}
          onCreated={(c) => {
            setConns((cs) => [...cs, c]);
            setShowForm(false);
            go(categoryOf(c.engine));
          }}
        />
      )}
      {agentFor && (
        <AgentDialog
          conn={agentFor}
          onClose={() => setAgentFor(null)}
          onSaved={(patch) => setConns((cs) => cs.map((c) => (c.id === agentFor.id ? { ...c, ...patch } : c)))}
        />
      )}
      {rawFor && <RawDialog conn={rawFor} onClose={() => setRawFor(null)} />}
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} onLogout={onLogout} />}
    </div>
  );
}
