import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, EffectScatterChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, MarkAreaComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { useTheme, type SeriesKey } from '../theme';

echarts.use([BarChart, LineChart, EffectScatterChart, GridComponent, TooltipComponent, MarkAreaComponent, CanvasRenderer]);

const reduceMotion =
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export interface SeriesDef {
  name: string;
  type: 'bar' | 'line';
  /** Slot warna palet (s1 biru, s2 oranye, s3 hijau tosca, s4 kuning) — mengikuti tema */
  color: SeriesKey;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: (p: any) => number | null | undefined;
}

interface Props {
  label: string;
  series: SeriesDef[];
  points: { ts: number }[];
  /** Format nilai di sumbu & tooltip, mis. v => `${v} ms` */
  format: (v: number) => string;
  /** Mode live: data bergeser per detik + titik terbaru berdenyut */
  live: boolean;
  /** Batas atas sumbu Y (mis. 100 untuk persen) */
  yMax?: number;
  /** Rentang waktu yang diarsir merah (mis. gangguan ISP) */
  outages?: [number, number][];
}

/**
 * Grafik waktu satu sumbu Y: batang dan/atau garis halus, mengikuti tema terang/gelap.
 * Live  : bergeser mengalir (easing linear ≈ interval polling), titik terbaru berdenyut.
 * Riwayat: transisi lembut saat data diganti.
 */
