import { useState, type ReactNode } from 'react';
import type { AlertSnapshot, Details, SessionInfo } from '../types';
import { STATUS } from '../types';
import { fmtAgo, fmtMs, fmtNum, oneLine } from '../format';

/** Saat ditampilkan di dalam tab (mode ringkas), judul kotak disembunyikan karena sudah ada di tab. */
export type Embed = { embedded?: boolean };

export function Box({
  title,
  sub,
  right,
  embedded,
  children,
}: { title: string; sub?: string; right?: ReactNode; children: ReactNode } & Embed) {
  if (embedded) return <div className="thin-scroll h-full min-h-0 overflow-y-auto px-1 pb-1">{children}</div>;
  return (
    <section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl bg-white ring-1 ring-slate-200/70">
      <header className="flex shrink-0 items-baseline justify-between gap-2 px-3 pt-2 pb-1">
        <div className="min-w-0">
          <h3 className="truncate text-[13px] font-semibold text-slate-800">{title}</h3>
          {sub && <p className="truncate text-[10px] text-slate-400">{sub}</p>}
        </div>
        {right}
      </header>
      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-1 pb-1">{children}</div>
    </section>
  );
}

export const Empty = ({ text }: { text: string }) => (
  <p className="grid h-full min-h-10 place-items-center px-2 text-center text-xs text-slate-400">{text}</p>
);

