import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ENGINE_META, type AlertSnapshot, type Connection, type ConnStatus } from '../types';
import { HEALTH_UI, healthOf } from './DbPanel';
import { TabBox, type TabDef } from './Lists';

export interface ListDef extends Omit<TabDef, 'node'> {
  /** embedded = tampil di dalam tab (mode ringkas), tanpa judul kotak */
  render: (embedded: boolean) => ReactNode;
  /** Lebar relatif kolom (fr) di mode normal */
  weight?: number;
}

export interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

interface Props {
  conn: Connection;
  subtitle?: string;
  status?: { status: ConnStatus; message?: string };
  alerts?: AlertSnapshot;
  fill: boolean;
  menu: MenuItem[];
  kpis: ReactNode;
  charts?: ReactNode[];
  lists: ListDef[];
  /** 'charts' = KPI + 2 grafik + daftar · 'list' = KPI + daftar besar (mis. Active Backup) */
  layout?: 'charts' | 'list';
}

/** Kerangka panel perangkat (Proxmox, NAS, Backup, ISP) — tampilan & perilaku sama dengan panel database. */
export function PanelFrame({ conn, subtitle, status, alerts, fill, menu, kpis, charts = [], lists, layout = 'charts' }: Props) {
  const st = status?.status ?? conn.status ?? 'connecting';
  const health = healthOf(st, alerts);
  const hu = HEALTH_UI[health];
  const meta = ENGINE_META[conn.engine];
  const ref = useRef<HTMLElement>(null);
  const height = useHeight(ref);
  // Panel pendek (4 panel di laptop 1366×768) → daftar digabung jadi tab di samping grafik
  const compact = fill && layout === 'charts' && height > 0 && height < 400;
  const cols = lists.map((l) => `${l.weight ?? 1}fr`).join(' ');

  return (
    <article
      ref={ref}
      className={`card-in flex min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-slate-50/70 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_12px_32px_-16px_rgba(15,23,42,0.18)] backdrop-blur ${
        fill ? 'h-full min-h-0 gap-2 p-2.5' : 'gap-3 p-3'
      }`}
    >
      <header className="flex shrink-0 items-center gap-2 px-1">
        <h2 className="min-w-0 truncate text-[15px] font-semibold text-slate-900">{conn.name}</h2>
        {subtitle && <span className="hidden truncate text-xs text-slate-400 sm:inline">{subtitle}</span>}
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${meta.color}`}>{meta.label}</span>
        <span className="flex-1" />
        <span className="flex shrink-0 items-center gap-1.5 text-xs font-semibold" style={{ color: hu.color }} title={status?.message}>
          <Dot color={hu.color} pulse={health !== 'down'} />
          {hu.label}
        </span>
        <Menu items={menu} />
      </header>

      {st === 'error' && status?.message && (
        <p className="shrink-0 truncate rounded-lg bg-rose-50 px-3 py-1.5 text-xs text-rose-700" title={status.message}>
          {status.message}
        </p>
      )}

      <div
        className={
          !fill
            ? 'grid gap-3'
            : layout === 'list' || compact
              ? 'grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-2'
              : 'grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1.15fr)_minmax(0,1fr)] gap-2'
        }
      >
        {kpis}

        {layout === 'charts' && (
          <div className={`grid gap-2 ${compact ? 'min-h-0 grid-cols-[1fr_1fr_0.85fr]' : 'lg:grid-cols-2'} ${fill ? 'min-h-0' : ''}`}>
            {charts}
            {compact && <TabBox tabs={lists.map((l) => ({ ...l, node: l.render(true) }))} />}
          </div>
        )}

        {!compact && (
          <div
            className={`grid gap-2 ${fill ? 'min-h-0' : '[&>*]:h-60'}`}
            style={fill ? { gridTemplateColumns: cols } : undefined}
          >
            {lists.map((l) => (
              <div key={l.key} className="flex min-h-0 min-w-0 [&>*]:flex-1">
                {l.render(false)}
              </div>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

/** Kartu grafik dengan judul & keterangan seri */
export function ChartCard({
  title,
  legend = [],
  right,
  hint,
  fill,
  children,
}: {
  title: ReactNode;
  legend?: { label: string; color: string; bar?: boolean }[];
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
          {legend.map((l) => (
            <span key={l.label} className="flex shrink-0 items-center gap-1 text-[10px] text-slate-500">
              <span className={l.bar ? 'h-2 w-2 rounded-[2px]' : 'h-[3px] w-3 rounded-full'} style={{ background: l.color }} aria-hidden />
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

/** Grid 6 KPI (3 kolom di HP) */
export const KpiRow = ({ children }: { children: ReactNode }) => (
  <div className="grid grid-cols-3 gap-2 lg:grid-cols-6">{children}</div>
);

/** Bar pemakaian tipis (volume, storage) dengan warna status */
export function UsageBar({ pct }: { pct: number | null }) {
  const v = pct ?? 0;
  const color = v >= 95 ? '#dc2626' : v >= 85 ? '#d97706' : 'var(--color-slate-400)';
  return (
    <span className="block h-1.5 w-full overflow-hidden rounded-full bg-slate-100" aria-hidden>
      <span className="block h-full rounded-full transition-[width] duration-700" style={{ width: `${Math.min(100, v)}%`, background: color }} />
    </span>
  );
}

export function Dot({ color, pulse }: { color: string; pulse?: boolean }) {
  return (
    <span className="relative flex h-2.5 w-2.5 shrink-0">
      {pulse && <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-50" style={{ background: color }} />}
      <span className="relative inline-flex h-2.5 w-2.5 rounded-full" style={{ background: color }} />
    </span>
  );
}

function Menu({ items }: { items: MenuItem[] }) {
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
          {items.map((it) => (
            <button
              key={it.label}
              onClick={() => (setOpen(false), it.onClick())}
              className={`block w-full px-3 py-2 text-left ${it.danger ? 'text-rose-600 hover:bg-rose-50' : 'text-slate-700 hover:bg-slate-50'}`}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

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