export function TimeChart({ label, series, points, format, live, yMax, outages }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.EChartsType | null>(null);
  const fmtRef = useRef(format);
  fmtRef.current = format;
  const { theme, palette, chrome } = useTheme();
  const latest = useRef({ points, live, outages });
  latest.current = { points, live, outages };

  // Dibangun ulang saat tema berganti (warna kerangka & seri berubah)
  useEffect(() => {
    const c = echarts.init(el.current!, undefined, { renderer: 'canvas' });
    chart.current = c;
    const lines = series.filter((s) => s.type === 'line');
    const col = (k: SeriesKey) => palette[k];
    c.setOption({
      animation: !reduceMotion,
      animationDuration: 900,
      animationEasing: 'cubicOut',
      grid: { left: 2, right: 10, top: 10, bottom: 2, containLabel: true },
      tooltip: {
        trigger: 'axis',
        confine: true,
        backgroundColor: chrome.tipBg,
        borderColor: chrome.tipBorder,
        borderWidth: 1,
        padding: [8, 12],
        extraCssText: 'border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.18);',
        textStyle: { color: chrome.tipText, fontSize: 12 },
        axisPointer: { type: 'line', lineStyle: { color: chrome.pointer } },
        formatter: (raw: unknown) => {
          const items = (Array.isArray(raw) ? raw : [raw]) as {
            seriesType: string;
            seriesName: string;
            color: string;
            value: [number, number | null];
          }[];
          const rows = items.filter((p) => p.seriesType !== 'effectScatter');
          if (!rows.length) return '';
          const isLive = latest.current.live;
          const time = new Date(rows[0].value[0]).toLocaleString('id-ID', {
            hour: '2-digit',
            minute: '2-digit',
            second: isLive ? '2-digit' : undefined,
            day: isLive ? undefined : '2-digit',
            month: isLive ? undefined : 'short',
          });
          return (
            `<div style="color:${chrome.tipMuted};font-size:11px">${time}</div>` +
            rows
              .map(
                (p) => `<div style="display:flex;align-items:center;gap:8px;margin-top:3px">
                  <span style="width:8px;height:8px;border-radius:2px;background:${p.color}"></span>
                  <span style="color:${chrome.tipMuted};min-width:70px">${p.seriesName}</span>
                  <b style="margin-left:auto;font-variant-numeric:tabular-nums">${
                    p.value[1] == null ? '—' : fmtRef.current(Number(p.value[1]))
                  }</b></div>`,
              )
              .join('')
          );
        },
      },
      xAxis: {
        type: 'time',
        axisLabel: { color: chrome.axis, fontSize: 10, hideOverlap: true },
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: yMax,
        splitNumber: 3,
        axisLabel: { color: chrome.axis, fontSize: 10, formatter: (v: number) => fmtRef.current(v) },
        splitLine: { lineStyle: { color: chrome.grid } },
      },
      series: [
        ...series.map((s, i) =>
          s.type === 'bar'
            ? {
                name: s.name,
                type: 'bar',
                barMaxWidth: 14,
                barCategoryGap: '30%',
                itemStyle: {
                  borderRadius: [4, 4, 0, 0],
                  color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                    { offset: 0, color: col(s.color) + 'e6' },
                    { offset: 1, color: col(s.color) + '73' },
                  ]),
                },
                emphasis: { itemStyle: { color: col(s.color) } },
                data: [],
              }
            : {
                name: s.name,
                type: 'line',
                smooth: 0.4,
                showSymbol: false,
                symbolSize: 8,
                connectNulls: false,
                z: 3,
                lineStyle: {
                  width: 2.2,
                  color: col(s.color),
                  cap: 'round',
                  join: 'round',
                  shadowColor: col(s.color) + '40',
                  shadowBlur: 8,
                  shadowOffsetY: 3,
                },
                itemStyle: { color: col(s.color), borderColor: chrome.ring, borderWidth: 2 },
                areaStyle: {
                  color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                    { offset: 0, color: col(s.color) + (series.length > 1 ? '1a' : '2e') },
                    { offset: 1, color: col(s.color) + '00' },
                  ]),
                },
                // Arsiran gangguan dipasang di seri pertama
                ...(i === 0 ? { markArea: { silent: true, itemStyle: { color: chrome.outage }, data: [] } } : {}),
                data: [],
              },
        ),
        // Titik terbaru tiap garis berdenyut ("live")
        ...lines.map((s) => ({
          name: s.name,
          type: 'effectScatter',
          silent: true,
          symbolSize: 6,
          z: 5,
          rippleEffect: { brushType: 'stroke', scale: 3, period: 2.4 },
          showEffectOn: reduceMotion ? 'emphasis' : 'render',
          itemStyle: { color: col(s.color), borderColor: chrome.ring, borderWidth: 1.5 },
          data: [],
        })),
      ],
    });
    update(c, series, latest.current.points, latest.current.live, latest.current.outages, false);
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(el.current!);
    return () => {
      ro.disconnect();
      c.dispose();
    };
    // Struktur seri tetap selama komponen hidup; dibangun ulang hanya saat tema berganti
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);

  useEffect(() => {
    if (chart.current) update(chart.current, series, points, live, outages, true);
  }, [points, series, live, outages]);

  return <div ref={el} className="h-full min-h-0 w-full" role="img" aria-label={label} />;
}

function update(
  c: echarts.EChartsType,
  series: SeriesDef[],
  points: { ts: number }[],
  live: boolean,
  outages: [number, number][] | undefined,
  animate: boolean,
) {
  const last = points.at(-1);
  const lines = series.filter((s) => s.type === 'line');
  c.setOption({
    // Live: bergeser kontinu; riwayat: transisi lembut
    animationDurationUpdate: animate ? (live ? 1000 : 600) : 0,
    animationEasingUpdate: live ? 'linear' : 'cubicOut',
    series: [
      ...series.map((s, i) => ({
        data: points.map((p) => [p.ts, s.value(p) ?? null]),
        ...(i === 0 && s.type === 'line'
          ? { markArea: { data: (outages ?? []).map(([a, b]) => [{ xAxis: a }, { xAxis: b }]) } }
          : {}),
      })),
      ...lines.map((s) => {
        const v = last ? s.value(last) : null;
        return { data: live && last && v != null ? [[last.ts, v]] : [] };
      }),
    ],
  });
}