/** Top 5 slow queries */
export function SlowQueries({ details, embedded }: { details?: Details } & Embed) {
  const list = details?.slowQueries ?? [];
  const stats = details?.slowSource === 'stats';
  return (
    <Box
      embedded={embedded}
      title="Top 5 Slow Queries"
      sub={stats ? 'Urut total waktu eksekusi' : details?.slowSource === 'observed' ? 'Urut durasi terlama yang teramati' : undefined}
    >
      {!details ? (
        <Empty text="Memuat…" />
      ) : !list.length ? (
        <Empty text={details.slowSource === 'none' ? 'Tidak tersedia untuk database ini' : 'Belum ada query lambat 👍'} />
      ) : (
        <ol className="space-y-px">
          {list.map((q, i) => (
            <li key={i} className="row-in flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-slate-50" title={q.query}>
              <span className="w-3 shrink-0 text-[11px] font-semibold text-slate-400">{i + 1}</span>
              <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-700">{oneLine(q.query)}</code>
              <span className="shrink-0 text-right">
                <span className="tabular block text-[12px] font-semibold text-slate-900">
                  {fmtMs(stats ? q.totalMs : q.maxMs)}
                </span>
                {stats && q.calls != null && (
                  <span className="tabular block text-[10px] text-slate-400">
                    {fmtNum(q.calls)}× · rata² {fmtMs(q.avgMs)}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Box>
  );
}

const SESSION_UI: Record<SessionInfo['state'], { label: string; color: string }> = {
  running: { label: 'Berjalan', color: STATUS.good },
  waiting: { label: 'Menunggu', color: STATUS.warning },
  blocked: { label: 'Diblok', color: STATUS.critical },
};

/** Sesi aktif & lock */
export function Sessions({ details, embedded }: { details?: Details } & Embed) {
  const list = details?.sessions ?? [];
  const locks = list.filter((s) => s.state !== 'running').length;
  return (
    <Box
      embedded={embedded}
      title="Sesi Aktif & Lock"
      right={
        locks > 0 ? (
          <span className="shrink-0 rounded-full bg-rose-50 px-2 text-[10px] font-semibold" style={{ color: STATUS.critical }}>
            {locks} lock
          </span>
        ) : (
          <span className="shrink-0 text-[10px] text-slate-400">{list.length} sesi</span>
        )
      }
    >
      {!details ? (
        <Empty text="Memuat…" />
      ) : !list.length ? (
        <Empty text="Tidak ada query yang sedang berjalan" />
      ) : (
        <ul className="space-y-px">
          {list.map((s) => {
            const ui = SESSION_UI[s.state];
            return (
              <li
                key={s.id}
                className="row-in grid grid-cols-[3.2rem_1fr_auto] items-center gap-2 rounded-lg px-2 py-1 hover:bg-slate-50"
                title={`Sesi ${s.id} · ${s.user}${s.database ? '@' + s.database : ''}\n${s.query}${s.lock ? '\n' + s.lock : ''}`}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: ui.color }} aria-label={ui.label} />
                  <span className="tabular truncate text-[11px] text-slate-500">{s.id}</span>
                </span>
                <span className="min-w-0">
                  <code className="block truncate font-mono text-[11px] text-slate-700">{oneLine(s.query) || '—'}</code>
                  {s.lock && (
                    <span className="block truncate text-[10px] font-medium" style={{ color: ui.color }}>
                      🔒 {s.lock}
                    </span>
                  )}
                </span>
                <span className="tabular text-right text-[12px] font-semibold text-slate-900">{fmtMs(s.durationMs)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Box>
  );
}

/** Umpan alert */
export function Alerts({ snap, embedded }: { snap?: AlertSnapshot } & Embed) {
  const active = snap?.active ?? [];
  const recent = snap?.recent ?? [];
  const crit = active.filter((a) => a.severity === 'critical').length;
  const warn = active.length - crit;
  return (
    <Box
      embedded={embedded}
      title="Alert"
      right={
        <span className="flex shrink-0 gap-1 text-[10px] font-semibold">
          <span className={`rounded-full px-1.5 ${crit ? 'bg-rose-600 text-onaccent' : 'bg-slate-100 text-slate-400'}`}>Kritis {crit}</span>
          <span className={`rounded-full px-1.5 ${warn ? 'bg-amber-500 text-onaccent' : 'bg-slate-100 text-slate-400'}`}>Waspada {warn}</span>
        </span>
      }
    >
      {!active.length && !recent.length ? (
        <Empty text="Semua normal ✓" />
      ) : (
        <ul className="space-y-px">
          {active.map((a) => (
            <li key={a.id} className="row-in flex gap-2 rounded-lg px-2 py-1 hover:bg-slate-50" title={`${a.title}\n${a.message}`}>
              <span className="mt-0.5 shrink-0 text-[12px]" style={{ color: a.severity === 'critical' ? STATUS.critical : STATUS.warning }}>
                {a.severity === 'critical' ? '⛔' : '⚠️'}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-medium text-slate-800">{a.title}</span>
                <span className="block truncate text-[10px] text-slate-500">
                  {a.message} · {fmtAgo(a.since)}
                </span>
              </span>
            </li>
          ))}
          {recent.slice(0, 5).map((a) => (
            <li key={a.id + 'r'} className="flex gap-2 rounded-lg px-2 py-1 opacity-60" title={`${a.title}\n${a.message}`}>
              <span className="mt-0.5 shrink-0 text-[12px]" style={{ color: STATUS.good }}>
                ✓
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] text-slate-600">{a.title}</span>
                <span className="block truncate text-[10px] text-slate-400">selesai {fmtAgo(a.resolvedAt ?? a.since)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Box>
  );
}

type Tab = 'alerts' | 'sessions' | 'slow';

/**
 * Mode ringkas (panel pendek, mis. laptop 1366×768): tiga daftar digabung dalam satu kotak bertab,
 * supaya grafik tetap mendapat tinggi penuh. Tab Alert otomatis dipilih bila ada alert aktif.
 */
export function TabbedLists({ details, snap }: { details?: Details; snap?: AlertSnapshot }) {
  const [picked, setPicked] = useState<Tab | null>(null);
  const activeAlerts = snap?.active.length ?? 0;
  const crit = snap?.active.some((a) => a.severity === 'critical');
  const locks = details?.sessions.filter((s) => s.state !== 'running').length ?? 0;
  const tab: Tab = picked ?? (activeAlerts ? 'alerts' : 'sessions');
  const tabs: { key: Tab; label: string; badge?: number; tone?: string }[] = [
    { key: 'alerts', label: 'Alert', badge: activeAlerts, tone: crit ? 'bg-rose-600' : 'bg-amber-500' },
    { key: 'sessions', label: 'Sesi', badge: locks, tone: 'bg-rose-600' },
    { key: 'slow', label: 'Slow' },
  ];
  return (
    <section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl bg-white ring-1 ring-slate-200/70">
      <div className="flex shrink-0 gap-1 border-b border-slate-100 px-1.5 pt-1.5" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setPicked(t.key)}
            className={`flex items-center gap-1 rounded-t-lg px-2 py-1 text-[12px] font-semibold whitespace-nowrap transition ${
              tab === t.key ? 'bg-slate-100 text-slate-900' : 'text-slate-400 hover:text-slate-700'
            }`}
          >
            {t.label}
            {!!t.badge && <span className={`rounded-full px-1.5 text-[10px] text-onaccent ${t.tone}`}>{t.badge}</span>}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 pt-1">
        {tab === 'alerts' && <Alerts snap={snap} embedded />}
        {tab === 'sessions' && <Sessions details={details} embedded />}
        {tab === 'slow' && <SlowQueries details={details} embedded />}
      </div>
    </section>
  );
}

export interface TabDef {
  key: string;
  label: string;
  badge?: number;
  /** Kelas warna latar badge, mis. bg-rose-600 */
  tone?: string;
  node: ReactNode;
}

/** Kotak bertab generik (mode ringkas panel perangkat). Tab pertama yang ber-badge dipilih otomatis. */
export function TabBox({ tabs }: { tabs: TabDef[] }) {
  const [picked, setPicked] = useState<string | null>(null);
  const auto = tabs.find((t) => t.key === 'alerts' && t.badge)?.key ?? tabs[0]?.key;
  const tab = tabs.find((t) => t.key === picked) ? picked! : auto;
  return (
    <section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl bg-white ring-1 ring-slate-200/70">
      <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-slate-100 px-1.5 pt-1.5" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setPicked(t.key)}
            className={`flex items-center gap-1 rounded-t-lg px-2 py-1 text-[12px] font-semibold whitespace-nowrap transition ${
              tab === t.key ? 'bg-slate-100 text-slate-900' : 'text-slate-400 hover:text-slate-700'
            }`}
          >
            {t.label}
            {!!t.badge && <span className={`rounded-full px-1.5 text-[10px] text-onaccent ${t.tone ?? 'bg-slate-500'}`}>{t.badge}</span>}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 pt-1">{tabs.find((t) => t.key === tab)?.node}</div>
    </section>
  );
}
