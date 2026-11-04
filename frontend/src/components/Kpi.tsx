import type { ReactNode } from 'react';
import { AnimatedNumber } from './AnimatedNumber';
import { STATUS } from '../types';
import { useTheme, type SeriesKey } from '../theme';

/** Sparkline halus (SVG) — ringan, cocok untuk 16+ kotak sekaligus. */
export function Sparkline({ values, color, max, dot = true }: { values: (number | null)[]; color: string; max?: number; dot?: boolean }) {
  const pts = values.map((v) => v ?? 0);
  if (pts.length < 2) return <svg className="h-full w-full" />;
  const W = 100;
  const H = 32;
  const top = Math.max(max ?? 0, ...pts, 1);
  const xy = pts.map((v, i) => [(i / (pts.length - 1)) * W, H - 2 - (v / top) * (H - 6)] as const);
  // Kurva halus (Catmull-Rom → Bezier)
  let d = `M${xy[0][0].toFixed(2)},${xy[0][1].toFixed(2)}`;
  for (let i = 0; i < xy.length - 1; i++) {
    const p0 = xy[i - 1] ?? xy[i];
    const p1 = xy[i];
    const p2 = xy[i + 1];
    const p3 = xy[i + 2] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(2)},${c1[1].toFixed(2)} ${c2[0].toFixed(2)},${c2[1].toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`;
  }
  const id = `sg${color.slice(1)}`;
  const [lx, ly] = xy[xy.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full overflow-visible" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.28" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${d} L${W},${H} L0,${H}Z`} fill={`url(#${id})`} />
      <path d={d} fill="none" stroke={color} strokeWidth="1.8" vectorEffect="non-scaling-stroke" strokeLinecap="round" />
      {dot && <circle cx={lx} cy={ly} r="2.2" fill={color} className="spark-dot" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

type Level = 'ok' | 'warning' | 'critical';

export function levelOf(v: number | null | undefined, warn: number, crit: number): Level {
  if (v == null) return 'ok';
  return v >= crit ? 'critical' : v >= warn ? 'warning' : 'ok';
}

const LEVEL_UI: Record<Exclude<Level, 'ok'>, { label: string; icon: string; color: string; bg: string }> = {
  warning: { label: 'Waspada', icon: '▲', color: STATUS.warning, bg: 'bg-amber-50' },
  critical: { label: 'Kritis', icon: '●', color: STATUS.critical, bg: 'bg-rose-50' },
};

interface KpiProps {
  index: number;
  label: string;
  value?: number | null;
  /** Teks pengganti angka (mis. "—") */
  text?: string;
  unit?: string;
  suffix?: ReactNode;
  spark?: (number | null)[];
  spark2?: (number | null)[];
  /** Slot warna palet (ikut tema) */
  color: SeriesKey;
  color2?: SeriesKey;
  sparkMax?: number;
  level?: Level;
  hint?: string;
  /** Titik warna di label: menautkan kotak ke warna seri di grafik */
  dot?: SeriesKey;
}

/** Kotak KPI: nomor, label, angka besar bergulir, sparkline, penanda status bila melewati ambang. */
export function Kpi({ index, label, value, text, unit, suffix, spark, spark2, color, color2, sparkMax, level = 'ok', hint, dot }: KpiProps) {
  const lv = level !== 'ok' ? LEVEL_UI[level] : null;
  const { palette } = useTheme();
  return (
    <div
      className="kpi relative flex min-w-0 flex-col justify-between overflow-hidden rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200/70"
      title={hint}
    >
      <div className="flex items-center justify-between gap-1">
        <span className="flex min-w-0 items-center gap-1.5 truncate text-[11px] font-medium text-slate-500">
          {dot && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: palette[dot] }} aria-hidden />}
          <span className="truncate">
            {index}. {label}
          </span>
        </span>
        {lv && (
          <span
            className={`flex shrink-0 items-center gap-1 rounded-full px-1.5 text-[10px] font-semibold ${lv.bg}`}
            style={{ color: lv.color }}
          >
            {lv.icon} {lv.label}
          </span>
        )}
      </div>
      <div className="kpi-row flex min-h-0 items-end gap-2">
        <div className="kpi-val tabular shrink-0 text-[22px] leading-7 font-semibold tracking-tight text-slate-900 xl:text-[26px] xl:leading-8">
          {text ?? <AnimatedNumber value={value} />}
          {unit && <span className="ml-0.5 text-sm font-medium text-slate-500">{unit}</span>}
          {suffix}
        </div>
        {spark && (
          <div className="kpi-spark relative mb-1 h-7 min-w-0 flex-1">
            <div className="absolute inset-0">
              <Sparkline values={spark} color={palette[color]} max={sparkMax} />
            </div>
            {spark2 && color2 && (
              <div className="absolute inset-0">
                <Sparkline values={spark2} color={palette[color2]} max={Math.max(sparkMax ?? 0, ...spark.map((v) => v ?? 0))} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
